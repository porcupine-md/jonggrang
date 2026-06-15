'use strict';

// Run git against a project's MAIN repository in the correct execution context.
//
// For a sandbox project EVERY mutating / network git op (checkout, fetch,
// rebase, commit, push) must run INSIDE the container via `docker exec`, so it
// uses the container's git + its mounted SSH key — never the host's binaries or
// credentials. The project dir is bind-mounted into the container, so the repo
// the container sees is the same on-disk repo; only the *executor* differs.
//
// Host projects keep running git directly on the host. Pure read-only status
// (resolveBaseBranch/hasRemote/baseStateDirty) is intentionally NOT routed here:
// it reads the bind-mounted .git and must work even when the container is down.

const { execSync, execFile, execFileSync } = require('child_process');
const sandbox = require('./sandbox');
const lib = require('./jonggrang');

const GIT_MAXBUF = 1024 * 1024 * 64;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Non-interactive git env for IN-CONTAINER use. Self-contained on purpose: it
// must NOT inherit the host process's GIT_SSH_COMMAND/GIT_ASKPASS (those may
// reference host-only key paths that don't exist in the container). The default
// SSH identity (/root/.ssh/id_rsa, staged on container start) is used; accept-new
// + BatchMode means the "yes/no" host-key prompt never blocks. See
// lib.gitNonInteractiveEnv for the host-side equivalent.
const CONTAINER_GIT_ENV = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20',
};

// Execution context for a project's main repo working tree.
function mainRepoCtx(project) {
    if (project && project.sandbox && project.sandbox.enabled) {
        return {
            mode: 'container',
            container: sandbox.getContainerName(project.id),
            root: sandbox.getContainerPath(project), // e.g. /root/<name>
        };
    }
    return { mode: 'host', container: null, root: project.path };
}

// Run `git <cmd>` (a shell-quoted argument string, as callers already build) in
// the right context. Returns stdout. Throws on non-zero exit (like execSync).
// Always runs non-interactively (host-key auto-accept, no credential/SSH prompt)
// so fetch/rebase/push never hang waiting for a "yes/no" — host or container.
function gitShell(ctx, cmd, opts = {}) {
    if (ctx.mode === 'container') {
        const env = { ...CONTAINER_GIT_ENV, ...(opts.env || {}) };
        const envFlags = [];
        for (const [k, v] of Object.entries(env)) envFlags.push('--env', `${k}=${v}`);
        return execFileSync('docker',
            ['exec', '--workdir', ctx.root, ...envFlags, ctx.container, 'sh', '-c', `git ${cmd}`],
            { encoding: 'utf8', maxBuffer: GIT_MAXBUF });
    }
    return execSync(`git ${cmd}`, {
        cwd: ctx.root, encoding: 'utf8', stdio: 'pipe',
        maxBuffer: GIT_MAXBUF, env: { ...process.env, ...lib.gitNonInteractiveEnv(opts.env || {}) },
    });
}

// Run an arbitrary shell command (e.g. `rm -f`) in the right context.
function shCmd(ctx, cmd) {
    if (ctx.mode === 'container') {
        return execFileSync('docker', ['exec', '--workdir', ctx.root, ctx.container, 'sh', '-c', cmd],
            { encoding: 'utf8', maxBuffer: GIT_MAXBUF });
    }
    return execSync(cmd, { cwd: ctx.root, encoding: 'utf8', stdio: 'pipe', maxBuffer: GIT_MAXBUF });
}

// Container-only: make git usable on the bind-mounted repo (identity ships in
// the image; safe.directory is belt-and-suspenders for odd mount ownership).
function prepareContainerGit(ctx) {
    if (ctx.mode !== 'container') return;
    try { gitShell(ctx, `config --global --add safe.directory '*'`); } catch { /* ignore */ }
}

// Ensure the project's sandbox container is up (auto-start + bounded wait).
// `getSecretVars(projectId)` supplies env for a cold start; pass () => ({}) if none.
async function ensureContainerRunning(project, getSecretVars) {
    let running = await sandbox.isRunning(project.id).catch(() => false);
    if (running) return;
    try {
        const status = await sandbox.exists(project.id).catch(() => null);
        if (status) await sandbox.startExisting(project.id);
        else await sandbox.start(project, project.sandbox, getSecretVars ? getSecretVars(project.id) : {}, () => {});
    } catch (err) {
        throw new Error(err.message || 'failed to start sandbox');
    }
    for (let i = 0; i < 30 && !running; i++) {
        await sleep(500);
        running = await sandbox.isRunning(project.id).catch(() => false);
    }
    if (!running) throw new Error('container did not become ready');
}

// Push a branch. Host → host git. Container → in-container SSH push using the
// mounted key (staged to a root-owned 0600 file). NO host fallback: in sandbox
// mode the push stays sandboxed. Async (network op) — returns a Promise.
function pushBranch(ctx, branch, remote = 'origin') {
    if (ctx.mode !== 'container') {
        return require('./jonggrang').pushBranch(ctx.root, branch, remote);
    }
    return new Promise((resolve, reject) => {
        const script =
            `set -e; ` +
            `mkdir -p /root/.ssh && if [ -f ${sandbox.SSH_KEY_MOUNT} ]; then ` +
            `cp ${sandbox.SSH_KEY_MOUNT} /root/.ssh/id_rsa && chmod 600 /root/.ssh/id_rsa; fi; ` +
            `GIT_TERMINAL_PROMPT=0 ` +
            `GIT_SSH_COMMAND='ssh -i /root/.ssh/id_rsa -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes' ` +
            `git -C ${ctx.root} push -u ${remote} "${branch}"`;
        execFile('docker', ['exec', ctx.container, 'sh', '-c', script],
            { timeout: 60000, maxBuffer: GIT_MAXBUF }, (err, stdout, stderr) => {
                if (!err) return resolve();
                if (err.killed || err.signal === 'SIGTERM') {
                    return reject(new Error('git push timed out (no key or network)'));
                }
                reject(new Error((stderr || stdout || err.message).toString().trim()));
            });
    });
}

module.exports = {
    mainRepoCtx,
    gitShell,
    shCmd,
    prepareContainerGit,
    ensureContainerRunning,
    pushBranch,
};
