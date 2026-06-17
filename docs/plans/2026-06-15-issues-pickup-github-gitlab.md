---
feature: issues-pickup
branch: feat/issuespickup
work_type: LARGE
description: Add an "Issues" top-level menu to the web dashboard that lists GitHub & GitLab issues from user-selected repositories (reusing the existing GH_TOKEN/GITLAB_TOKEN PATs), with list + filter + detail views, and a "Pickup → Plan" action that pre-fills the normal New Plan form (per-project) so the existing generate → revise → approve UX is unchanged.
created_at: 2026-06-15
status: implemented
---

# Plan: "Issues" import / pickup workflow (GitHub + GitLab)

Implements GitHub issue **#55** — *Add 'Issues' import/pickup workflow for GitHub and GitLab issues*.

## 1. Goal (in the user's words)

- New top-level **"Issues"** menu that lists remote issues from connected GitHub & GitLab repos (title, repo, number, labels, assignee, state, body preview, link). Supports filtering (repo, label, state, assigned-to-me) and search, plus a detail view (full body + comments preview + link back).
- **"Pickup → Plan"** from the list or detail view, with **New Project** (launch wizard, then pickup into it) and **Existing Project** (project selector) flows.
- The created plan should reference the source issue (repo, number, URL) and preserve labels/assignees where possible.
- Persist a mapping between the imported issue and the created plan; surface a link to the original issue on the plan card.
- Connect accounts via UI (PAT), respecting token permissions. CLI helpers and one-way sync are *desirable but optional*.

## 2. Decisions (confirmed in discussion, 2026-06-15)

| Question | Decision |
|---|---|
| **Authentication** | **Reuse the existing PAT infrastructure** (`GH_TOKEN` / `GITLAB_TOKEN` already stored via `GET/PUT /api/settings/git-tokens`, see §3). **Add a repo picker** so the user chooses which repos/orgs to list issues from. No OAuth flow in this iteration. |
| **Issue fetching** | **Native `fetch` against the GitHub/GitLab REST APIs** using the stored PATs. No new npm dependency (no octokit/axios); the repo has none today and Node 18+ `fetch` is global. (Not the `gh`/`glab` CLIs — those may be absent on host/in container.) |
| **Pickup → Plan behaviour** | **No UX change to plan creation.** Pickup **pre-fills the existing "New Plan" form** (the description textarea in `PlanView`) with the issue title/body + a source-issue reference. The user then runs the normal generate → revise → approve flow. We do **not** write a custom `plan.md` directly and do **not** auto-invoke the planner — only the form arrives pre-populated. |
| **Issue→plan linking** | Embed a machine-readable source marker in the pre-filled description (survives AI generation) **and** persist a pickup mapping in web-state. The plans-list endpoint parses the marker so the plan card can show a "↗ owner/repo#55" link. |
| **Menu scope** | **Top-level app nav** (`App.vue`), alongside `projects` / `secrets` / `settings` — issues span repos, not a single project. |
| **Sync & CLI helpers** | **Stretch / optional** (Phase E). Core deliverable is browse + pickup + link. |

## 3. Current state (verified)

**Backend**
- **Route mounting**: `server.js:96` mounts `require('./apis/projects')`; `apis/projects/index.js:230-255` mounts each sub-router. New routers register here. Endpoint files export `module.exports = function(deps){ const router = Router(); …; return router; }` (`apis/projects/plan.js:11-14`). `deps` provides `{ fs, path, webState, io, orchestration, spawnForProject, … }`.
- **Plan creation (reused as-is)**: `POST /api/projects/:id/plan` (`apis/projects/plan.js:209`) takes `{ description, deep, tool, model, effort }` and runs `jonggrang plan <description>`. `GET /api/projects/:id/plans` (`plan.js:28`) lists draft + archived plans, returning `{ id, feature_id, title, status, mtime, content, work_type, branch, run_status, pushed }`.
- **Plan frontmatter**: `feature`, `branch`, `work_type`, `description`, `created_at` (`lib/jonggrang.js:522-529`); parsed by `parsePlanFrontmatter` (`lib/jonggrang.js:1660-1670`).
- **Auth already exists**: `GET /api/settings/git-tokens` returns `{ has_gh, has_gitlab }` (values never exposed); `PUT` accepts `{ GH_TOKEN, GITLAB_TOKEN }` (`apis/projects/workspace.js:53-58`, mounted at `/api`). Stored in `~/.jonggrang/web/index.json.git_tokens` via `getGitTokens`/`setGitTokens` (`lib/web-state.js:165-183`).
- **Persistence layer**: `lib/web-state.js` owns `~/.jonggrang/web/index.json` (`{ version, workspace_path, projects, git_tokens }`). New global state (selected issue-source repos, issue→plan mappings) lives here with matching `load/save` helpers. `generateId(prefix)` mints ids.
- **Project creation**: `POST /api/projects/import` (`apis/projects/projects.js:62-138`) takes `{ name, source }`, returns **202**, clones/inits in the background, emits `import.progress` / `import.done` / `import.error` socket events, sets `init_status`.
- **Socket events**: flat `domain.action` namespace, broadcast to room `project:${projectId}` (`apis/projects/index.js:75-145`). Client subscribes via `subscribe({ project_id })`.
- **Dependencies**: `package.json` has **no** HTTP client (no `octokit`/`axios`/`node-fetch`). Native `fetch` is used.

