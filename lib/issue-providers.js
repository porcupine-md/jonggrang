'use strict';

// GitHub & GitLab issue providers (feature #55).
//
// Pure functions: a token goes in, a normalized shape comes out. No state, no
// disk, no env reads — the API layer resolves the token (from web-state) and
// passes it here. `fetchImpl` is injectable so the unit tests can mock the
// network; it defaults to the global `fetch` (Node 18+).
//
// Normalized issue shape (both providers map onto this):
//   { provider, repo, number, title, state: 'open'|'closed', labels: [str],
//     assignees: [str], author, body, body_preview, url, updated_at,
//     comments_count }
// Normalized repo shape:    { provider, full_name, url, private, description }
// Normalized comment shape: { author, body, created_at }

const GITHUB_API = 'https://api.github.com';
const GITLAB_API = 'https://gitlab.com/api/v4';
const PREVIEW_LEN = 240;

function preview(body) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (text.length <= PREVIEW_LEN) return text;
  return text.slice(0, PREVIEW_LEN).trimEnd() + '…';
}

function defaultFetch() {
  if (typeof fetch === 'function') return fetch;
  throw new Error('global fetch is unavailable (requires Node 18+)');
}

async function apiGet(url, headers, fetchImpl) {
  const f = fetchImpl || defaultFetch();
  let res;
  try {
    res = await f(url, { headers });
  } catch (err) {
    const e = new Error(`Network error contacting ${url}: ${err.message}`);
    e.status = 0;
    throw e;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    const e = new Error(httpMessage(res.status, detail));
    e.status = res.status;
    throw e;
  }
  return res.json();
}

function httpMessage(status, detail) {
  if (status === 401) return 'Authentication failed — token missing or invalid (401).';
  if (status === 403) return 'Access forbidden or rate-limited (403). Check token scopes.';
  if (status === 404) return 'Not found (404) — repo/issue missing or token lacks access.';
  return `Request failed (${status})${detail ? `: ${detail}` : ''}`;
}

// ── GitHub ────────────────────────────────────────────────────────────────────

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'jonggrang',
  };
}

function ghState(state) {
  if (state === 'closed') return 'closed';
  if (state === 'all') return 'all';
  return 'open';
}

function normalizeGithubIssue(repo, raw) {
  return {
    provider: 'github',
    repo,
    number: raw.number,
    title: raw.title || '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    labels: (raw.labels || []).map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    assignees: (raw.assignees || []).map(a => a.login).filter(Boolean),
    author: raw.user?.login || null,
    body: raw.body || '',
    body_preview: preview(raw.body),
    url: raw.html_url,
    updated_at: raw.updated_at || null,
    comments_count: raw.comments ?? 0,
  };
}

