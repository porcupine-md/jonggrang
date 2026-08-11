---
feature: monorepo-sparse-checkout
branch: feat/monorepo-sparse-checkout
work_type: MEDIUM
description: Add monorepo support via git sparse-checkout so users can import only selected directories from a large repo, with a checkbox + directory picker in the web import flow.
created_at: 2026-06-10
status: implemented
issue: https://github.com/porcupine-md/jonggrang/issues/48
---

# Plan: Monorepo Support via Git Sparse-Checkout

## 1. Goal (from issue #48)

When importing a project from Git in the web dashboard, users should be able to:
1. Check a **"Monorepo (sparse checkout)"** checkbox
2. Once checked, a **directory picker** appears — listing all top-level directories from the repo
3. User selects one or more directories to check out
4. Clone is performed with `--filter=blob:none --sparse` + `git sparse-checkout set <dirs>`
5. Only the selected directories are checked out to disk — saving bandwidth and storage

## 2. Current State (verified)

### Backend — `apis/projects/projects.js`
- `runGitClone()` (line 33-52): plain `git clone --progress <url> <target>`, no sparse support
- `POST /projects/import` (line 62-138): accepts `source.type = git|local|fresh`, no monorepo fields
- Project record stores `lanes: { main: { ... } }` — single lane only

### Frontend — `client/src/views/ImportFlowView.vue`
- Step 1: source type picker (git/local/fresh), project name, git URL
- No monorepo checkbox, no directory picker
- `buildSource()` (line 119-123): returns `{ type: 'git', url }` — no sparse fields

### Detection — `lib/web-state.js`
- `detectStack()` (line 234-250): checks root `package.json`, `go.mod`, etc. — no workspace detection

### Worktrees — `lib/jonggrang.js`
- Worktree creation (line 1632-1656): standard `git worktree add`
- **Verified**: worktrees inherit sparse-checkout config from the parent repo automatically

## 3. Technical Validation (tested)

All steps below were tested in `/tmp/monorepo-test` against the `vercel/next.js` repo:

| Test | Result |
|------|--------|
| `git clone --filter=blob:none --sparse <url>` | OK — fast clone, metadata only |
| `git sparse-checkout init --cone` | OK |
| `git sparse-checkout set packages/next` | OK — only that directory appears on disk |
| `git sparse-checkout add packages/create-next-app` | OK — can add directories after initial set |
| `git sparse-checkout list` | OK — returns list of checked-out directories |
| `git config --get core.sparseCheckout` | `true` — can detect sparse mode programmatically |
| `git ls-tree --name-only -d HEAD` | OK — lists all dirs without checking them out (for picker) |
| `git ls-tree --name-only -d HEAD packages/` | OK — can list subdirectories too |
| `git worktree add ...` from sparse repo | OK — worktree inherits sparse config |
| Non-checked-out dirs (`packages/react-refresh`) | Not Found — expected behavior |

## 4. Implementation Plan

### Phase 1: Backend — New API endpoint to list directories

**File:** `apis/projects/projects.js`

Add a new endpoint `POST /api/projects/git-tree` that accepts a git URL + optional ref, performs a temporary bare/sparse clone, then returns the directory tree.

```
POST /api/projects/git-tree
Body: { url: string, ref?: string, depth?: number }
Response: { directories: string[] }
```

Implementation:
1. Clone to a temp dir with `git clone --filter=blob:none --sparse --no-checkout --depth=1 <url> <tmpDir>`
2. Run `git ls-tree --name-only -d HEAD` to list top-level dirs
3. Optional: if `depth > 1`, also list level 2 (`git ls-tree --name-only -d HEAD <dir>/`)
4. Return the result, clean up the temp dir

### Phase 2: Backend — Extend git clone to support sparse-checkout

**File:** `apis/projects/projects.js`

Modify `runGitClone()` and the `POST /projects/import` handler:

1. Extend the `source` schema for git type:
   ```javascript
   source: {
     type: 'git',
     url: string,
     ref?: string,
     sparse?: {
       enabled: boolean,
       directories: string[]   // e.g. ['packages/next', 'packages/shared']
     }
   }
   ```

2. Add a new function `runGitCloneSparse(url, ref, directories, targetPath, onProgress)`:
   ```
   git clone --filter=blob:none --sparse --progress <url> <target>
   cd <target>
   git sparse-checkout init --cone
   git sparse-checkout set <dir1> <dir2> ...
   ```

3. In the `POST /projects/import` handler, if `source.sparse?.enabled`, call `runGitCloneSparse` instead of `runGitClone`

4. Persist sparse config in the project record:
   ```javascript
   {
     ...project,
     source: { ...source, sparse: { enabled: true, directories: [...] } }
   }
   ```

### Phase 3: Backend — Detect monorepo workspace

**File:** `lib/web-state.js`

Extend `detectStack()`:

1. When sparse checkout is active, detect stack per checked-out directory (not root)
2. Add a `detectMonorepo()` helper:
   - Check `pnpm-workspace.yaml` → `workspace: { type: 'pnpm' }`
   - Check `package.json` `.workspaces` → `workspace: { type: 'yarn'|'npm' }`
   - Check `lerna.json` → `workspace: { type: 'lerna' }`
   - Return `{ is_monorepo: boolean, workspace_type: string, detected_stacks: [...] }`