**Frontend** (`client/`)
- **Top-level nav**: `client/src/App.vue:4-12` — `projects` / `secrets` / `settings` `<RouterLink>`s. New "Issues" item goes here.
- **Router**: `client/src/router/index.js:1-42` — `/` (ProjectListView), `/import` (ImportFlowView), `/projects/:id/*`, `/settings` (SettingsView), `/secrets`. New `/issues` route added here.
- **Project wizard**: `/import` → `ImportFlowView.vue`; `stores/projects.js:36-48` `importProject(name, source)` POSTs `/api/projects/import` then `fetchAll()`.
- **Plan form (pre-fill target)**: `client/src/components/plan/PlanView.vue` — idle/“+ New” form has a description `<Textarea>` and `generatePlan()` posting `{ description, deep, tool, model, effort }`. **This is the field pickup pre-fills.**
- **Global tokens UI already present**: `client/src/views/SettingsView.vue:139-142` shows GitHub/GitLab token inputs with `has_gh`/`has_gitlab` indicators; `:224-235` GET/PUT `/api/settings/git-tokens`. The repo-picker section is added here (or in a new Issues-settings sub-view).
- **API layer**: stores call `window.fetch('/api/…')` directly; or components use `composables/useJonggrangApi.js` (`requestJson`). Pinia stores follow `defineStore('name', () => { refs + async actions; return … })`.
- **Styling**: PrimeVue 4.5 (Aura + custom `JonggrangPreset`), `lucide-vue-next` + `primeicons`, `--jg-*` CSS vars. Reusable: `BaseModal.vue`, `TaskDetailDrawer.vue`, `Dialog`, `Tag`, `Button`, `Select`, `Textarea`.

## 4. Target design

### 4.1 Data model (web-state, `~/.jonggrang/web/index.json`)

Add two top-level keys (with `getIssueSources`/`setIssueSources`, `getIssuePickups`/`addIssuePickup` helpers in `lib/web-state.js`):

```jsonc
{
  // existing: version, workspace_path, projects, git_tokens …
  "issue_sources": {
    "github": ["owner/repo", "org/another"],     // full_name slugs the user selected
    "gitlab": ["group/project", "group/sub/proj"] // url-encoded path on use
  },
  "issue_pickups": [
    {
      "id": "pickup_<hex>",
      "provider": "github",                 // github | gitlab
      "repo": "owner/repo",
      "number": 55,
      "url": "https://github.com/owner/repo/issues/55",
      "title": "…",
      "labels": ["enhancement"],
      "assignees": ["alice"],
      "project_id": "proj_…",               // set once target project is known
      "feature_id": null,                   // reconciled when a plan with the marker appears
      "imported_at": "2026-06-15T…Z",
      "synced_at": null
    }
  ]
}
```

### 4.2 Source marker (issue→plan link that survives AI generation)

Pickup appends to the pre-filled description a human-readable reference **and** a hidden marker:

```
<!-- jonggrang-source: github owner/repo#55 -->

> Imported from issue [owner/repo#55](https://github.com/owner/repo/issues/55)
> Labels: enhancement · Assignee: alice

<original issue body…>
```

`GET /api/projects/:id/plans` scans each `plan.md` for `jonggrang-source:` and, if found, adds `source_issue: { provider, repo, number, url }` to that plan's object. `PlanView` renders it as a "↗ owner/repo#55" link badge on the plan row/card. (Robust because the marker lives in plan content regardless of what the planner rewrites.)

### 4.3 New backend API (`apis/issues.js`, mounted at `/api`)

