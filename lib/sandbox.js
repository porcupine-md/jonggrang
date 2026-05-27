'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

function getContainerName(projectId) {
    return `jonggrang-${projectId}`;
}

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

function start(project, sandboxConfig, secretVars, onLog) {
    return new Promise((resolve, reject) => {
        const name = getContainerName(project.id);
        const containerPath = getContainerPath(project);
        const image = sandboxConfig?.image || 'orcinus/jonggrang-agent';
        const home = os.homedir();

        const envFlags = [];
        for (const [k, v] of Object.entries(secretVars || {})) {
            envFlags.push('--env', `${k}=${v}`);
        }

        // Project path is always mounted first (not configurable)
        const volumeMounts = ['-v', `${project.path}:${containerPath}`];
        const tmpfsFlags = [];

        // Configurable volumes from ~/.jonggrang/web/volumes.json (global) + project overrides.
        // "~" in source is expanded to homedir at runtime.
        const configVolumes = sandboxConfig?.volumes || [];
        for (const vol of configVolumes) {
            if (!vol.enabled) continue;
            if (vol.type === 'tmpfs') {
                tmpfsFlags.push('--tmpfs', vol.destination);
            } else {
                const rawSource = (vol.source || '').replace(/^~/, home);
                if (!fs.existsSync(rawSource)) continue; // skip if host path missing
                const spec = vol.readonly
                    ? `${rawSource}:${vol.destination}:ro`
                    : `${rawSource}:${vol.destination}`;
                volumeMounts.push('-v', spec);
            }
        }

        const args = [
            'run', '-d',
            '--name', name,
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
                return reject(new Error(`docker pull failed with code ${code}`));
            }
            if (onLog) onLog(`Pull completed. Starting container...`);
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
        });
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

module.exports = { getContainerName, getContainerPath, isRunning, exists, start, startExisting, stop, restart, remove, buildExecArgs };