### Phase 4: Frontend — Monorepo checkbox + directory picker

**File:** `client/src/views/ImportFlowView.vue`

1. Add new reactive state:
   ```javascript
   const isMonorepo = ref(false);
   const sparseDirectories = ref([]);         // selected directories
   const availableDirectories = ref([]);       // from git-tree API
   const loadingDirectories = ref(false);
   ```

2. Below the Git URL input, add a checkbox:
   ```html
   <div v-if="sourceType === 'git'" class="form-group">
     <label style="display:flex;align-items:center;gap:8px;">
       <input type="checkbox" v-model="isMonorepo" @change="onMonorepoToggle" />
       Monorepo — only check out selected directories (sparse checkout)
     </label>
   </div>
   ```

3. When the checkbox is checked and a valid URL is present, call `POST /api/projects/git-tree`:
   ```javascript
   async function onMonorepoToggle() {
     if (!isMonorepo.value || !gitUrl.value.trim()) return;
     loadingDirectories.value = true;
     const res = await fetch('/api/projects/git-tree', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ url: gitUrl.value.trim() }),
     });
     const data = await res.json();
     availableDirectories.value = data.directories;
     loadingDirectories.value = false;
   }
   ```

4. Show the directory picker (checkbox list):
   ```html
   <div v-if="isMonorepo && availableDirectories.length" class="form-group">
     <label>Select directories to check out</label>
     <div class="dir-picker">
       <label v-for="dir in availableDirectories" :key="dir" class="dir-option">
         <input type="checkbox" :value="dir" v-model="sparseDirectories" />
         {{ dir }}
       </label>
     </div>
   </div>
   ```

5. Update `buildSource()`:
   ```javascript
   function buildSource() {
     if (sourceType.value === 'git') {
       const src = { type: 'git', url: gitUrl.value.trim() };
       if (isMonorepo.value && sparseDirectories.value.length > 0) {
         src.sparse = { enabled: true, directories: [...sparseDirectories.value] };
       }
       return src;
     }
     // ... rest unchanged
   }
   ```

6. Update `canNext` computed:
   ```javascript
   const canNext = computed(() => {
     if (!name.value.trim()) return false;
     if (sourceType.value === 'git' && !gitUrl.value.trim()) return false;
     if (sourceType.value === 'git' && isMonorepo.value && sparseDirectories.value.length === 0) return false;
     // ... rest unchanged
   });
   ```

### Phase 5: Documentation

Per the CLAUDE.md checklist:

| Changed | Update |
|---------|--------|
| Config schema (source.sparse field) | `docs/CONFIG.md` |
| Import flow | `README.md` (if import section exists), `docs/QUICKSTART.md` |
| New git clone behavior | `docs/WORKFLOW.md` if relevant |

Add a section in README or docs explaining the monorepo workflow:
```markdown
### Monorepo Support

When importing from Git, check "Monorepo" to use sparse checkout.
Only selected directories will be cloned — saving bandwidth and disk space.

Manual workaround (CLI):
  git clone --filter=blob:none --sparse <url>
  cd <repo>
  git sparse-checkout init --cone
  git sparse-checkout set packages/my-app packages/shared
```

## 5. File Change Summary

| File | Change |
|------|--------|
| `apis/projects/projects.js` | Add `POST /git-tree` endpoint, add `runGitCloneSparse()`, extend import handler |
| `lib/web-state.js` | Extend `detectStack()` with monorepo detection |
| `client/src/views/ImportFlowView.vue` | Add monorepo checkbox, directory picker UI, update `buildSource()` |
| `client/src/stores/projects.js` | No change needed — `importProject()` already passes the source object as-is |
| `docs/CONFIG.md` | Document `source.sparse` schema |
| `README.md` or `docs/QUICKSTART.md` | Add monorepo section |

## 6. Edge Cases & Considerations

1. **Private repos** — the `git-tree` endpoint must handle auth failures gracefully (return error, not hang)
2. **Large repos with many top-level dirs** — the UI picker needs to be scrollable, possibly with search/filter
3. **Nested monorepos** — depth=1 is sufficient for most cases (packages/X); depth=2 can be optional
4. **Sparse + worktree compatibility** — already verified; worktrees inherit sparse config
5. **Existing project re-checkout** — extending to add/remove directories post-import can be a follow-up issue
6. **Timeout on git-tree** — the temporary clone for listing dirs must have a timeout (30s max)
7. **Temp dir cleanup** — ensure the temp dir is always cleaned up even if the request aborts or errors

## 7. Execution Order

```
Phase 1 (backend: git-tree API)
    ↓
Phase 2 (backend: sparse clone)
    ↓
Phase 3 (backend: monorepo detection)
    ↓
Phase 4 (frontend: UI)
    ↓
Phase 5 (docs)
```

Phases 1-3 should be done sequentially as they depend on each other.
Phase 4 requires Phase 1 (git-tree API) to be completed first.
Phase 5 comes after all implementation is done.
