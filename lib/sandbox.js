'use strict';

const { spawn } = require('child_process');
const os = require('os');

function getContainerName(projectId) {
    return `jonggrang-${projectId}`;
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

function start(project, secretVars, onLog) {
    return new Promise((resolve, reject) => {
        const name = getContainerName(project.id);
        const image = project.sandbox?.image || 'orcinus/jonggrang-agent';
        const home = os.homedir();

        const envFlags = [];
        for (const [k, v] of Object.entries(secretVars || {})) {
            envFlags.push('--env', `${k}=${v}`);
        }

        const args = [
            'run', '-d',
            '--name', name,
            '--rm',
            '-v', `${project.path}:${project.path}`,
            '-v', `${home}/.claude:/root/.claude`,
            '-v', `${home}/.opencode:/root/.opencode`,
            '-v', `${home}/.jonggrang:/root/.jonggrang`,
            ...envFlags,
            '--workdir', project.path,
            image,
            'sleep', 'infinity',
        ];

        // Pull first, then run
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

function buildExecArgs(containerName, cmd, cmdArgs, secretVars) {
    const envFlags = [];
    for (const [k, v] of Object.entries(secretVars || {})) {
        envFlags.push('--env', `${k}=${v}`);
    }
    return ['exec', '-it', ...envFlags, containerName, cmd, ...cmdArgs];
}

module.exports = { getContainerName, isRunning, start, stop, remove, buildExecArgs };
