'use strict';

const { Router } = require('express');
const sandbox = require('../../lib/sandbox');

module.exports = function(deps) {
    const { fs, path, webState, orchestration } = deps;
    const router = Router();

    router.get('/:id/manifest', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        try {
            const featuresDir = path.join(project.path, '.jonggrang', '.output', 'features');
            if (!fs.existsSync(featuresDir)) return res.status(404).json({ error: { code: 'NO_MANIFEST', message: 'No manifest found' } });

            // Per-plan scope (Work Mode pipeline): read that feature's manifest from
            // its isolated worktree if a run is live there, else the main snapshot.
            const { feature_id } = req.query;
            if (feature_id) {
                const mPath = path.join(sandbox.featureOutputDir(project, String(feature_id)), 'MANIFEST.yaml');
                if (!fs.existsSync(mPath)) return res.status(404).json({ error: { code: 'NO_MANIFEST', message: 'No manifest for this plan' } });
                return res.json(orchestration.readManifest(mPath));
            }

            const featureDirs = fs.readdirSync(featuresDir)
                .map(name => ({ name, mtime: fs.statSync(path.join(featuresDir, name)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);

            for (const { name } of featureDirs) {
                const mPath = path.join(featuresDir, name, 'MANIFEST.yaml');
                if (fs.existsSync(mPath)) {
                    const manifest = orchestration.readManifest(mPath);
                    return res.json(manifest);
                }
            }
            res.status(404).json({ error: { code: 'NO_MANIFEST', message: 'No manifest found' } });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
