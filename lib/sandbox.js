'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Default agent image is pinned to this jonggrang version — the release CI tags
// the agent image with the same version (git tag v<version>). So a released
// jonggrang always pulls the matching agent image: <image>:<release tag>.
const AGENT_IMAGE_REPO = 'ghcr.io/porcupine-md/jonggrang-agent';
const DEFAULT_AGENT_IMAGE = `${AGENT_IMAGE_REPO}:${require('../package.json').version}`;

function getContainerName(projectId) {
    return `jonggrang-${projectId}`;
}

// In-container port openvscode-server listens on (Full editor mode). Published
// to a random loopback host port; read back via getEditorHostPort().
const EDITOR_CONTAINER_PORT = 8842;

// Resolve the published host port for the container's editor port (or null).
function getEditorHostPort(projectId) {
    return new Promise((resolve) => {
        const proc = spawn('docker', ['port', getContainerName(projectId), `${EDITOR_CONTAINER_PORT}/tcp`]);
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.stderr.on('data', () => {});
        proc.on('close', () => {
            const m = out.trim().match(/:(\d+)\s*$/m);
            resolve(m ? parseInt(m[1], 10) : null);
        });
        proc.on('error', () => resolve(null));
    });
}

// Resolve the SSH private key to mount into the sandbox for git push, in order:
//   1. per-project  ~/.jonggrang/web/ssh/<project_id>.key   (custom)
//   2. global       ~/.jonggrang/web/ssh/global.key          (custom)
//   3. default      ~/.ssh/id_rsa                            (host's own key)
// Returns the host key path, or null if none exist.
function resolveProjectSshKey(projectId) {
    const home = os.homedir();
    const candidates = [
        path.join(home, '.jonggrang', 'web', 'ssh', `${projectId}.key`),
        path.join(home, '.jonggrang', 'web', 'ssh', 'global.key'),
        path.join(home, '.ssh', 'id_rsa'),
    ];
    for (const c of candidates) {
        try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
    }
    return null;
}

// Where the resolved key is mounted (read-only) inside the container. The push
// step copies it to a root-owned 0600 file before use (avoids ssh "bad owner").
const SSH_KEY_MOUNT = '/jonggrang/ssh-key';

// The per-project custom key file path (highest precedence in resolveProjectSshKey).
function projectSshKeyPath(projectId) {
    return path.join(os.homedir(), '.jonggrang', 'web', 'ssh', `${projectId}.key`);
}

function sshKeyFingerprint(keyPath) {
    try {
        const { execFileSync } = require('child_process');
        return execFileSync('ssh-keygen', ['-lf', keyPath], { encoding: 'utf8' }).trim();
    } catch { return ''; }
}

// Which key would be used for this project, without exposing the key itself.
function sshKeyStatus(projectId) {
    const home = os.homedir();
    const projectPath = projectSshKeyPath(projectId);
    const globalPath = path.join(home, '.jonggrang', 'web', 'ssh', 'global.key');
    const defaultPath = path.join(home, '.ssh', 'id_rsa');
    let source = 'none', activePath = null;
    if (fs.existsSync(projectPath)) { source = 'project'; activePath = projectPath; }
    else if (fs.existsSync(globalPath)) { source = 'global'; activePath = globalPath; }
    else if (fs.existsSync(defaultPath)) { source = 'default'; activePath = defaultPath; }
    return {
        source,
        path: activePath,
        has_project_key: fs.existsSync(projectPath),
        global_key_path: globalPath,
        fingerprint: activePath ? sshKeyFingerprint(activePath) : '',
    };
}

function validateAndNormalizeKey(pem) {
    const body = String(pem || '');
    if (!/PRIVATE KEY/.test(body)) throw new Error('Not a private key (expected a PEM/OpenSSH private key)');
    let normalized = body.replace(/\r\n/g, '\n');
    if (!normalized.endsWith('\n')) normalized += '\n';
    return normalized;
}

function writeKeyFile(keyPath, content) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, content, { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
    return keyPath;
}

function writeProjectSshKey(projectId, pem) {
    return writeKeyFile(projectSshKeyPath(projectId), validateAndNormalizeKey(pem));
}

function removeKeyFile(keyPath) {
    try { if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath); return true; } catch { return false; }
}

function removeProjectSshKey(projectId) {
    return removeKeyFile(projectSshKeyPath(projectId));
}

// ── Global SSH key (~/.jonggrang/web/ssh/global.key) ─────────────
function globalSshKeyPath() {
    return path.join(os.homedir(), '.jonggrang', 'web', 'ssh', 'global.key');
}

