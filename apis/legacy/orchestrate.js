'use strict';

const { Router } = require('express');
const path = require('path');
const { spawn } = require('child_process');

module.exports = function(deps) {
    const { io, PROJECT_ROOT, orchestration } = deps;
    const router = Router();

    router.post('/orchestrate/resume', async (req, res) => {
        const { featureId } = req.body || {};
        try {
            const entry = featureId
                ? { featureId, manifest: orchestration.readManifest(orchestration.getManifestPath(PROJECT_ROOT, featureId)) }
                : orchestration.findIncompleteManifest(PROJECT_ROOT);

            if (!entry || !entry.manifest) {
                return res.status(404).json({ error: 'No incomplete orchestration found' });
            }

            const child = spawn('node', [
                path.join(__dirname, '..', '..', 'bin', 'jonggrang.js'),
                'orchestrate', '--resume',
            ], {
                cwd: PROJECT_ROOT,
                env: { ...process.env, JONGGRANG_PROJECT_ROOT: PROJECT_ROOT },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            child.stdout.on('data', d => io.emit('log', { stream: 'stdout', data: d.toString() }));
            child.stderr.on('data', d => io.emit('log', { stream: 'stderr', data: d.toString() }));
            child.on('close', code => {
                io.emit('orchestration_complete', { featureId: entry.featureId, exitCode: code });
            });

            res.json({ featureId: entry.featureId, manifest: entry.manifest });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/manifests', (req, res) => {
        try {
            const manifests = orchestration.listManifests(PROJECT_ROOT);
            res.json(manifests.map(({ featureId, manifest }) => ({
                featureId,
                description: manifest.description,
                workType: manifest.work_type,
                status: manifest.status,
                currentPhase: manifest.current_phase,
                activePhases: manifest.active_phases,
                progress: {
                    completed: manifest.active_phases.filter(n => manifest.phases[n]?.status === 'completed').length,
                    total: manifest.active_phases.length,
                },
                createdAt: manifest.created_at,
                updatedAt: manifest.updated_at,
            })));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/manifests/:featureId', (req, res) => {
        try {
            const featureId = req.params.featureId.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 100);
            const manifestPath = orchestration.getManifestPath(PROJECT_ROOT, featureId);
            if (!manifestPath.startsWith(path.resolve(PROJECT_ROOT))) {
                return res.status(403).json({ error: 'Invalid feature ID' });
            }
            const manifest = orchestration.readManifest(manifestPath);
            if (!manifest) return res.status(404).json({ error: 'Manifest not found' });
            res.json({ featureId, manifest, manifestPath });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
