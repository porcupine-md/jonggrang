'use strict';

const { Router } = require('express');
const sandbox = require('../../lib/sandbox');
const tunnel = require('../../lib/tunnel');
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
        if (!['git', 'local', 'fresh', 'device'].includes(source.type)) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'source.type must be git|local|fresh|device' } });
        }
        // A device project's code lives on the developer's machine and is never
        // copied here; the server only needs to know which device and where.
        if (source.type === 'device') {
            if (!source.device_id || !source.path) {
                return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'a device source needs device_id and path' } });
            }
            if (!tunnel.deviceFor(source.device_id)) {
                return res.status(404).json({ error: { code: 'DEVICE_NOT_FOUND', message: `No registered device ${source.device_id}` } });
            }
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
        // The server-side path holds jonggrang's own state (plans, tasks). For a
        // device project the CODE is elsewhere — device.workdir — and execution
        // goes through the tunnel. Two locations on purpose: agent brain here,
        // source of truth on the device.
        const devicePatch = source.type === 'device'
            ? { device: { enabled: true, device_id: source.device_id, workdir: source.path } }
            : {};

        webState.createProject({
            id,
            name,
            path: targetPath,
            source,
            ...devicePatch,
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
                } else if (source.type === 'device') {
                    // Nothing to fetch: the code stays on the device. This
                    // directory only ever holds jonggrang's state for it — plus
                    // the server-side redirect bundle, which sends the agent's
                    // Bash to the device instead of running it here.
                    fs.mkdirSync(targetPath, { recursive: true });
                    emit('prepare', 'Installing the device redirect hook...');
                    tunnel.installDeviceHooks(targetPath, deps.JONGGRANG_HOME);
                    // Point this side's .jonggrang at the device's, so plans and
                    // tasks live with the code they describe. The link may dangle
                    // until the tunnel is up — that reads as "not there yet",
                    // which is true.
                    emit('prepare', 'Linking project state to the device...');
                    try {
                        const device = tunnel.deviceFor(source.device_id);
                        if (device) tunnel.mountDevice(device, source.path);
                    } catch { /* the first spawn will mount it */ }
                    tunnel.linkProjectState({ path: targetPath }, source.path);
                }

                const detected = webState.detectStack(targetPath);
                // A device project needs initialising like any other — just on the
                // device side, where its state lives. Marking it `ready` on import
                // (an earlier shortcut of mine) skipped that, and the planner then
                // refused with "Project not initialized" against an empty
                // directory. `imported` is the truth; Initialize runs in the mount.
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