// Status of the global key (and the default fallback) without exposing the key.
function globalSshKeyStatus() {
    const gp = globalSshKeyPath();
    const defaultPath = path.join(os.homedir(), '.ssh', 'id_rsa');
    const hasGlobal = fs.existsSync(gp);
    const activePath = hasGlobal ? gp : (fs.existsSync(defaultPath) ? defaultPath : null);
    return {
        source: hasGlobal ? 'global' : (activePath ? 'default' : 'none'),
        path: activePath,
        has_global_key: hasGlobal,
        global_key_path: gp,
        fingerprint: activePath ? sshKeyFingerprint(activePath) : '',
    };
}

function writeGlobalSshKey(pem) {
    return writeKeyFile(globalSshKeyPath(), validateAndNormalizeKey(pem));
}

function removeGlobalSshKey() {
    return removeKeyFile(globalSshKeyPath());
}

function getContainerPath(project) {
    const safe = project.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `/root/${safe}`;
}

// ── Central worktrees ──────────────────────────────────────────
// Worktrees live OUTSIDE the project repo, under ~/.jonggrang/worktree/<id>/,
// and are bind-mounted into the container at WORKTREE_MOUNT. Keeps the repo
// clean and the worktrees persistent across container rebuilds.
const WORKTREE_MOUNT = '/root/.worktrees';

function worktreeRoot() {
    return path.join(os.homedir(), '.jonggrang', 'worktree');
}
function projectWorktreeDir(projectId) {
    return path.join(worktreeRoot(), projectId);
}
function ensureWorktreeRoot() {
    try { fs.mkdirSync(worktreeRoot(), { recursive: true }); } catch {}
}
function ensureProjectWorktreeDir(projectId) {
    const dir = projectWorktreeDir(projectId);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
}

function isRunning(projectId) {
    return new Promise((resolve, reject) => {
        const proc = spawn('docker', ['inspect', '--format', '{{.State.Running}}', getContainerName(projectId)]);
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.stderr.on('data', () => {});
        proc.on('error', reject);
        proc.on('close', (code) => {
            resolve(code === 0 && out.trim() === 'true');
        });
    });
}

function ensureNetwork(networkName, onLog) {
    return new Promise((resolve, reject) => {
        const check = spawn('docker', ['network', 'inspect', networkName]);
        check.stderr.on('data', () => {});
        check.on('error', reject);
        check.on('close', (code) => {
            if (code === 0) return resolve();
            if (onLog) onLog(`Creating docker network "${networkName}"...`);
            const create = spawn('docker', ['network', 'create', networkName]);
            create.stderr.on('data', () => {});
            create.on('error', reject);
            create.on('close', (c) => {
                if (c === 0) resolve();
                else reject(new Error(`Failed to create docker network "${networkName}"`));
            });
        });
    });
}

