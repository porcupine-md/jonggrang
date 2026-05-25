'use strict';

const { Router } = require('express');
const sandbox = require('../../lib/sandbox');

module.exports = function(deps) {
    const { io, fs, webState, stopProjectWatcher, startProjectWatcher } = deps;
    const { spawn } = require('child_process');
    const router = Router();

    router.get('/projects', (req, res) => {
        try {
            const projects = webState.listProjects().map(p => ({
                ...p,
                derived_state: webState.deriveState(p.path),
            }));
            res.json({ projects });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/projects/:id', (req, res) => {
        try {
            const project = webState.getProject(req.params.id);
            if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
            res.json({ ...project, derived_state: webState.deriveState(project.path) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/projects/import', async (req, res) => {
        const { name, source } = req.body || {};
        if (!name || !source) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name and source required' } });
        if (!['git', 'local', 'fresh'].includes(source.type)) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'source.type must be git|local|fresh' } });
        }

        const workspacePath = webState.getWorkspacePath();
        try { fs.mkdirSync(workspacePath, { recursive: true }); } catch {}

        const existing = webState.listProjects().find(p => p.name === name);
        if (existing) return res.status(409).json({ error: { code: 'NAME_COLLISION', message: `Project "${name}" already exists` } });

        const path = deps.path;
        const id = webState.generateId('proj');
        const targetPath = source.type === 'local' && source.link_mode === 'reference'
            ? path.resolve(source.path)
            : path.join(workspacePath, name);

        const record = {
            id,
            name,
            path: targetPath,
            source,
            init_status: 'importing',
            lanes: { main: { id: 'main', path: targetPath, branch: 'main', is_main: true } },
            created_at: new Date().toISOString(),
            last_opened_at: new Date().toISOString(),
        };
        webState.createProject(record);

        res.status(202).json({ id, job_id: id });

        setImmediate(async () => {
            try {
                io.to(`project:${id}`).emit('import.progress', { project_id: id, phase: 'prepare', message: 'Preparing project...' });

                if (source.type === 'git') {
                    // Remove leftover directory from a previous failed clone so git doesn't reject the target
                    if (fs.existsSync(targetPath)) {
                        await new Promise((res2, rej) => {
                            const rm = spawn('rm', ['-rf', targetPath], { stdio: 'pipe' });
                            rm.on('close', c => c === 0 ? res2() : rej(new Error(`Failed to remove existing directory: ${targetPath}`)));
                        });
                    }
                    const gitArgs = ['clone', '--progress', source.url, targetPath];
                    if (source.ref) gitArgs.push('--branch', source.ref);
                    const child = spawn('git', gitArgs, {
                        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                        stdio: ['pipe', 'pipe', 'pipe'],
                    });
                    await new Promise((resolve, reject) => {
                        let lastStderr = '';
                        child.stderr.on('data', d => {
                            const msg = d.toString().trim();
                            lastStderr = msg;
                            io.to(`project:${id}`).emit('import.progress', { project_id: id, phase: 'clone', message: msg });
                        });
                        child.on('close', code => code === 0 ? resolve() : reject(new Error(lastStderr || `git clone failed (${code})`)));
                    });
                } else if (source.type === 'fresh') {
                    fs.mkdirSync(targetPath, { recursive: true });
                    if (source.git_init !== false) {
                        await new Promise((res2, rej) => {
                            const g = spawn('git', ['init'], { cwd: targetPath, stdio: 'pipe' });
                            g.on('close', c => c === 0 ? res2() : rej(new Error('git init failed')));
                        });
                    }
                }

                const detected = webState.detectStack(targetPath);
                webState.updateProject(id, { init_status: 'imported' });
                io.to(`project:${id}`).emit('import.done', { project_id: id, detected });
                startProjectWatcher(webState.getProject(id));
            } catch (err) {
                // Remove the project record — don't leave failed imports as zombie entries
                try { stopProjectWatcher(id); } catch {}
                try { webState.deleteProject(id); } catch {}
                // Clean up any partial files created during the attempt
                if (source.type !== 'local') {
                    try { fs.rmSync(targetPath, { recursive: true, force: true }); } catch {}
                }
                io.to(`project:${id}`).emit('import.error', { project_id: id, message: err.message });
            }
        });
    });

    router.delete('/projects/:id', async (req, res) => {
        const id = req.params.id;

        // Always attempt container cleanup first — rm -f stops+removes in one shot
        try { await sandbox.remove(id); } catch {}

        const project = webState.getProject(id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        stopProjectWatcher(project.id);
        webState.deleteProject(project.id);

        if (req.query.delete_files === 'true') {
            try { fs.rmSync(project.path, { recursive: true, force: true }); } catch {}
        }
        res.status(204).send();
    });

    return router;
};
