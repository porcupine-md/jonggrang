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

    function runGitTreeList(url, ref) {
        const os = require('os');
        const tmpDir = deps.fs.mkdtempSync(deps.path.join(os.tmpdir(), 'jg-git-tree-'));
        return new Promise((resolve, reject) => {
            const args = ['clone', '--filter=blob:none', '--sparse', '--no-checkout', '--depth=1'];
            if (ref) args.push('--branch', ref);
            args.push(url, tmpDir);
            const child = spawn('git', args, {
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            child.on('error', err => { cleanup(); reject(err); });
            child.on('close', code => {
                if (code !== 0) { cleanup(); return reject(new Error(`git clone failed (exit ${code})`)); }
                const ls = spawn('git', ['ls-tree', '--name-only', '-d', 'HEAD'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
                let stdout = '';
                ls.stdout.on('data', d => { stdout += d.toString(); });
                ls.on('error', err => { cleanup(); reject(err); });
                ls.on('close', lsCode => {
                    cleanup();
                    if (lsCode !== 0) return reject(new Error('git ls-tree failed'));
                    const dirs = stdout.trim().split('\n').filter(d => d && !d.startsWith('.'));
                    resolve(dirs);
                });
            });
            function cleanup() {
                try { deps.fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
            }
            // Timeout after 30s
            setTimeout(() => { try { child.kill(); } catch {} cleanup(); reject(new Error('git-tree timed out')); }, 30000);
        });
    }

    router.post('/projects/git-tree', async (req, res) => {
        const { url, ref } = req.body || {};
        if (!url) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'url required' } });
        try {
            const directories = await runGitTreeList(url, ref);
            res.json({ directories });
        } catch (err) {
            res.status(500).json({ error: { code: 'GIT_TREE_FAILED', message: err.message } });
        }
    });

    function runGitCloneSparse(url, ref, directories, targetPath, onProgress) {
        return new Promise((resolve, reject) => {
            const args = ['clone', '--filter=blob:none', '--sparse', '--progress'];
            if (ref) args.push('--branch', ref);
            args.push(url, targetPath);
            const child = spawn('git', args, {
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let lastStderr = '';
            child.stderr.on('data', d => {
                const msg = d.toString().trim();
                if (msg) { lastStderr = msg; onProgress(msg); }
            });
            child.on('error', reject);
            child.on('close', code => {
                if (code !== 0) return reject(new Error(`git clone --sparse failed (exit ${code}): ${lastStderr}`));
                // Init cone mode + set directories
                onProgress('Configuring sparse checkout...');
                const init = spawn('git', ['sparse-checkout', 'init', '--cone'], { cwd: targetPath, stdio: 'pipe' });
                init.on('error', reject);
                init.on('close', initCode => {
                    if (initCode !== 0) return reject(new Error('git sparse-checkout init failed'));
                    const setArgs = ['sparse-checkout', 'set', ...directories];
                    const set = spawn('git', setArgs, { cwd: targetPath, stdio: 'pipe' });
                    set.on('error', reject);
                    set.on('close', setCode => {
                        if (setCode !== 0) return reject(new Error('git sparse-checkout set failed'));
                        onProgress(`Sparse checkout: ${directories.join(', ')}`);
                        resolve();
                    });
                });
            });
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
                    if (source.sparse?.enabled && Array.isArray(source.sparse.directories) && source.sparse.directories.length > 0) {
                        await runGitCloneSparse(source.url, source.ref, source.sparse.directories, targetPath, msg => emit('clone', msg));
                    } else {
                        await runGitClone(source.url, source.ref, targetPath, msg => emit('clone', msg));
                    }
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

        // Purge on-disk state. The central worktree dir is always removed
        // (jonggrang-internal); the project repo only when delete_files. For a
        // sandbox project these files are root-owned (written by the in-container
        // root user) so plain host fs.rmSync EACCESes — purgeProjectFiles clears
        // them via a throwaway container, then removes the empty dirs.
        try {
            sandbox.purgeProjectFiles(project, { deleteRepo: req.query.delete_files === 'true' });
        } catch (err) {
            console.error('purgeProjectFiles error during project deletion:', err);
        }
        try { sandbox.removeProjectSshKey(project.id); } catch {}

        webState.deleteProject(project.id);
        res.status(204).send();
    });

    return router;
};
