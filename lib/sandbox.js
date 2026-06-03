'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function getContainerName(projectId) {
    return `jonggrang-${projectId}`;
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

function getContainerPath(project) {
    const safe = project.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `/root/${safe}`;
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
        const image = sandboxConfig?.image || 'orcinus/jonggrang-agent';
        const network = sandboxConfig?.network || 'jonggrang';
        const home = os.homedir();

        const envFlags = ['--env', 'IS_SANDBOX=1'];
        for (const [k, v] of Object.entries(secretVars || {})) {
            envFlags.push('--env', `${k}=${v}`);
        }

        // Project path is always mounted first (not configurable)
        const volumeMounts = ['-v', `${project.path}:${containerPath}`];
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
            '--workdir', containerPath,
            image,
            'sleep', 'infinity',
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

function buildExecArgs(containerName, containerPath, cmd, cmdArgs, secretVars) {
    const envFlags = [];
    for (const [k, v] of Object.entries(secretVars || {})) {
        envFlags.push('--env', `${k}=${v}`);
    }
    return ['exec', '-it', '--workdir', containerPath, ...envFlags, containerName, cmd, ...cmdArgs];
}

module.exports = { getContainerName, getContainerPath, resolveProjectSshKey, SSH_KEY_MOUNT, isRunning, exists, getContainerImage, ensureNetwork, start, startExisting, stop, restart, remove, buildExecArgs };
