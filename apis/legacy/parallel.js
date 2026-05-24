'use strict';

const { Router } = require('express');
const { execSync } = require('child_process');

function sanitizeGitRef(ref) {
    if (typeof ref !== 'string') return null;
    const clean = ref.replace(/[^a-zA-Z0-9/_.\-]/g, '').slice(0, 200);
    if (clean !== ref) return null;
    if (clean.includes('..') || clean.startsWith('-')) return null;
    return clean;
}

module.exports = function(deps) {
    const { io, PROJECT_ROOT, lib, paths, state, groupProcesses, spawnJonggrang, stopGroupProcess } = deps;
    const router = Router();

    router.post('/start-parallel', (req, res) => {
        if (state.isJonggrangRunning || groupProcesses.size > 0) {
            return res.status(400).json({ error: 'Already running' });
        }

        const groups = lib.getTaskGroups(paths.tasksFile);
        if (groups.length === 0) {
            return res.status(400).json({ error: 'No pending task groups' });
        }

        const tool = req.body?.tool || state.latestConfig?.tool || 'opencode';
        const baseBranch = 'HEAD';
        let completedGroups = 0;

        state.isJonggrangRunning = true;
        io.emit('jonggrang_status', { isRunning: true, mode: 'parallel', groups: groups.length });

        for (const group of groups) {
            for (const id of group.taskIds) {
                lib.updateTaskStatus(paths.tasksFile, id, 'waiting');
            }
        }

        for (const group of groups) {
            let wt;
            try {
                wt = lib.createWorktree(PROJECT_ROOT, group.id, baseBranch);
            } catch (err) {
                io.emit('log', `[${group.id}] Failed to create worktree: ${err.message}\n`);
                for (const id of group.taskIds) {
                    lib.updateTaskStatus(paths.tasksFile, id, 'pending');
                }
                continue;
            }

            lib.copyToWorktree(PROJECT_ROOT, wt.worktreePath, [
                '.jonggrang',
                'AGENTS.md', 'CLAUDE.md', 'opencode.json',
                '.claude', '.opencode',
            ]);

            const child = spawnJonggrang(
                ['work', '--worktree', '--group-tasks', group.taskIds.join(','), '--tool', tool],
                { JONGGRANG_PROJECT_ROOT: wt.worktreePath, JONGGRANG_MODE: 'autonomous' },
                wt.worktreePath
            );

            const groupInfo = {
                process: child, branch: wt.branch, worktreePath: wt.worktreePath,
                baseSha: wt.baseSha, status: 'running', taskIds: group.taskIds,
            };
            groupProcesses.set(group.id, groupInfo);

            io.emit('log', `[${group.id}] Started in ${wt.worktreePath} (branch: ${wt.branch})\n`);
            io.emit('group_status', { groupId: group.id, status: 'running', branch: wt.branch, taskIds: group.taskIds });

            let buffer = '';
            child.stdout.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const msg = JSON.parse(line);
                        if (msg.type === 'task_status') {
                            lib.updateTaskStatus(paths.tasksFile, msg.taskId, msg.status);
                        }
                    } catch {
                        io.emit('log', `[${group.id}] ${line}\n`);
                    }
                }
            });

            child.stderr.on('data', (d) => io.emit('log', `[${group.id}] ${d.toString()}`));

            child.on('close', (code) => {
                groupInfo.status = code === 0 ? 'done' : 'failed';
                completedGroups++;
                io.emit('log', `[${group.id}] Exited with code ${code}\n`);

                if (groupInfo.status === 'done') {
                    for (const tid of group.taskIds) {
                        lib.updateTaskStatus(paths.tasksFile, tid, 'review');
                    }
                }
                io.emit('group_status', { groupId: group.id, status: groupInfo.status });

                if (completedGroups >= groupProcesses.size) {
                    state.isJonggrangRunning = false;
                    io.emit('jonggrang_status', { isRunning: false, mode: 'idle' });
                    io.emit('parallel_complete', {
                        groups: Array.from(groupProcesses.entries()).map(([id, g]) => ({
                            id, status: g.status, branch: g.branch, taskIds: g.taskIds,
                        })),
                    });
                }
            });
        }

        res.json({
            success: true,
            groups: groups.map(g => ({ id: g.id, taskIds: g.taskIds })),
        });
    });

    router.get('/groups', (req, res) => {
        const groups = Array.from(groupProcesses.entries()).map(([id, g]) => ({
            id, branch: g.branch, worktreePath: g.worktreePath,
            status: g.status, taskIds: g.taskIds,
        }));
        res.json({ groups });
    });

    router.post('/groups/:id/review', (req, res) => {
        const group = groupProcesses.get(req.params.id);
        if (!group) return res.status(404).json({ error: 'Group not found' });

        io.emit('log', `[review:${req.params.id}] Starting review...\n`);
        const child = spawnJonggrang(['review'], { JONGGRANG_PROJECT_ROOT: group.worktreePath, JONGGRANG_MODE: 'autonomous' });
        child.stdout.on('data', (d) => io.emit('log', `[review:${req.params.id}] ${d.toString()}`));
        child.stderr.on('data', (d) => io.emit('log', `[review:${req.params.id}] ${d.toString()}`));
        child.on('close', (code) => {
            io.emit('log', `[review:${req.params.id}] Review exited with code ${code}\n`);
            io.emit('group_review_complete', { groupId: req.params.id, code });
        });
        res.json({ success: true });
    });

    router.get('/groups/:id/diff', (req, res) => {
        const group = groupProcesses.get(req.params.id);
        if (!group) return res.status(404).json({ error: 'Group not found', diff: '', files: [] });

        try {
            const base = sanitizeGitRef(group.baseSha || 'HEAD');
            const branch = sanitizeGitRef(group.branch);
            const diff = execSync(
                `git diff ${base}...${branch}`,
                { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 15000 }
            );
            const files = execSync(
                `git diff ${base}...${branch} --name-only`,
                { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 15000 }
            ).trim().split('\n').filter(Boolean);
            res.json({ diff, files });
        } catch (err) {
            res.json({ diff: '', files: [], error: err.message });
        }
    });

    router.post('/groups/:id/revise', (req, res) => {
        const group = groupProcesses.get(req.params.id);
        if (!group) return res.status(404).json({ error: 'Group not found' });

        const { feedback: revisionFeedback } = req.body;
        if (!revisionFeedback) return res.status(400).json({ error: 'feedback required' });

        state.isJonggrangRunning = true;
        io.emit('jonggrang_status', { isRunning: true, mode: 'revision' });
        io.emit('log', `[revise:${req.params.id}] Revising: ${revisionFeedback}\n`);

        const tool = state.latestConfig?.tool || 'opencode';
        const child = spawnJonggrang(
            ['work', '--worktree', '--group-tasks', group.taskIds.join(','), '--tool', tool],
            { JONGGRANG_PROJECT_ROOT: group.worktreePath, JONGGRANG_MODE: 'autonomous', JONGGRANG_REVISION_FEEDBACK: revisionFeedback },
            group.worktreePath
        );

        child.stdout.on('data', (d) => {
            const line = d.toString();
            io.emit('log', { stream: 'stdout', data: line });
        });
        child.stderr.on('data', (d) => io.emit('log', { stream: 'stderr', data: d.toString() }));
        child.on('close', (code) => {
            state.isJonggrangRunning = false;
            io.emit('jonggrang_status', { isRunning: false, mode: 'idle' });
            io.emit('log', `[revise:${req.params.id}] Revision done (code: ${code})\n`);
        });

        res.json({ success: true });
    });

    router.post('/groups/:id/cancel', async (req, res) => {
        const group = groupProcesses.get(req.params.id);
        if (!group) return res.status(404).json({ error: 'Group not found' });

        try {
            await stopGroupProcess(group);

            for (const tid of group.taskIds) {
                lib.updateTaskStatus(paths.tasksFile, tid, 'pending');
            }

            lib.removeWorktree(PROJECT_ROOT, group.worktreePath, group.branch);
            groupProcesses.delete(req.params.id);

            io.emit('group_status', { groupId: req.params.id, status: 'cancelled' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/groups/:id/merge', (req, res) => {
        const group = groupProcesses.get(req.params.id);
        if (!group) return res.status(404).json({ error: 'Group not found' });

        try {
            lib.mergeWorktreeBranch(PROJECT_ROOT, group.branch);
            lib.removeWorktree(PROJECT_ROOT, group.worktreePath, group.branch);
            for (const tid of group.taskIds) {
                lib.markTaskDone(paths.tasksFile, tid);
            }
            group.status = 'merged';
            groupProcesses.delete(req.params.id);
            io.emit('group_status', { groupId: req.params.id, status: 'merged' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/groups/merge-all', (req, res) => {
        const results = [];
        for (const [id, group] of groupProcesses) {
            if (group.status === 'merged') continue;
            try {
                lib.mergeWorktreeBranch(PROJECT_ROOT, group.branch);
                lib.removeWorktree(PROJECT_ROOT, group.worktreePath, group.branch);
                for (const tid of group.taskIds) {
                    lib.markTaskDone(paths.tasksFile, tid);
                }
                group.status = 'merged';
                groupProcesses.delete(id);
                io.emit('group_status', { groupId: id, status: 'merged' });
                results.push({ id, status: 'merged' });
            } catch (err) {
                results.push({ id, status: 'error', error: err.message });
            }
        }
        res.json({ results });
    });

    router.post('/stop-parallel', async (req, res) => {
        const groupsToClear = [];
        for (const [id, group] of groupProcesses) {
            if (group.status === 'merged') continue;
            await stopGroupProcess(group);
            group.status = 'cancelled';
            io.emit('group_status', { groupId: id, status: 'cancelled' });
            groupsToClear.push(id);
        }
        for (const id of groupsToClear) {
            groupProcesses.delete(id);
        }
        lib.revertWaiting(paths.tasksFile);
        state.isJonggrangRunning = false;
        io.emit('jonggrang_status', { isRunning: false });
        res.json({ success: true });
    });

    router.post('/groups/cleanup', async (req, res) => {
        for (const [id, group] of groupProcesses) {
            if (group.status !== 'merged') {
                await stopGroupProcess(group);
                lib.removeWorktree(PROJECT_ROOT, group.worktreePath, group.branch);
            }
        }
        groupProcesses.clear();
        lib.revertWaiting(paths.tasksFile);
        state.isJonggrangRunning = false;
        io.emit('jonggrang_status', { isRunning: false });
        res.json({ success: true });
    });

    return router;
};