function start(project, sandboxConfig, secretVars, onLog) {
    return new Promise((resolve, reject) => {
        const name = getContainerName(project.id);
        const containerPath = getContainerPath(project);
        const image = sandboxConfig?.image || DEFAULT_AGENT_IMAGE;
        const network = sandboxConfig?.network || 'jonggrang';
        const home = os.homedir();

        const envFlags = ['--env', 'IS_SANDBOX=1'];
        for (const [k, v] of Object.entries(secretVars || {})) {
            envFlags.push('--env', `${k}=${v}`);
        }

        // Code editor (Full mode): publish the in-container openvscode port to a
        // RANDOM host port on loopback. No fixed port → no conflicts; the dashboard
        // reverse-proxies to it. Only when the project opted into the full editor.
        const editorPortFlags = project.code_editor === 'full'
            ? ['-p', `127.0.0.1::${EDITOR_CONTAINER_PORT}`]
            : [];

        // Project path is always mounted first (not configurable)
        const volumeMounts = ['-v', `${project.path}:${containerPath}`];
        // Central per-project worktrees, mounted at a dedicated path (created
        // here so docker doesn't auto-make it root-owned with odd perms).
        ensureProjectWorktreeDir(project.id);
        volumeMounts.push('-v', `${projectWorktreeDir(project.id)}:${WORKTREE_MOUNT}`);
        const tmpfsFlags = [];

        // Mount the SSH key (read-only) so in-container `git push` can authenticate.
        // Single file → staged + chmod'd by the push step. Mounts are fixed at
        // `docker run`, so this must happen here at start.
        const sshKey = resolveProjectSshKey(project.id);
        if (sshKey) volumeMounts.push('-v', `${sshKey}:${SSH_KEY_MOUNT}:ro`);

        // Configurable volumes from ~/.jonggrang/web/volumes.json (global) + project overrides.
        // "~" in source is expanded to homedir at runtime.
        // Restrict destination paths to /root or /workspace subdirectories.
        const configVolumes = sandboxConfig?.volumes || [];
        for (const vol of configVolumes) {
            if (!vol.enabled) continue;
            const dest = vol.destination || '';
            if (vol.type === 'tmpfs') {
                if (!dest.startsWith('/root/') && dest !== '/root' && !dest.startsWith('/workspace/') && dest !== '/workspace') continue;
                tmpfsFlags.push('--tmpfs', dest);
            } else {
                if (!dest.startsWith('/root/') && dest !== '/root' && !dest.startsWith('/workspace/') && dest !== '/workspace') continue;
                const rawSource = (vol.source || '').replace(/^~/, home);
                if (!fs.existsSync(rawSource)) continue; // skip if host path missing
                const spec = vol.readonly
                    ? `${rawSource}:${dest}:ro`
                    : `${rawSource}:${dest}`;
                volumeMounts.push('-v', spec);
            }
        }

        const args = [
            'run', '-d',
            '--name', name,
            '--network', network,
            ...volumeMounts,
            ...tmpfsFlags,
            ...envFlags,
            ...editorPortFlags,
            '--workdir', containerPath,
            image,
            // Stage the mounted SSH key into the standard location as a
            // root-owned 0600 copy so `git`/`ssh` use it by default (the bind
            // mount itself can't sit at ~/.ssh/id_rsa — ssh rejects its owner/
            // perms). Runs on every container start, then idles.
            'sh', '-c',
            `mkdir -p /root/.ssh && chmod 700 /root/.ssh; ` +
            `if [ -f ${SSH_KEY_MOUNT} ]; then cp ${SSH_KEY_MOUNT} /root/.ssh/id_rsa && chmod 600 /root/.ssh/id_rsa; fi; ` +
            `exec sleep infinity`,
        ];

        const pull = spawn('docker', ['pull', image]);
        pull.stdout.on('data', d => {
            for (const line of d.toString().split('\n').filter(Boolean)) {
                if (onLog) onLog(line);
            }
        });
        pull.stderr.on('data', d => {
            for (const line of d.toString().split('\n').filter(Boolean)) {
                if (onLog) onLog(line);
            }
        });
        pull.on('close', (code) => {
            if (code !== 0) {
                // Pull failed — check if image already exists locally (e.g. built with build.dev.sh)
                const check = spawn('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
                let checkOut = '';
                check.stdout.on('data', d => { checkOut += d.toString(); });
                check.stderr.on('data', () => {});
                check.on('close', (checkCode) => {
                    if (checkCode !== 0 || !checkOut.trim()) {
                        return reject(new Error(`Image "${image}" not found locally or in registry`));
                    }
                    if (onLog) onLog(`Image found locally. Starting container...`);
                    ensureNetwork(network, onLog).then(doRun).catch(reject);
                });
                return;
            }
            if (onLog) onLog(`Pull completed. Starting container...`);
            ensureNetwork(network, onLog).then(doRun).catch(reject);
        });

        function doRun() {
            const run = spawn('docker', args);
            run.on('error', reject);
            run.stdout.on('data', d => {
                for (const line of d.toString().split('\n').filter(Boolean)) {
                    if (onLog) onLog(line);
                }
            });
            run.stderr.on('data', d => {
                for (const line of d.toString().split('\n').filter(Boolean)) {
                    if (onLog) onLog(line);
                }
            });
            run.on('close', (runCode) => {
                if (runCode === 0) resolve(name);
                else reject(new Error(`docker run failed with code ${runCode}`));
            });
        }
    });
}

function stop(projectId) {
    return new Promise((resolve) => {
        const proc = spawn('docker', ['stop', getContainerName(projectId)]);
        proc.on('error', () => resolve(false));
        proc.on('close', () => resolve(true));
    });
}

function exists(projectId) {
    return new Promise((resolve, reject) => {
        const proc = spawn('docker', ['inspect', '--format', '{{.State.Status}}', getContainerName(projectId)]);
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.stderr.on('data', () => {});
        proc.on('error', reject);
        proc.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    });
}

function startExisting(projectId) {
    return new Promise((resolve, reject) => {
        const proc = spawn('docker', ['start', getContainerName(projectId)]);
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`docker start failed with code ${code}`));
        });
    });
}

function restart(projectId) {
    return new Promise((resolve, reject) => {
        const proc = spawn('docker', ['restart', getContainerName(projectId)]);
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`docker restart failed with code ${code}`));
        });
    });
}

