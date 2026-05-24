'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { fs, path, webState, orchestration, spawnForProject, wireProjectProcess } = deps;
    const router = Router();

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

    router.post('/:id/plan', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const { description, deep } = req.body || {};
        if (!description) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'description required' } });

        const args = ['plan', description, ...(deep ? ['--deep'] : [])];
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
