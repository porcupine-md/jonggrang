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
    return new Promise((resolve) => {
        const proc = spawn('docker', ['inspect', '--format', '{{.State.Running}}', getContainerName(projectId)]);
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
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

        const volumeMounts = [
            '-v', `${project.path}:${containerPath}`,
            '-v', `${home}/.claude:/root/.claude`,
            '-v', `${home}/.opencode:/root/.opencode`,
            '-v', `${home}/.jonggrang:/root/.jonggrang`,
            '-v', `${home}/.config/opencode:/root/.config/opencode`,
            '-v', `${home}/.local/share/opencode:/root/.local/share/opencode`,
        ];

        // Mount ~/.claude.json only if it exists (Docker creates dir if missing)
        const claudeJson = `${home}/.claude.json`;
        if (fs.existsSync(claudeJson)) {
            volumeMounts.push('-v', `${claudeJson}:/root/.claude.json`);
        }

        const args = [
            'run', '-d',
            '--name', name,
            '--rm',
            ...volumeMounts,
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
            if (onLog) onLog(`Pull exited (${code}). Starting container...`);
            const run = spawn('docker', args);
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
        proc.on('close', resolve);
    });
}

function remove(projectId) {
    return new Promise((resolve) => {
        const proc = spawn('docker', ['rm', '-f', getContainerName(projectId)]);
        proc.on('close', resolve);
    });
}

function buildExecArgs(containerName, containerPath, cmd, cmdArgs, secretVars) {
    const envFlags = [];
    for (const [k, v] of Object.entries(secretVars || {})) {
        envFlags.push('--env', `${k}=${v}`);
    }
    return ['exec', '-it', '--workdir', containerPath, ...envFlags, containerName, cmd, ...cmdArgs];
}

module.exports = { getContainerName, getContainerPath, isRunning, start, stop, remove, buildExecArgs };
