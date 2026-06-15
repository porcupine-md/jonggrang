'use strict';

// Issues API (feature #55) — browse GitHub/GitLab issues and pick them up as
// plans. Reuses the global PATs (GH_TOKEN / GITLAB_TOKEN) stored via
// /api/settings/git-tokens, falling back to the process env. Issue fetching
// uses native fetch through lib/issue-providers (no gh/glab CLI dependency).

const { Router } = require('express');
const providers = require('../lib/issue-providers');

const CACHE_TTL = 60_000; // 60s — keep the list/detail views responsive.
const PER_PAGE = 20;      // issues per page in the list view.
const AGG_PER_REPO = 50;  // newest issues fetched per repo for the aggregate view.

module.exports = function (deps) {
  const { webState } = deps;
  const router = Router();
  const cache = new Map();

  function tokenFor(provider) {
    const t = webState.getGitTokens();
    if (provider === 'github') return t.GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
    if (provider === 'gitlab') return t.GITLAB_TOKEN || process.env.GITLAB_TOKEN || null;
    return null;
  }

  function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return Promise.resolve(hit.v);
    return Promise.resolve(fn()).then((v) => { cache.set(key, { t: Date.now(), v }); return v; });
  }

  function sendErr(res, err) {
    const status = err.status && err.status >= 400 ? err.status : 500;
    res.status(status).json({ error: { code: 'ISSUE_PROVIDER_ERROR', message: err.message } });
  }

  function requireProvider(req, res) {
    const provider = String(req.query.provider || (req.body && req.body.provider) || '').trim();
    if (provider !== 'github' && provider !== 'gitlab') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'provider must be github or gitlab' } });
      return null;
    }
    return provider;
  }

  // Build the New-Plan form pre-fill from an issue. The visible link line is the
  // primary source-issue marker (it survives AI plan generation because the
  // planner quotes the user's description); the HTML comment is a belt-and-
  // suspenders machine-readable copy.
  function buildPickupDescription(issue) {
    const marker = `<!-- jonggrang-source: ${JSON.stringify({
      provider: issue.provider, repo: issue.repo, number: issue.number, url: issue.url,
    })} -->`;
    const metaParts = [];
    if (issue.labels && issue.labels.length) metaParts.push(`Labels: ${issue.labels.join(', ')}`);
    if (issue.assignees && issue.assignees.length) metaParts.push(`Assignees: ${issue.assignees.map(a => '@' + a).join(', ')}`);
    const meta = metaParts.length ? `\n> ${metaParts.join(' · ')}` : '';
    return [
      marker,
      `# ${issue.title}`,
      '',
      `> Imported from issue [${issue.repo}#${issue.number}](${issue.url})${meta}`,
      '',
      issue.body && issue.body.trim() ? issue.body : '_(no description provided)_',
    ].join('\n');
  }

  // GET /api/issues/connections — which providers have a token + selected repos.
  router.get('/issues/connections', (req, res) => {
    res.json({
      has_gh: !!tokenFor('github'),
      has_gitlab: !!tokenFor('gitlab'),
      sources: webState.getIssueSources(),
    });
  });

  // GET /api/issues/repos?provider=&q= — repos the token can access (repo picker).
  router.get('/issues/repos', async (req, res) => {
    const provider = requireProvider(req, res); if (!provider) return;
    const token = tokenFor(provider);
    if (!token) return res.status(400).json({ error: { code: 'NO_TOKEN', message: `No ${provider} token configured (Settings → Git host tokens).` } });
    const q = String(req.query.q || '').trim();
    try {
      const repos = await cached(`repos:${provider}:${q}`, () => providers.getProvider(provider).listRepos(token, { q }));
      res.json({ repos });
    } catch (err) { sendErr(res, err); }
  });

  // PUT /api/issues/sources — persist selected repos { github:[], gitlab:[] }.
  router.put('/issues/sources', (req, res) => {
    try {
      const sources = webState.setIssueSources(req.body || {});
      res.json({ sources });
    } catch (err) { sendErr(res, err); }
  });

  // GET /api/issues?provider=&repo=&state=&label=&assignee=&q=&page=
  // - provider=github|gitlab + repo: per-page pagination from that repo.
  // - provider=github|gitlab, no repo: aggregate that provider's configured repos.
  // - provider=all (or omitted): aggregate across BOTH providers' configured repos.
  // Aggregated views merge the newest issues, sort newest-first, then paginate.
  router.get('/issues', async (req, res) => {
    const provider = String(req.query.provider || 'all').trim() || 'all';
    if (!['all', 'github', 'gitlab'].includes(provider)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'provider must be all, github or gitlab' } });
    }
    const repo = String(req.query.repo || '').trim();
    const state = String(req.query.state || 'open');
    const label = String(req.query.label || '');
    const assigneeMe = String(req.query.assignee || '') === '@me';
    const assigneeLiteral = assigneeMe ? '' : String(req.query.assignee || '');
    const q = String(req.query.q || '');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    try {
      // Single repo → real per-page pagination (provider must be explicit).
      if (repo) {
        if (provider === 'all') return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'provider required when repo is set' } });
        const token = tokenFor(provider);
        if (!token) return res.status(400).json({ error: { code: 'NO_TOKEN', message: `No ${provider} token configured.` } });
        const prov = providers.getProvider(provider);
        let assignee = assigneeLiteral;
        if (assigneeMe) { const v = await cached(`viewer:${provider}`, () => prov.getViewer(token)); assignee = v.login; }
        const key = `issues:${provider}:${repo}:${state}:${label}:${assignee}:${q}:${page}`;
        const issues = await cached(key, () => prov.listIssues(token, { repo, state, label, assignee, q, page, perPage: PER_PAGE }));
        return res.json({ issues, page, per_page: PER_PAGE, has_more: issues.length === PER_PAGE });
      }

      // Aggregate across the selected provider(s) and their configured repos.
      const wantProviders = provider === 'all' ? ['github', 'gitlab'] : [provider];
      const sources = webState.getIssueSources();
      const sig = wantProviders.map(p => `${p}:${(sources[p] || []).join(',')}`).join('|');
      const aggKey = `agg:${sig}:${state}:${label}:${assigneeMe ? '@me' : assigneeLiteral}:${q}`;

      const merged = await cached(aggKey, async () => {
        const all = [];
        for (const pv of wantProviders) {
          const token = tokenFor(pv);
          if (!token) continue;
          const repos = sources[pv] || [];
          if (!repos.length) continue;
          const prov = providers.getProvider(pv);
          let assignee = assigneeLiteral;
          if (assigneeMe) { try { assignee = (await prov.getViewer(token)).login; } catch { continue; } }
          for (const r of repos) {
            try {
              const items = await prov.listIssues(token, { repo: r, state, label, assignee, q, page: 1, perPage: AGG_PER_REPO });
              all.push(...items);
            } catch { /* skip a repo the token can't access */ }
          }
        }
        all.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
        return all;
      });
      const start = (page - 1) * PER_PAGE;
      const slice = merged.slice(start, start + PER_PAGE);
      res.json({ issues: slice, page, per_page: PER_PAGE, has_more: merged.length > start + PER_PAGE, total: merged.length });
    } catch (err) { sendErr(res, err); }
  });

  // GET /api/issues/detail?provider=&repo=&number= — full body + comments.
  router.get('/issues/detail', async (req, res) => {
    const provider = requireProvider(req, res); if (!provider) return;
    const token = tokenFor(provider);
    if (!token) return res.status(400).json({ error: { code: 'NO_TOKEN', message: `No ${provider} token configured.` } });
    const repo = String(req.query.repo || '').trim();
    const number = parseInt(req.query.number, 10);
    if (!repo || !number) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'repo and number required' } });
    try {
      const issue = await cached(`detail:${provider}:${repo}:${number}`,
        () => providers.getProvider(provider).getIssue(token, { repo, number }));
      res.json({ issue });
    } catch (err) { sendErr(res, err); }
  });

  // POST /api/issues/pickup { provider, repo, number, project_id? }
  // Fetches the issue, builds the New-Plan pre-fill, records the mapping.
  router.post('/issues/pickup', async (req, res) => {
    const provider = requireProvider(req, res); if (!provider) return;
    const token = tokenFor(provider);
    if (!token) return res.status(400).json({ error: { code: 'NO_TOKEN', message: `No ${provider} token configured.` } });
    const { repo, number, project_id } = req.body || {};
    if (!repo || !number) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'repo and number required' } });
    try {
      const issue = await providers.getProvider(provider).getIssue(token, { repo, number: parseInt(number, 10) });
      const description = buildPickupDescription(issue);
      const source = { provider, repo, number: issue.number, url: issue.url, title: issue.title };
      const record = webState.addIssuePickup({
        id: webState.generateId('pickup'),
        provider, repo, number: issue.number, url: issue.url, title: issue.title,
        labels: issue.labels, assignees: issue.assignees,
        project_id: project_id || null,
        feature_id: null,
        imported_at: new Date().toISOString(),
        synced_at: null,
        remote_state: issue.state,
      });
      res.json({ pickup_id: record.id, project_id: project_id || null, description, source });
    } catch (err) { sendErr(res, err); }
  });

  // GET /api/issues/pickups — recorded issue→plan mappings.
  router.get('/issues/pickups', (req, res) => {
    res.json({ pickups: webState.getIssuePickups() });
  });

  // POST /api/issues/sync — refresh remote state of recorded pickups (one-way).
  router.post('/issues/sync', async (req, res) => {
    const pickups = webState.getIssuePickups();
    const results = [];
    for (const p of pickups) {
      const token = tokenFor(p.provider);
      if (!token) { results.push({ id: p.id, ok: false, error: 'no token' }); continue; }
      try {
        const issue = await providers.getProvider(p.provider).getIssue(token, { repo: p.repo, number: p.number });
        const updated = webState.updateIssuePickup(p.id, { remote_state: issue.state, synced_at: new Date().toISOString() });
        results.push({ id: p.id, ok: true, state: issue.state, synced_at: updated.synced_at });
      } catch (err) {
        results.push({ id: p.id, ok: false, error: err.message });
      }
    }
    res.json({ results });
  });

  return router;
};
