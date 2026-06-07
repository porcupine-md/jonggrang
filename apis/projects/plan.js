'use strict';

const { Router } = require('express');

const lib = require('../../lib/jonggrang');

const VALID_PLAN_TOOL   = ['claude', 'opencode', 'codex', 'jonggrang'];
const VALID_PLAN_EFFORT = ['minimal', 'moderate', 'deep'];
const MAX_STRING_LEN    = 100;

module.exports = function(deps) {
    const { fs, path, webState, orchestration, spawnForProject, wireProjectProcess } = deps;
    const router = Router();

    function extractPlanTitle(content) {
        const firstLine = content.split('\n').find(l => l.trim());
        if (!firstLine) return 'Untitled Plan';
        // strip YAML frontmatter delimiter
        if (firstLine === '---') {
            const afterFm = content.split('---').slice(2).join('---').trim();
            const heading = afterFm.split('\n').find(l => l.trim());
            return heading ? heading.replace(/^#+\s*/, '').trim() : 'Untitled Plan';
        }
        return firstLine.replace(/^#+\s*/, '').trim() || 'Untitled Plan';
    }

    // GET /api/projects/:id/plans — list of all plans (draft + archived)
    router.get('/:id/plans', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const plans = [];
        const jonggrangDir = path.join(project.path, '.jonggrang');

        // 1. Active draft plan
        const draftPath = path.join(jonggrangDir, 'plan.md');
        if (fs.existsSync(draftPath)) {
            try {
                const content = fs.readFileSync(draftPath, 'utf-8');
                const mtime = fs.statSync(draftPath).mtimeMs;
                plans.push({ id: 'draft', title: extractPlanTitle(content), status: 'draft', mtime, content });
            } catch {}
        }

        // 2. Archived plans from .output/features/*/plan.md
        const featuresDir = path.join(jonggrangDir, '.output', 'features');
        if (fs.existsSync(featuresDir)) {
            // Per-plan run state from the orchestration registry (live or snapshot).
            let runGroups = {};
            try {
                const view = deps.orchestrationRunView ? deps.orchestrationRunView(project) : null;
                for (const g of (view?.groups || [])) runGroups[g.feature_id] = g;
            } catch {}

            // Tasks grouped by feature_id — authoritative for the web work-loop,
            // which advances task status but NOT the MANIFEST phase machine.
            let tasksByFeature = {};
            try {
                const tasksPath = path.join(jonggrangDir, 'jonggrang-tasks.json');
                if (fs.existsSync(tasksPath)) {
                    const all = JSON.parse(fs.readFileSync(tasksPath, 'utf-8')).tasks || [];
                    for (const t of all) {
                        (tasksByFeature[t.feature_id] = tasksByFeature[t.feature_id] || []).push(t.status);
                    }
                }
            } catch {}

            try {
                const entries = fs.readdirSync(featuresDir)
                    .map(name => ({ name, mtime: fs.statSync(path.join(featuresDir, name)).mtimeMs }))
                    .sort((a, b) => b.mtime - a.mtime);

                for (const { name } of entries) {
                    const planPath = path.join(featuresDir, name, 'plan.md');
                    if (!fs.existsSync(planPath)) continue;
                    const content = fs.readFileSync(planPath, 'utf-8');
                    const mtime = fs.statSync(planPath).mtimeMs;

                    let status = 'approved';
                    let work_type = null;
                    try {
                        const mPath = path.join(featuresDir, name, 'MANIFEST.yaml');
                        if (fs.existsSync(mPath)) {
                            const manifest = orchestration.readManifest(mPath);
                            work_type = manifest?.work_type || null;
                            const ms = manifest?.status;
                            if (ms === 'completed') status = 'done';
                            else if (ms === 'running' || ms === 'paused') status = 'in_progress';
                            else if (ms === 'failed') status = 'failed';
                        }
                    } catch {}

                    // The web work-loop drives TASK status, not the manifest phase
                    // machine, so the manifest can read "running" long after the
                    // work finished. When this plan has tasks, derive status from
                    // them — keeping Plan Mode consistent with Work Mode.
                    const taskStatuses = tasksByFeature[name];
                    if (taskStatuses && taskStatuses.length) {
                        const done = (s) => s === 'completed' || s === 'skipped';
                        const rs = runGroups[name]?.status;
                        if (taskStatuses.every(done)) status = 'done';
                        else if (taskStatuses.some(s => s === 'failed' || s === 'blocked') || rs === 'failed') status = 'failed';
                        // in_progress if work is active OR has partially progressed
                        // (some tasks already done, but not all) — not "approved".
                        else if (taskStatuses.some(s => s === 'in_progress') || rs === 'running' || rs === 'queued' || taskStatuses.some(done)) status = 'in_progress';
                        else status = 'approved';
                    }

                    let branch = null;
                    try { branch = lib.parsePlanFrontmatter(planPath).branch || null; } catch {}

                    const rg = runGroups[name];
                    plans.push({
                        id: name, feature_id: name, title: extractPlanTitle(content),
                        status, mtime, work_type, content, branch,
                        run_status: rg?.status || null,
                        pushed: !!rg?.pushed,
                    });
                }
            } catch {}
        }

        res.json(plans);
    });

    // POST /api/projects/:id/plan/revise — revise plan with AI
    router.post('/:id/plan/revise', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const { instruction } = req.body || {};
        if (!instruction) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'instruction required' } });

        const args = ['plan', '--revise', instruction];
        const child = spawnForProject(project, args);
        wireProjectProcess(project.id, child, 'plan-revise');
        res.status(202).json({ job_id: project.id });
    });

    router.get('/:id/plan', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        // 1. Active draft plan
        const planPath = path.join(project.path, '.jonggrang', 'plan.md');
        if (fs.existsSync(planPath)) {
            try {
                const content = fs.readFileSync(planPath, 'utf-8');
                const mtime = fs.statSync(planPath).mtimeMs;
                return res.json({ exists: true, state: 'draft', content, mtime });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }

        // 2. Archived plan from latest feature output dir
        try {
            const featuresDir = path.join(project.path, '.jonggrang', '.output', 'features');
            if (!fs.existsSync(featuresDir)) return res.json({ exists: false });

            const featureDirs = fs.readdirSync(featuresDir)
                .map(name => ({ name, mtime: fs.statSync(path.join(featuresDir, name)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);

            for (const { name } of featureDirs) {
                const archivedPlan = path.join(featuresDir, name, 'plan.md');
                if (fs.existsSync(archivedPlan)) {
                    const content = fs.readFileSync(archivedPlan, 'utf-8');
                    const mtime = fs.statSync(archivedPlan).mtimeMs;

                    let manifest = null;
                    try {
                        const mPath = path.join(featuresDir, name, 'MANIFEST.yaml');
                        if (fs.existsSync(mPath)) manifest = orchestration.readManifest(mPath);
                    } catch {}

                    return res.json({
                        exists: true,
                        state: manifest?.status === 'done' ? 'archived_done' : 'archived',
                        content,
                        mtime,
                        feature_id: name,
                        work_type: manifest?.work_type || null,
                        manifest_status: manifest?.status || null,
                    });
                }
            }
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }

        res.json({ exists: false });
    });

    router.get('/:id/progress', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        const progressPath = path.join(project.path, '.jonggrang', 'progress.txt');
        if (!fs.existsSync(progressPath)) return res.json({ exists: false, content: '' });
        try {
            const content = fs.readFileSync(progressPath, 'utf-8');
            const mtime = fs.statSync(progressPath).mtimeMs;
            res.json({ exists: true, content, mtime });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/:id/plan', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const { description, deep, tool, model, effort } = req.body || {};
        if (!description) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'description required' } });

        if (tool && !VALID_PLAN_TOOL.includes(tool)) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `tool must be one of: ${VALID_PLAN_TOOL.join(', ')}` } });
        }
        if (model && typeof model === 'string' && model.length > MAX_STRING_LEN) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'model must be under 100 characters' } });
        }
        if (effort && !VALID_PLAN_EFFORT.includes(effort)) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `effort must be one of: ${VALID_PLAN_EFFORT.join(', ')}` } });
        }

        const args = ['plan', description, ...(deep ? ['--deep'] : [])];
        if (tool)   args.push('--tool', tool);
        if (model)  args.push('--model', model);
        if (effort) args.push('--effort', effort);
        const child = spawnForProject(project, args);
        wireProjectProcess(project.id, child, 'plan');
        res.status(202).json({ job_id: project.id });
    });

    router.put('/:id/plan', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const { content, mtime } = req.body || {};
        if (content === undefined) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'content required' } });

        const planPath = path.join(project.path, '.jonggrang', 'plan.md');

        if (mtime && fs.existsSync(planPath)) {
            const currentMtime = fs.statSync(planPath).mtimeMs;
            if (Math.abs(currentMtime - mtime) > 1000) {
                return res.status(409).json({ error: { code: 'PLAN_MTIME_MISMATCH', message: 'Plan was modified externally' } });
            }
        }

        try {
            fs.mkdirSync(path.dirname(planPath), { recursive: true });
            fs.writeFileSync(planPath, content, 'utf-8');
            const newMtime = fs.statSync(planPath).mtimeMs;
            res.json({ mtime: newMtime });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/:id/plan', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const planPath = path.join(project.path, '.jonggrang', 'plan.md');
        try {
            if (fs.existsSync(planPath)) fs.unlinkSync(planPath);
            res.status(204).send();
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
