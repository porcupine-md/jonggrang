'use strict';

const { Router } = require('express');
const os   = require('os');
const path = require('path');

const { resolveAgentDir, resolveAuthPath } = require('../../lib/bot-reviewer/auth');

const SYSTEM_PROMPT = `You are a software architect assistant helping the user discuss and refine a project implementation plan.

Your role:
- Answer questions about the plan's approach, trade-offs, risks, and gaps
- Suggest improvements or alternatives when asked
- When asked to revise, describe clearly what to change — do NOT output the full rewritten plan
- Keep responses concise (under 300 words unless asked for more)`;

module.exports = function(deps) {
    const { fs, webState } = deps;
    const router = Router();

    router.post('/:id/plan/chat', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const { message, history = [] } = req.body || {};
        if (!message?.trim()) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'message required' } });

        const MAX_PLAN_BYTES = 32_768; // 32 KB
        const planPath = path.join(project.path, '.jonggrang', 'plan.md');
        let planContent = '(no plan yet)';
        try {
            if (fs.existsSync(planPath)) {
                planContent = fs.readFileSync(planPath, 'utf-8');
                if (Buffer.byteLength(planContent, 'utf-8') > MAX_PLAN_BYTES) {
                    planContent = planContent.slice(0, MAX_PLAN_BYTES) + '\n\n[...plan truncated — too large to embed]';
                }
            }
        } catch {}

        try {
            const {
                createAgentSession,
                AuthStorage,
                ModelRegistry,
                ENV_AGENT_DIR,
            } = await import('@earendil-works/pi-coding-agent');

            const agentDir = resolveAgentDir();
            process.env[ENV_AGENT_DIR] = agentDir;

            const authStorage   = AuthStorage.create(resolveAuthPath());
            const modelRegistry = ModelRegistry.create(authStorage);

            let models = modelRegistry.getAvailable();
            if (models.length === 0) models = modelRegistry.getAll();
            if (models.length === 0) {
                return res.status(503).json({ error: { code: 'NO_MODEL', message: 'No models available. Run jonggrang login first.' } });
            }
            const model = models[0];

            const { session } = await createAgentSession({
                agentDir,
                authStorage,
                modelRegistry,
                model,
                cwd: os.tmpdir(),
            });

            session.setActiveToolsByName([]);
            session.agent.state.systemPrompt = SYSTEM_PROMPT;

            // Build user message: plan context + history + current message (mirrors bot-reviewer pattern)
            const historyBlock = history
                .filter(h => h.role === 'user' || h.role === 'assistant')
                .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
                .join('\n\n');

            const userContent = [
                '## Current Plan',
                '```markdown',
                planContent,
                '```',
                '',
                SYSTEM_PROMPT,
                '',
                historyBlock ? `## Previous conversation\n${historyBlock}\n` : '',
                `## User message\n${message}`,
            ].filter(Boolean).join('\n');

            let disposed = false;
            const dispose = () => {
                if (disposed) return;
                disposed = true;
                try { session.dispose(); } catch {}
            };

            const response = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    dispose();
                    reject(new Error('Chat timed out after 60s'));
                }, 60_000);
                session.subscribe((event) => {
                    if (event.type === 'agent_end') {
                        clearTimeout(timer);
                        resolve(session.getLastAssistantText() ?? '');
                    } else if (event.type === 'error') {
                        clearTimeout(timer);
                        reject(new Error(event.error?.message || 'Agent error'));
                    }
                });
                session.sendUserMessage(userContent).catch((err) => {
                    clearTimeout(timer);
                    reject(err);
                });
            });

            dispose();
            res.json({ content: response });
        } catch (err) {
            res.status(500).json({ error: { code: 'CHAT_ERROR', message: err.message } });
        }
    });

    return router;
};
