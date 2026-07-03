'use strict';

const { Router } = require('express');

const lib = require('../../lib/jonggrang');
const { STATIC_EFFORTS } = require('../models');

const VALID_PLAN_TOOL   = ['claude', 'opencode', 'codex', 'jonggrang'];
// Effort levels are backend-specific (see apis/models.js STATIC_EFFORTS — the
// same set the UI's effort dropdown is populated from). Validate per-tool, and
// fall back to the union of all backends when no tool is given on the request.
const ALL_EFFORTS = [...new Set(Object.values(STATIC_EFFORTS).flat())];
const MAX_STRING_LEN    = 100;

module.exports = function(deps) {
    const { fs, path, webState, orchestration, spawnForProject, wireProjectProcess } = deps;
    const router = Router();

    // Extract a source-issue link from plan content (feature #55). Tries the
    // machine-readable marker first, then falls back to any GitHub/GitLab issue
    // URL — robust even if the planner rewrote the body during generation.
    function parseSourceIssue(content) {
        if (!content) return null;
        const m = content.match(/<!--\s*jonggrang-source:\s*(\{.*?\})\s*-->/);
        if (m) {
            try {
                const o = JSON.parse(m[1]);
                if (o && o.provider && o.repo && o.number) {
                    return { provider: o.provider, repo: o.repo, number: o.number, url: o.url || null };
                }
            } catch {}
        }
        const gh = content.match(/https?:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\/issues\/(\d+)/);
        if (gh) return { provider: 'github', repo: gh[1], number: parseInt(gh[2], 10), url: gh[0] };
        const gl = content.match(/https?:\/\/gitlab\.com\/(.+?)\/-\/issues\/(\d+)/);
        if (gl) return { provider: 'gitlab', repo: gl[1], number: parseInt(gl[2], 10), url: gl[0] };
        return null;
    }

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

    function migrateLegacyDraft(project) {
        try { return lib.migrateLegacyPlanDraft(project.path); } catch { return null; }
    }

    function requestedSession(req) {
        return (req.body && (req.body.sessionId || req.body.session))
            || (req.query && (req.query.sessionId || req.query.session))
            || '';
    }

    function resolveDraft(project, sessionId = '') {
        migrateLegacyDraft(project);
        const drafts = lib.getAllDrafts(project.path);
        const draft = sessionId
            ? drafts.find(d => d.sessionId === sessionId)
            : drafts[0];
        if (!draft) return null;
        return { sessionId: draft.sessionId, planPath: draft.planPath };
    }

    // GET /api/projects/:id/plans — list of all plans (draft + archived)
    router.get('/:id/plans', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const plans = [];
        const jonggrangDir = path.join(project.path, '.jonggrang');
        migrateLegacyDraft(project);

        // 1. Pending draft sessions from .drafts/<session>/plan.md
        for (const draft of lib.getAllDrafts(project.path)) {
            try {
                const content = fs.readFileSync(draft.planPath, 'utf-8');
                const mtime = fs.statSync(draft.planPath).mtimeMs;
                plans.push({
                    id: draft.sessionId,
                    sessionId: draft.sessionId,
                    title: extractPlanTitle(content),
                    status: 'draft',
                    mtime,
                    content,
                    source_issue: parseSourceIssue(content),
                });
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
                const allTasks = lib.getAllTasks(project.path);
                for (const t of allTasks.tasks || []) {
                    (tasksByFeature[t.feature_id] = tasksByFeature[t.feature_id] || []).push(t.status);
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
                        source_issue: parseSourceIssue(content),
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

        const draft = resolveDraft(project, requestedSession(req));
        if (!draft) return res.status(422).json({ error: { code: 'PLAN_NOT_FOUND', message: 'No draft plan found. Generate a plan first.' } });

        const args = ['plan', '--revise', instruction, '--session', draft.sessionId];
        const child = spawnForProject(project, args);
        wireProjectProcess(project.id, child, 'plan-revise');
        res.status(202).json({ job_id: project.id });
    });

    router.get('/:id/plan', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        // 1. Active (or requested) draft session
        const draft = resolveDraft(project, requestedSession(req));
        if (draft) {
            try {
                const content = fs.readFileSync(draft.planPath, 'utf-8');
                const mtime = fs.statSync(draft.planPath).mtimeMs;
                return res.json({ exists: true, state: 'draft', sessionId: draft.sessionId, content, mtime });
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

        const { description, deep, tool, model, effort, fileContent, fileName, base } = req.body || {};

        if (!description && !fileContent) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'description or file required' } });
        }
        if (tool && !VALID_PLAN_TOOL.includes(tool)) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `tool must be one of: ${VALID_PLAN_TOOL.join(', ')}` } });
        }
        if (model && typeof model === 'string' && model.length > MAX_STRING_LEN) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'model must be under 100 characters' } });
        }
        if (effort) {
            const allowed = tool ? (STATIC_EFFORTS[tool] || []) : ALL_EFFORTS;
            if (!allowed.includes(effort)) {
                const expected = allowed.length ? allowed.join(', ') : '(this backend takes no effort level)';
                return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `effort must be one of: ${expected}` } });
            }
        }
        if (base && !lib.isSafeBranchName(base)) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'base must be a plain branch name (letters, digits, . _ / -)' } });
        }

        let tempFilePath = null;

        if (fileContent && fileName) {
            const ext = path.extname(fileName).toLowerCase();
            // No extension allowlist — the coding agent decides how to read the source file.
            // Write base64-encoded file to .jonggrang/.ephemeral/ in the project
            const ephemeralDir = path.join(project.path, '.jonggrang', '.ephemeral');
            fs.mkdirSync(ephemeralDir, { recursive: true });
            const tempName = `brd-input-${Date.now()}${ext}`;
            tempFilePath = path.join(ephemeralDir, tempName);
            try {
                fs.writeFileSync(tempFilePath, Buffer.from(fileContent, 'base64'));
            } catch (err) {
                return res.status(500).json({ error: { code: 'FILE_WRITE_ERROR', message: `Failed to save uploaded file: ${err.message}` } });
            }
        }

        const args = ['plan'];
        if (tempFilePath) {
            args.push('--src', path.relative(project.path, tempFilePath));
            if (description) args.push(description);
        } else {
            args.push(description);
        }
        if (deep)   args.push('--deep');
        if (tool)   args.push('--tool', tool);
        if (model)  args.push('--model', model);
        if (effort) args.push('--effort', effort);
        if (base)   args.push('--base', base);
        const child = spawnForProject(project, args);
        wireProjectProcess(project.id, child, 'plan');
        res.status(202).json({ job_id: project.id });
    });

    // GET the clarifying questions the planning agent submitted (feature: plan ask).
    router.get('/:id/plan/questions', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        // Questions live per-draft under .drafts/<session>/ — resolve the session
        // (explicit override, else newest pending draft, else the active draft)
        // instead of hardcoding the old root singleton.
        const sid = requestedSession(req)
            || lib.resolveActiveQuestionDraft(project.path)
            || lib.resolveActiveDraft(project.path);
        if (!sid) return res.json({ exists: false, goal_analysis: '', questions: [] });
        const qPath = lib.questionsFileFor(project.path, sid);
        if (!fs.existsSync(qPath)) return res.json({ exists: false, goal_analysis: '', questions: [] });
        try {
            const data = JSON.parse(fs.readFileSync(qPath, 'utf-8'));
            res.json({ exists: true, sessionId: sid, goal_analysis: data.goal_analysis || '', questions: data.questions || [] });
        } catch (err) {
            res.status(500).json({ error: { code: 'READ_ERROR', message: err.message } });
        }
    });

    // Answer the clarifying questions → run Pass B (generate the plan with the
    // answers). Answers are passed to the CLI inline (base64) so the same path
    // works under the Docker sandbox without host/container fs ownership issues.
    router.post('/:id/plan/answers', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const { description, deep, tool, model, effort, base, answers } = req.body || {};
        if (!description) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'description required' } });
        if (!Array.isArray(answers) || answers.length === 0) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'answers must be a non-empty array' } });
        }
        if (answers.length > 20) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'too many answers (max 20)' } });
        }
        for (const a of answers) {
            if (!a || typeof a !== 'object' || !a.id) {
                return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'each answer needs an id' } });
            }
        }
        if (tool && !VALID_PLAN_TOOL.includes(tool)) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `tool must be one of: ${VALID_PLAN_TOOL.join(', ')}` } });
        }
        if (model && typeof model === 'string' && model.length > MAX_STRING_LEN) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'model must be under 100 characters' } });
        }
        if (effort) {
            const allowed = tool ? (STATIC_EFFORTS[tool] || []) : ALL_EFFORTS;
            if (!allowed.includes(effort)) {
                const expected = allowed.length ? allowed.join(', ') : '(this backend takes no effort level)';
                return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `effort must be one of: ${expected}` } });
            }
        }
        if (base && !lib.isSafeBranchName(base)) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'base must be a plain branch name (letters, digits, . _ / -)' } });
        }

        const goal_analysis = typeof req.body.goal_analysis === 'string' ? req.body.goal_analysis : '';
        const payload = { goal_analysis, answers };
        const inline = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
        if (inline.length > 200000) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'answers payload too large' } });
        }

        // Reuse the draft that already holds the pending questions (Pass A wrote
        // them into .drafts/<sid>/). Passing --session makes Pass B generate
        // plan.md into that same draft instead of minting a fresh one — so the
        // questions-only draft becomes the real plan draft (no orphan folders).
        const sid = requestedSession(req) || lib.resolveActiveQuestionDraft(project.path);

        const args = ['plan', description, ...(deep ? ['--deep'] : []), '--answers-inline', inline];
        if (sid)    args.push('--session', sid);
        if (tool)   args.push('--tool', tool);
        if (model)  args.push('--model', model);
        if (effort) args.push('--effort', effort);
        if (base)   args.push('--base', base);
        const child = spawnForProject(project, args);
        wireProjectProcess(project.id, child, 'plan');
        res.status(202).json({ job_id: project.id });
    });

    router.put('/:id/plan', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const { content, mtime } = req.body || {};
        if (content === undefined) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'content required' } });

        const draft = resolveDraft(project, requestedSession(req));
        if (!draft) return res.status(422).json({ error: { code: 'PLAN_NOT_FOUND', message: 'No draft plan found. Generate a plan first.' } });
        const planPath = draft.planPath;

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
            res.json({ sessionId: draft.sessionId, mtime: newMtime });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/:id/plan', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const draft = resolveDraft(project, requestedSession(req));
        try {
            if (draft) fs.rmSync(lib.draftDirFor(project.path, draft.sessionId), { recursive: true, force: true });
            res.status(204).send();
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