function getContainerImage(projectId) {
    return new Promise((resolve) => {
        const proc = spawn('docker', ['inspect', '--format', '{{.Config.Image}}', getContainerName(projectId)]);
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.stderr.on('data', () => {});
        proc.on('error', () => resolve(null));
        proc.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    });
}

function remove(projectId) {
    return new Promise((resolve) => {
        const proc = spawn('docker', ['rm', '-f', getContainerName(projectId)]);
        proc.on('error', () => resolve(false));
        proc.on('close', () => resolve(true));
    });
}

// Purge a deleted project's on-disk state. The central worktree dir is always
// removed (it is jonggrang-internal state, not the user's repo); the bind-mounted
// project repo is removed only when `deleteRepo`. For SANDBOX projects the files
// were written by the in-container root user, so a host fs.rmSync EACCESes —
// clear the contents via a throwaway root container (the project's agent image,
// already present locally) first, then remove the now-empty dirs. Synchronous so
// the DELETE handler can run it inline before responding.
function purgeProjectFiles(project, { deleteRepo = false } = {}) {
    const targets = [projectWorktreeDir(project.id)];
    if (deleteRepo && project.path) targets.push(project.path);
    const useContainer = !!(project.sandbox && project.sandbox.enabled);
    const image = (project.sandbox && project.sandbox.image) || DEFAULT_AGENT_IMAGE;
    for (const dir of targets) {
        if (!dir || !fs.existsSync(dir)) continue;
        if (useContainer) {
            try {
                execFileSync('docker', ['run', '--rm', '-v', `${dir}:/t`, image,
                    'sh', '-c', 'rm -rf /t/* /t/.[!.]* /t/..?* 2>/dev/null; true'],
                    { stdio: 'ignore', timeout: 120000 });
            } catch { /* image missing / docker error — fall through to host rm */ }
        }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

function buildExecArgs(containerName, containerPath, cmd, cmdArgs, secretVars) {
    const envFlags = [];
    for (const [k, v] of Object.entries(secretVars || {})) {
        envFlags.push('--env', `${k}=${v}`);
    }
    return ['exec', '-it', '--workdir', containerPath, ...envFlags, containerName, cmd, ...cmdArgs];
}

// True if the running/stopped container's mounted SSH key no longer matches
// what we'd resolve now (e.g. a global key was added AFTER the container was
// created). Docker fixes volume mounts at `docker run` time — they can't change
// on start/restart — so a drift means the container must be recreated for the
// new key to take effect. Returns false when there's no container to reconcile.
function sshMountDrifted(projectId) {
    const { execFileSync } = require('child_process');
    let have;
    try {
        have = execFileSync('docker', ['inspect', '--format',
            `{{range .Mounts}}{{if eq .Destination "${SSH_KEY_MOUNT}"}}{{.Source}}{{end}}{{end}}`,
            getContainerName(projectId)], { encoding: 'utf8' }).trim() || null;
    } catch {
        return false; // no container / inspect failed → nothing to reconcile
    }
    const want = resolveProjectSshKey(projectId) || null;
    return want !== have;
}

// True if the container's published editor port no longer matches the project's
// code_editor setting. The editor port is published at `docker run` only (Full
// mode), so toggling code_editor needs a recreate for the change to take effect.
// Returns false when there's no container to reconcile.
function editorMappingDrifted(project) {
    const { execFileSync } = require('child_process');
    let have;
    try {
        const out = execFileSync('docker', ['inspect', '--format',
            `{{if index .HostConfig.PortBindings "${EDITOR_CONTAINER_PORT}/tcp"}}1{{else}}0{{end}}`,
            getContainerName(project.id)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        have = out === '1';
    } catch {
        return false; // no container / inspect failed → nothing to reconcile
    }
    const want = project.code_editor === 'full';
    return want !== have;
}

module.exports = {
    getContainerName, getContainerPath,
    sshMountDrifted, editorMappingDrifted,
    resolveProjectSshKey, projectSshKeyPath, sshKeyStatus,
    writeProjectSshKey, removeProjectSshKey,
    globalSshKeyPath, globalSshKeyStatus, writeGlobalSshKey, removeGlobalSshKey,
    SSH_KEY_MOUNT,
    isRunning, exists, getContainerImage, ensureNetwork,
    start, startExisting, stop, restart, remove, purgeProjectFiles, buildExecArgs,
    EDITOR_CONTAINER_PORT, getEditorHostPort,
    WORKTREE_MOUNT, worktreeRoot, projectWorktreeDir, ensureWorktreeRoot, ensureProjectWorktreeDir,
    AGENT_IMAGE_REPO, DEFAULT_AGENT_IMAGE,
};
