'use strict';

const { Router } = require('express');
const sandbox = require('../../lib/sandbox');
const lib = require('../../lib/jonggrang');

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

    function runGitClone(url, ref, targetPath, onProgress) {
        return new Promise((resolve, reject) => {
            const args = ['clone', '--progress', url, targetPath];
            if (ref) args.push('--branch', ref);
            const child = spawn('git', args, {
                // Non-interactive: never block on a credential or SSH host-key
                // "yes/no" prompt (auto-accepts a new host key, fails fast on no creds).
                env: { ...process.env, ...lib.gitNonInteractiveEnv() },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let lastStderr = '';
            child.stderr.on('data', d => {
                const msg = d.toString().trim();
                if (msg) {
                    lastStderr = msg;
                    onProgress(msg);
                }
            });
            child.on('error', reject);
            child.on('close', code => code === 0 ? resolve() : reject(new Error(`git clone failed (exit ${code}): ${lastStderr}`)));
        });
    }

    function runGitInit(cwd) {
        return new Promise((resolve, reject) => {
            const child = spawn('git', ['init'], { cwd, stdio: 'pipe' });
            child.on('error', reject);
            child.on('close', code => code === 0 ? resolve() : reject(new Error(`git init failed (exit ${code})`)));
        });
    }

    router.post('/projects/import', async (req, res) => {
        const { name, source } = req.body || {};
        if (!name || !source) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name and source required' } });
        }
        if (!['git', 'local', 'fresh'].includes(source.type)) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'source.type must be git|local|fresh' } });
        }

        const path = deps.path;
        const workspacePath = webState.getWorkspacePath();
        fs.mkdirSync(workspacePath, { recursive: true });

        if (webState.listProjects().some(p => p.name === name)) {
            return res.status(409).json({ error: { code: 'NAME_COLLISION', message: `Project "${name}" already exists` } });
        }

        const isReferenceLocal = source.type === 'local' && source.link_mode === 'reference';
        const targetPath = isReferenceLocal
            ? path.resolve(source.path)
            : path.join(workspacePath, name);

        // For non-reference imports we own targetPath. If something is already there,
        // it's leftover from a previous failed/interrupted attempt — wipe it up front
        // so git clone / fresh init won't fail. Fail loudly if we can't.
        if (!isReferenceLocal && fs.existsSync(targetPath)) {
            try {
                fs.rmSync(targetPath, { recursive: true, force: true });
            } catch (err) {
                return res.status(500).json({
                    error: { code: 'CLEANUP_FAILED', message: `Could not clear leftover path ${targetPath}: ${err.message}` },
                });
            }
        }

        const id = webState.generateId('proj');
        const now = new Date().toISOString();
        webState.createProject({
            id,
            name,
            path: targetPath,
            source,
            init_status: 'importing',
            lanes: { main: { id: 'main', path: targetPath, branch: 'main', is_main: true } },
            created_at: now,
            last_opened_at: now,
        });

        res.status(202).json({ id, job_id: id });

        const emit = (phase, message) => io.to(`project:${id}`).emit('import.progress', { project_id: id, phase, message });

        setImmediate(async () => {
            try {
                emit('prepare', 'Preparing project...');

                if (source.type === 'git') {
                    await runGitClone(source.url, source.ref, targetPath, msg => emit('clone', msg));
                } else if (source.type === 'fresh') {
                    fs.mkdirSync(targetPath, { recursive: true });
                    if (source.git_init !== false) await runGitInit(targetPath);
                }

                const detected = webState.detectStack(targetPath);
                webState.updateProject(id, { init_status: 'imported' });
                io.to(`project:${id}`).emit('import.done', { project_id: id, detected });
                startProjectWatcher(webState.getProject(id));
            } catch (err) {
                try { stopProjectWatcher(id); } catch {}
                try { webState.deleteProject(id); } catch {}
                if (!isReferenceLocal) {
                    try { fs.rmSync(targetPath, { recursive: true, force: true }); } catch {}
                }
                io.to(`project:${id}`).emit('import.error', { project_id: id, message: err.message });
            }
        });
    });

    router.delete('/projects/:id', async (req, res) => {
        const id = req.params.id;

        // Always attempt container cleanup first — rm -f stops+removes in one shot
        try { await sandbox.remove(id); } catch (err) {
            console.error('Sandbox remove error during project deletion:', err);
        }

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