const github = {
  async getViewer(token, fetchImpl) {
    const u = await apiGet(`${GITHUB_API}/user`, ghHeaders(token), fetchImpl);
    return { login: u.login, name: u.name || u.login };
  },

  async listRepos(token, { q = '', limit = 100 } = {}, fetchImpl) {
    const url = `${GITHUB_API}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`;
    const repos = await apiGet(url, ghHeaders(token), fetchImpl);
    const needle = q.trim().toLowerCase();
    return repos
      .filter(r => !needle || r.full_name.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(r => ({
        provider: 'github',
        full_name: r.full_name,
        url: r.html_url,
        private: !!r.private,
        description: r.description || '',
      }));
  },

  async listIssues(token, { repo, state = 'open', label = '', assignee = '', q = '', page = 1, perPage = 30 }, fetchImpl) {
    const params = new URLSearchParams({
      state: ghState(state),
      per_page: String(perPage),
      page: String(page),
      sort: 'updated',
      direction: 'desc',
    });
    if (label) params.set('labels', label);
    if (assignee) params.set('assignee', assignee);
    const url = `${GITHUB_API}/repos/${repo}/issues?${params.toString()}`;
    const raw = await apiGet(url, ghHeaders(token), fetchImpl);
    // The issues endpoint also returns pull requests — drop them.
    let issues = raw.filter(i => !i.pull_request).map(i => normalizeGithubIssue(repo, i));
    const needle = q.trim().toLowerCase();
    if (needle) {
      issues = issues.filter(i =>
        i.title.toLowerCase().includes(needle) || i.body.toLowerCase().includes(needle));
    }
    return issues;
  },

  async getIssue(token, { repo, number }, fetchImpl) {
    const issue = normalizeGithubIssue(repo,
      await apiGet(`${GITHUB_API}/repos/${repo}/issues/${number}`, ghHeaders(token), fetchImpl));
    let comments = [];
    try {
      const raw = await apiGet(
        `${GITHUB_API}/repos/${repo}/issues/${number}/comments?per_page=10`, ghHeaders(token), fetchImpl);
      comments = raw.map(c => ({ author: c.user?.login || null, body: c.body || '', created_at: c.created_at }));
    } catch {}
    return { ...issue, comments };
  },
};

// ── GitLab ────────────────────────────────────────────────────────────────────

function glHeaders(token) {
  // Bearer accepts both personal access tokens and OAuth tokens; PRIVATE-TOKEN
  // only accepts PATs. Bearer is the universal choice (works for `glab`'s OAuth
  // token and a pasted glpat-… alike).
  return { Authorization: `Bearer ${token}`, 'User-Agent': 'jonggrang' };
}

function glEnc(repo) {
  return encodeURIComponent(repo);
}

function glState(state) {
  if (state === 'closed') return 'closed';
  if (state === 'all') return null; // omit param → all
  return 'opened';
}

function normalizeGitlabIssue(repo, raw) {
  return {
    provider: 'gitlab',
    repo,
    number: raw.iid,
    title: raw.title || '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    labels: raw.labels || [],
    assignees: (raw.assignees || []).map(a => a.username).filter(Boolean),
    author: raw.author?.username || null,
    body: raw.description || '',
    body_preview: preview(raw.description),
    url: raw.web_url,
    updated_at: raw.updated_at || null,
    comments_count: raw.user_notes_count ?? 0,
  };
}

const gitlab = {
  async getViewer(token, fetchImpl) {
    const u = await apiGet(`${GITLAB_API}/user`, glHeaders(token), fetchImpl);
    return { login: u.username, name: u.name || u.username };
  },

  async listRepos(token, { q = '', limit = 100 } = {}, fetchImpl) {
    const params = new URLSearchParams({
      membership: 'true',
      per_page: '100',
      order_by: 'last_activity_at',
      with_issues_enabled: 'true',
    });
    if (q.trim()) params.set('search', q.trim());
    const projects = await apiGet(`${GITLAB_API}/projects?${params.toString()}`, glHeaders(token), fetchImpl);
    return projects.slice(0, limit).map(p => ({
      provider: 'gitlab',
      full_name: p.path_with_namespace,
      url: p.web_url,
      private: p.visibility !== 'public',
      description: p.description || '',
    }));
  },

  async listIssues(token, { repo, state = 'open', label = '', assignee = '', q = '', page = 1, perPage = 30 }, fetchImpl) {
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
      order_by: 'updated_at',
      sort: 'desc',
    });
    const st = glState(state);
    if (st) params.set('state', st);
    if (label) params.set('labels', label);
    if (assignee) params.set('assignee_username', assignee);
    if (q.trim()) params.set('search', q.trim());
    const url = `${GITLAB_API}/projects/${glEnc(repo)}/issues?${params.toString()}`;
    const raw = await apiGet(url, glHeaders(token), fetchImpl);
    return raw.map(i => normalizeGitlabIssue(repo, i));
  },

  async getIssue(token, { repo, number }, fetchImpl) {
    const issue = normalizeGitlabIssue(repo,
      await apiGet(`${GITLAB_API}/projects/${glEnc(repo)}/issues/${number}`, glHeaders(token), fetchImpl));
    let comments = [];
    try {
      const raw = await apiGet(
        `${GITLAB_API}/projects/${glEnc(repo)}/issues/${number}/notes?per_page=10&sort=asc&order_by=created_at`,
        glHeaders(token), fetchImpl);
      comments = raw.filter(n => !n.system)
        .map(n => ({ author: n.author?.username || null, body: n.body || '', created_at: n.created_at }));
    } catch {}
    return { ...issue, comments };
  },
};

const providers = { github, gitlab };

function getProvider(name) {
  const p = providers[name];
  if (!p) {
    const e = new Error(`Unknown provider: ${name}`);
    e.status = 400;
    throw e;
  }
  return p;
}

module.exports = {
  github,
  gitlab,
  getProvider,
  preview,
  // exported for tests
  normalizeGithubIssue,
  normalizeGitlabIssue,
};