| Method & path | Purpose |
|---|---|
| `GET /api/issues/connections` | `{ has_gh, has_gitlab }` (delegates to existing git-tokens) + current `issue_sources`. |
| `GET /api/issues/repos?provider=&q=` | List repos the PAT can access (for the **repo picker**). GitHub: `GET /user/repos?affiliation=…` (+ `/search/repositories` when `q`). GitLab: `GET /projects?membership=true&search=`. Returns `[{ full_name, url, private }]`. |
| `PUT /api/issues/sources` | Persist selected repos `{ github:[…], gitlab:[…] }` to `issue_sources`. |
| `GET /api/issues?provider=&repo=&state=&label=&assignee=&q=&page=` | List issues from one selected repo (proxy + short in-memory TTL cache). Normalizes GitHub & GitLab into one shape `{ provider, repo, number, title, state, labels[], assignees[], author, body_preview, url, updated_at, comments }`. Filters `assigned-to-me` via the token's identity. |
| `GET /api/issues/detail?provider=&repo=&number=` | Full body + first N comments + url. |
| `POST /api/issues/pickup` | Body `{ provider, repo, number, project_id? }`. Builds the pre-fill description (§4.2), records an `issue_pickups` entry, returns `{ pickup_id, project_id?, description, source }`. For "new project" the client calls this **after** the project import completes (so `project_id` is set). |

Implementation notes: a small `lib/issue-providers.js` with `listRepos`, `listIssues`, `getIssue` per provider; GitHub base `https://api.github.com` (header `Authorization: Bearer <GH_TOKEN>`), GitLab base `https://gitlab.com/api/v4` (header `PRIVATE-TOKEN: <GITLAB_TOKEN>`; project path URL-encoded). Map errors to `{ error: { code, message } }`; surface 401/403 as "token missing/insufficient". Cache list responses ~60s keyed by query to keep the UI responsive (issue #55 "cache results per-user/project").

### 4.4 New frontend

- **Route + nav**: `/issues` → `IssuesView.vue`; add `<RouterLink to="/issues">issues</RouterLink>` in `App.vue:9-11`.
- **`stores/issues.js`** (Pinia): `connections`, `sources`, `repos`, `issues`, `filters`, `selectedIssue`; actions `fetchConnections`, `searchRepos`, `saveSources`, `fetchIssues`, `fetchDetail`, `pickup(provider, repo, number, target)`. Direct `fetch('/api/issues/…')`.
- **`stores/pickup.js`** (tiny transport store): holds `{ projectId, description, source }` across navigation. `PlanView` reads it on mount; if it targets the current project, it opens the New-Plan form **pre-filled** then clears the store. (Avoids putting a large issue body in the URL.)
- **`IssuesView.vue`**: header with provider/repo/state/label/assignee filters + search box; list of issue rows (Tag badges for state/labels, repo#number, assignee, body preview, external link). Empty/disconnected state links to Settings when `!has_gh && !has_gitlab`. Row click → detail.
- **`components/issues/IssueDetailDrawer.vue`** (pattern from `TaskDetailDrawer.vue`): full body (markdown), comments preview, link back, and the **Pickup → Plan** button → opens `PickupModal`.
- **`components/issues/PickupModal.vue`** (pattern from `BaseModal`): choose **Existing Project** (project `<Select>` from `projects` store) or **New Project**.
  - *Existing*: `pickup(…, {project_id})` → set `pickup` store → `router.push('/projects/:id/plan')`.
  - *New*: set a pending pickup (no project_id) in `pickup` store → `router.push('/import')`. On import success (`import.done`), `ImportFlowView` finalizes the pickup with the new `project_id` and navigates to its plan view.
- **`PlanView.vue`**: on mount, consume `pickup` store → open the New-Plan form with description pre-filled (existing `generatePlan()` path unchanged). Render the `source_issue` link badge per plan row using the new field from `GET /:id/plans`.
- **Repo-picker UI**: a section in `SettingsView.vue` (under the existing Git tokens block) — search repos via `GET /api/issues/repos`, multi-select, save via `PUT /api/issues/sources`. Reuses the token "● set / not set" indicators already there.

## 5. Implementation tasks

### Phase A — web-state + provider lib
- [ ] **A1** `lib/web-state.js`: add `issue_sources` + `issue_pickups` to the index shape; add `getIssueSources/setIssueSources`, `getIssuePickups/addIssuePickup/updateIssuePickup`. Reuse `getGitTokens()` for credentials (do not duplicate token storage).
- [ ] **A2** `lib/issue-providers.js`: `listRepos`, `listIssues`, `getIssue` for GitHub & GitLab via native `fetch`; normalize to the shared issue shape; map 401/403/404 to typed errors; identity lookup (`/user`, `/user`) for `assigned-to-me`.

### Phase B — Issues API
- [ ] **B1** `apis/issues.js` with the endpoints in §4.3; add a ~60s in-memory TTL cache for list/detail. Register it in `apis/projects/index.js` (`app.use('/api', require('../issues')(deps))`).
- [ ] **B2** `apis/issues.js` `POST /pickup`: build the marker + reference description (§4.2), persist `issue_pickups`, return prefill payload.
- [ ] **B3** `apis/projects/plan.js` `GET /:id/plans`: parse the `jonggrang-source:` marker from each plan's content and attach `source_issue`. (Also reconcile `issue_pickups[].feature_id` when a matching marker is found — enables later sync.)

### Phase C — Frontend browse
- [ ] **C1** `client/src/router/index.js`: add `/issues`; `App.vue`: add the Issues nav link.
- [ ] **C2** `stores/issues.js` + `IssuesView.vue` (filters, search, list, disconnected state).
- [ ] **C3** `components/issues/IssueDetailDrawer.vue` (full body, comments, link back).
- [ ] **C4** `SettingsView.vue`: repo-picker section (search + multi-select + save to `issue_sources`).

### Phase D — Pickup → Plan
- [ ] **D1** `stores/pickup.js` (cross-navigation prefill transport).
- [ ] **D2** `components/issues/PickupModal.vue` (Existing vs New Project flows).
- [ ] **D3** `PlanView.vue`: consume the pickup prefill into the New-Plan form (no other UX change); render the `source_issue` link badge per plan.
- [ ] **D4** `ImportFlowView.vue`: on `import.done`, if a pending pickup exists, finalize it (`POST /pickup` with the new `project_id`) and route to that project's plan view.

### Phase E — Sync + CLI (optional / stretch)
- [ ] **E1** `GET /api/issues/sync` or per-plan re-sync: re-fetch issue state; mark plan card when the remote issue is closed; manual "re-sync" button. Updates `issue_pickups[].synced_at`.
- [ ] **E2** CLI helpers: `jonggrang issues list` / `jonggrang issues pickup <ref>` (`bin/` + `lib/jonggrang.js`).

### Phase F — Docs + tests + verification (per CLAUDE.md iron rule)
- [ ] **F1** `docs/UI.md`: new Issues menu, `/issues` route, pickup flow, repo picker.
- [ ] **F2** `docs/CONFIG.md`: `issue_sources` / `issue_pickups` schema + that PATs are reused from git-tokens.
- [ ] **F3** `docs/JONGGRANG.md`: web-dashboard section — Issues browse + pickup; `README.md` if the menu list / requirements change. `docs/WORKFLOW.md` only if the plan-creation flow text needs the "pre-filled from issue" note. Update `bin/` command table + `docs/QUICKSTART.md`/`EXAMPLE.md` **only if** Phase E CLI ships.
- [ ] **F4** Tests: `lib/issue-providers.js` normalization (mocked `fetch`), `POST /pickup` marker/description building, `GET /:id/plans` marker parsing → `source_issue`.
- [ ] **F5** Manual verification: set a PAT in Settings → pick repos → Issues list shows issues with filters/search → open detail → Pickup into existing project (form arrives pre-filled, generate→approve normally, plan card shows ↗ link) → Pickup into new project (wizard → import → plan view pre-filled).

## 6. Non-goals / unchanged

- **No change to plan generation UX** — pickup only pre-fills the existing New-Plan form; `POST /:id/plan` and the generate→revise→approve pipeline are untouched.
- **No OAuth** this iteration — PAT only (reuse `GH_TOKEN`/`GITLAB_TOKEN`).
- **No new npm dependency** — native `fetch`, no octokit/axios.
- **No write-back to remote issues** (no commenting/closing the GitHub/GitLab issue from Jonggrang).
- Orchestration, sandbox, worktree, and task mechanics are unaffected.

## 7. Risks / notes

- **Token scope / rate limits**: a PAT may lack access to some selected repos, or hit rate limits. Surface 401/403 clearly and degrade gracefully (skip the repo, show a per-repo error chip). Honor `assigned-to-me` only when `/user` identity resolves.
- **GitLab project addressing**: GitLab needs the URL-encoded project path (`group%2Fproject`) and uses `PRIVATE-TOKEN`, not `Bearer`. Keep provider differences isolated in `lib/issue-providers.js`.
- **Prefill transport**: issue bodies can be large — use the `pickup` Pinia store (not the URL/query string). Clear it after consumption so a stale prefill doesn't leak into the next plan.
- **New-project timing**: import is async (202 + `import.done`). The pickup must finalize **after** `import.done`, else `project_id` is unknown. Handle import failure (drop the pending pickup, show error).
- **Marker robustness**: the link depends on the `jonggrang-source:` comment surviving into the generated `plan.md`. The planner could strip HTML comments — mitigate by also keeping the visible `> Imported from issue …` reference line and reconciling via the persisted `issue_pickups` mapping (project_id + recency) as a fallback.
- **Caching staleness**: a 60s TTL can show stale issue state; provide a manual "Refresh" in `IssuesView`.
