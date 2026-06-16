---
feature: output-file-manifest
branch: feat/output-file-manifest
work_type: MEDIUM
description: Track output files per feature in MANIFEST.yaml (grouped per phase) and expose a CLI to inspect them. Issue #50.
created_at: 2026-06-11
status: draft
github_issue: 50
related_comment: 4687060491
---

# Plan: Output File Manifest per Feature

## 1. Goal (in the user's words, from issue #50)

> Track output files per feature with `MANIFEST.yml` and provide CLI to inspect manifest.

Concretely, after running a plan:
- Every output file produced by every phase (code, logs, reports, structured output JSON) is recorded in `MANIFEST.yaml` at `.jonggrang/.output/features/<feature_id>/MANIFEST.yaml`.
- Records are **grouped per phase** in `phases[phaseNum].output_files[]`, not a flat list.
- A new CLI `jonggrang manifest` lets users inspect the manifest for any feature — view per phase, list all files, summary counts, raw JSON.
- Documentation covers both the new schema and CLI usage.
- **No backfill** — only features created from this PR onward have `output_files[]`. Existing features keep their manifests as-is.

## 2. Decisions (confirmed in issue #50 discussion, 2026-06-11)

| Question | Decision |
|---|---|
| File extension | **`.yaml`** (consistent with existing `MANIFEST.yaml`; issue body said `.yml` — sync note added below) |
| Grouping | **Per phase**, in `phases[phaseNum].output_files[]` (sibling of existing `phases[phaseNum].output`) |
| Backfill | **None** — only new features get `output_files` tracking |
| Per-file metadata | **Yes** — per-entry in `output_files[]`: `path`, `type`, `size`, `created_at`, optional `agent_id`, `task_id` |
| Path relativity | **Relative to project root** (consistent with `agents[].locked_files`); CLI `--absolute` flag resolves to absolute |
| Type enum | **`code \| log \| report \| output`** — bounded but permissive: unknown types stored as-is, no error |
| Auto-detect method (iter 1) | **Agent-side emission**: agents emit `OUTPUT_FILES:` block in their final output; parser populates `output_files[]` |
| Auto-detect method (iter 2, conditional) | **Chokidar watch** as safety net for files written without explicit emission (only if iter 1 leaves gaps) |
| Scope of iter 1 | **3 phases**: 8 (Implementation), 11 (Code Quality Review), 14 (Testing) — 3 roles, 2 surfaces (project root + `.output/features/<id>/`), validates the pattern is general |
| Phase 9 (Simplify) | **Excluded from iter 1** — already has `getChangedFilesForSimplify` + `planSimplify` (git-diff-based). Will integrate in iter 2 by composing the existing tracker with `output_files[]`. |

## 3. Current state (verified)

### Existing MANIFEST schema

`lib/orchestration.js:154-184` (`createManifest`) — relevant fields:

```js
manifest = {
  feature_id, description, work_type, created_at, updated_at,
  status, current_phase, active_phases,
  phases: {
    [phaseNum]: {
      name, status,            // pending | running | completed | skipped | failed
      started_at, completed_at,
      agent_id,
      output: null,             // currently: single metadata object per phase
    }
  },
  agents: {                     // per agent run
    [agentId]: {
      role, status, started_at, output_path, locked_files, completed_at
    }
  },
  validation: { review_passed, tests_passed, coverage_met },
  locks: [], context_usage: null,
}
```

Field `agents[].output_path` exists but is **never populated** by current code — a latent bug we can clean up at the same time.

### Existing output directory convention

Per skill `skills/core/persisting-agent-outputs/SKILL.md`:
- Output JSON per role: `.jonggrang/.output/features/{feature_id}/{phase}-{role}-output.json`
- Header schema: `{ jonggrang-output: true, feature_id, phase, role, task_id, agent_id, timestamp, status, output: {...} }`

This convention is **in addition** to the new `output_files[]` — they're complementary, not conflicting. `output_files[]` tracks **all files** (including the role-output JSON itself), while the role JSON is the structured payload convention for downstream parsing.

### Hooks landscape

`hooks/` has 3 subdirs: `claude/` (shell scripts + `settings.json`), `opencode/` (`plugin.js`), `pi/` (`jonggrang-extension.ts`). All hooks must be updated in parallel to keep parity across the three agent backends.

### Pattern reuse — `getChangedFilesForSimplify`

`lib/orchestration.js` (around `:300-380`) already implements:
- `git diff --name-only --diff-filter=d HEAD` for tracked changes
- `git ls-files --others --exclude-standard` for untracked files
- Excludes `.jonggrang/`, `.opencode/`, `.claude/`, `.codex/`, `hooks/`, `AGENTS.md`, `CLAUDE.md`
- Fallback: reads `agents[].locked_files` from manifest

This is the model for iter 2 (chokidar / git-based) but **not used in iter 1** — iter 1 relies on agent cooperation.

### `.output/features/` is git-tracked

`bin/jonggrang.js:cmdInit` explicitly does NOT add `.jonggrang/.output/` to `.gitignore` — plans + manifests are committed and travel with each plan's branch. So `output_files[]` entries should use **paths that are stable and commit-worthy** (not absolute paths or temp files).

### Deps

`chokidar` already in `package.json` (used elsewhere) — no new deps for iter 1; iter 2 (chokidar) reuses this.

### CLI commands existing

`init`, `plan`, `approve`, `work`, `status`, `review`, `orchestrate`, `bug`, `web`, `menu`. `status` already reads manifest but does not expose `output_files[]`. New `manifest` subcommand slots in cleanly.

## 4. Target schema

### MANIFEST.yaml diff (additive, non-breaking)

```yaml
feature_id: auth-feature-abc123
description: ...
phases:
  8:
    name: implementation
    status: completed
    started_at: 2026-06-11T10:00:00Z
    completed_at: 2026-06-11T10:23:45Z
    agent_id: developer-auth-001
    output:                              # existing, unchanged
      source: work-loop
    output_files:                        # NEW
      - path: src/auth.ts
        type: code
        size: 4287
        created_at: 2026-06-11T10:23:45Z
        agent_id: developer-auth-001
        task_id: task-003
      - path: src/auth.test.ts
        type: code
        size: 2103
        created_at: 2026-06-11T10:24:12Z
        agent_id: developer-auth-001
        task_id: task-003
  11:
    name: code-quality
    status: completed
    ...
    output_files:
      - path: .jonggrang/.output/features/auth-feature-abc123/11-reviewer-code-quality.json
        type: report
        size: 1820
        created_at: 2026-06-11T11:05:00Z
        agent_id: reviewer-auth-001
  14:
    name: testing
    ...
    output_files:
      - path: .jonggrang/.output/features/auth-feature-abc123/14-tester-results.json
        type: report
        size: 945
        created_at: 2026-06-11T12:30:00Z
        agent_id: tester-auth-001
      - path: tests/integration/auth.test.ts
        type: code
        size: 3301
        created_at: 2026-06-11T12:28:00Z
        agent_id: tester-auth-001
```

### Field spec for `output_files[]` entries

| Field | Required | Type | Notes |
|---|---|---|---|
| `path` | yes | string | Relative to project root. For files in `.jonggrang/`, use the full `.jonggrang/...` path. |
| `type` | yes | enum string | One of `code`, `log`, `report`, `output`. Unknown values stored as-is. |
| `size` | yes | integer | Bytes. Auto-filled by parser via `fs.statSync(absPath).size` if agent omits. `null` if file no longer exists at parse time. |
| `created_at` | yes | ISO8601 string | Best-effort from agent; fallback to `fs.statSync(absPath).mtime.toISOString()`. |
| `agent_id` | no | string | Only meaningful when phase has multiple agents. |
| `task_id` | no | string | Only meaningful for phase 8 (Implementation) where tasks produce files. |

### Agent emission format

In the agent's final output (text/stdout), emit a fenced YAML block:

```yaml
OUTPUT_FILES:
  - path: src/auth.ts
    type: code
  - path: src/auth.test.ts
    type: code
  - path: .jonggrang/.output/features/auth-feature-abc123/11-reviewer-code-quality.json
    type: report
```

- `OUTPUT_FILES:` header on its own line
- List of `- path: ...` immediately after
- `type` is optional; default = `output`
- `size` and `created_at` always filled by parser (never trust agent)
- Block can appear anywhere in agent output; parser scans all stdout/stderr
- Multiple blocks per phase: entries are merged (idempotent on `path` — last write wins)

## 5. CLI surface

New subcommand `cmdManifest` in `bin/jonggrang.js`:

```bash
jonggrang manifest                          # show active/last feature (full tree)
jonggrang manifest --feature <id>           # show specific feature
jonggrang manifest --list                   # list all features + summary
jonggrang manifest --feature <id> --phase 8 # filter per phase
jonggrang manifest --feature <id> --files   # flat file list, lintas phase
jonggrang manifest --feature <id> --summary # counts only (file per phase)
jonggrang manifest --feature <id> --json    # raw output (for piping)
jonggrang manifest --feature <id> --absolute # resolve paths to absolute
jonggrang manifest --feature <id> --type code # filter by type (iter 1: exact match)
```

Default behavior (no args): use `orchestration.findIncompleteManifest` (already exists) — if found, show that; else `listManifests[0]` (most recent).

Output formats:
- Default: human-readable tree, grouped by phase, with `[type]` tag and size
- `--json`: full JSON object
- `--files`: flat list `path | type | size | phase` (TSV-like for grep/jq)
- `--summary`: 2-column table `phase | file count`

Error handling:
- Feature not found → exit 1 with `logError` + list of available features
- Manifest corrupted / not parseable → exit 1 with parse error + path
- Phase filter with no files in that phase → empty result, not error

## 6. Implementation tasks

Tasks are ordered to enable incremental testing. Each ends with a verifiable artifact.

### Phase A — Core schema and helpers (`lib/orchestration.js`)

- [ ] **A1** `createManifest` — initialize `output_files: []` for every phase entry (in the `for (const phaseNum of activePhases)` loop, alongside existing fields).
- [ ] **A2** New helper `addOutputFile(manifestPath, phaseNum, fileEntry)`:
  - Read manifest via existing `readManifest`
  - Validate `phaseNum` exists in `manifest.phases`; throw with clear message if not
  - Validate `fileEntry.path` is non-empty string; throw if not
  - Resolve absolute path via `path.resolve(projectRoot, fileEntry.path)`; call `fs.statSync` to get `size` and `created_at` (fall back to `null` for missing file)
  - Normalize `type` (default `output` if missing/empty)
  - Idempotent on `path`: if existing entry with same `path` exists in this phase, replace it (don't duplicate)
  - Update `manifest.updated_at`, write via `writeManifest`
  - Return the new entry (with size/created_at filled)
- [ ] **A3** New helper `addOutputFiles(manifestPath, phaseNum, fileEntries)` — bulk version, calls `addOutputFile` in a loop, returns array of new entries.
- [ ] **A4** Extend `completePhase(manifestPath, phaseNum, output = null, outputFiles = null)`:
  - Accept new optional 4th arg `outputFiles: []`
  - If provided, call `addOutputFiles` after marking phase complete
  - **Backward compat**: existing 3-arg calls (no `outputFiles`) keep working unchanged
- [ ] **A5** Add JSDoc on `registerAgent` noting that the `outputPath` arg is **deprecated** in favor of `addOutputFile` (don't remove the field — it's used by existing `output_path` reads elsewhere if any; mark deprecated).
- [ ] **A6** Export new helpers from `module.exports` at bottom of file.

### Phase B — Agent output parser (`lib/output-parser.js`, new)

- [ ] **B1** New module exporting `parseOutputFiles(stdout, stderr) → Array<{path, type?}>`:
  - Scan both stdout and stderr (concat, dedup later)
  - Regex match YAML fence or plain `OUTPUT_FILES:` block: ```/^OUTPUT_FILES:\s*\n((?:[ \t]+-[ \t].*\n?)+)/gm```
  - Per match: parse the lines as YAML mini-doc (or simple line-by-line `path: ... / type: ...` parser to avoid full YAML dep risk)
  - Strip code-fence wrappers (```) if present
  - Return flat array of `{ path, type? }`; deduplicate on `path` (keep first occurrence)
- [ ] **B2** Export `OUTPUT_FILES_HEADER = 'OUTPUT_FILES:'` constant for use in prompt builders.
- [ ] **B3** Unit test in `test/`: feed sample agent outputs, assert correct entries returned; assert no match for inputs without the block; assert dedup behavior.

### Phase C — Prompt builders (`lib/jonggrang.js`)

For each of the 3 roles, append an `OUTPUT_FILES:` instruction block to the existing prompt.

- [ ] **C1** `buildWorkPrompt` (phase 8, Developer) — after step 8 (commit), before closing:
  ```
  ## Output File Tracking

  Before finishing, list every file you created or modified during this task.
  Emit a YAML block in your final output, like this:

  ```yaml
  OUTPUT_FILES:
    - path: src/auth.ts
      type: code
    - path: tests/auth.test.ts
      type: code
  ```

  Paths must be relative to the project root. Use `type: code` for source files,
  `type: log` for logs, `type: report` for analysis, `type: output` for everything
  else. The orchestrator parses this block — files not listed are not tracked.
  ```
- [ ] **C2** `buildReviewPrompt` (phase 11, Reviewer) — append similar block, with guidance:
  - For the review report file (already written to `.output/features/<id>/11-reviewer-code-quality.json` per skill), include it as `type: report`
  - For any new files created (e.g., a refactor suggestion file), include them as `type: code` or `type: output` as appropriate
- [ ] **C3** New `buildTestPrompt` (phase 14, Tester) — extracted as a function (currently may be inlined or absent). Append OUTPUT_FILES block. Guidance:
  - Test result JSON (already written per skill) → `type: report`
  - Test source files created/modified → `type: code`
- [ ] **C4** Verify each prompt's existing format/style is preserved; only append, don't restructure.

### Phase D — Hook integration (capture OUTPUT_FILES from agent streams)

- [ ] **D1** `hooks/claude/output-manifest.sh` (new):
  - Accept agent run output from stdin (or temp file)
  - Call `node -e` inline with the parser: `require('./lib/output-parser').parseOutputFiles(...)`
  - Or: shell out to a small node script `hooks/_lib/capture-output-files.js` (preferred — easier to test)
  - Output: JSON array to stdout
  - The hook integrates with the existing `settings.json` event flow (consult `hooks/claude/settings.json` for the right event name; the project uses `PostToolUse` or similar — verify and document)
- [ ] **D2** `hooks/opencode/plugin.js` — add equivalent capture (this file is JS, so just call `parseOutputFiles` directly)
- [ ] **D3** `hooks/pi/jonggrang-extension.ts` — add equivalent capture (TypeScript, imports the JS module via `require`)
- [ ] **D4** Each hook writes captured entries back to the manifest. Mechanism options:
  - **Option A (preferred)**: hook calls a `bin/jonggrang` subcommand (e.g., `jonggrang manifest add --feature <id> --phase <n> --files <json>`)
  - **Option B**: hook writes directly to MANIFEST.yaml via `lib/orchestration.addOutputFiles` (Node only — claude shell hook needs Option A or a separate node script)
  - **Decision**: go with **Option A** — exposes the write path as a stable CLI for external scripts to use, decouples hooks from internal API.
- [ ] **D5** New CLI subcommand `jonggrang manifest add` (technically under `cmdManifest` but exposed separately for hook use):
  ```
  jonggrang manifest add --feature <id> --phase <n> --files '<json array of {path, type?}>'
  ```
  - Resolves paths via `path.resolve(PROJECT_ROOT, fileEntry.path)` to fill `size` and `created_at`
  - Calls `lib/orchestration.addOutputFiles`
  - Quiet by default; `--verbose` for debug
  - Exit 0 on success, exit 1 on validation error (prints to stderr)

### Phase E — CLI command (`bin/jonggrang.js`)

- [ ] **E1** New `cmdManifest(args)` function — see §5 for full spec.
  - No args → use `findIncompleteManifest` or fall back to most recent
  - `--feature <id>` → look up specific feature
  - `--list` → iterate `.jonggrang/.output/features/*/MANIFEST.yaml`, print id + work_type + status + file count
  - `--phase <n>` → filter output
  - `--files` → flat list mode
  - `--summary` → counts only
  - `--json` → raw JSON
  - `--absolute` → resolve `path` to absolute in output
  - `--type <type>` → filter by `type` (exact match)
- [ ] **E2** Register `manifest` in the CLI arg parser (search for `case 'status'` / `case 'work'` to find the right block; add `case 'manifest':`).
- [ ] **E3** Add to interactive menu (`cmdMenuClack` options array, in logical position between `status` and `review`).
- [ ] **E4** Add `manifest` row to `README.md` "Commands at a Glance" table — short description: "Inspect MANIFEST output files for a feature".
- [ ] **E5** Update help text (`cmdHelp` or equivalent) to include `manifest` and `manifest add`.

### Phase F — Documentation

- [ ] **F1** `docs/CONFIG.md` (around `:314` "MANIFEST.yaml" section) — add `output_files` field to the schema reference, with field spec table from §4.
- [ ] **F2** `docs/ORCHESTRATION.md` (after line 313 "MANIFEST.yaml — Persistent State") — new section "Output File Tracking" with:
  - Why: traceability, debugging, post-mortem analysis
  - How: agent emits `OUTPUT_FILES:` block, parser populates manifest
  - Schema: paste example from §4
  - CLI usage: paste examples from §5
  - Limitations: agent-cooperation-based, iter 2 chokidar as fallback
- [ ] **F3** `docs/JONGGRANG.md` — add 2 lines in the file structure tree (`:108` area) showing `output_files` field under each phase. No new section needed.
- [ ] **F4** `docs/WORKFLOW.md` — if it documents the simplify phase, note that iter 2 will integrate `output_files[]` with `getChangedFilesForSimplify`. (Iter 1: no change needed here.)
- [ ] **F5** `README.md` — "Commands at a Glance" row only (covered by E4).

### Phase G — Skill update

- [ ] **G1** `skills/core/persisting-agent-outputs/SKILL.md` — append section "OUTPUT_FILES Manifest Declaration":
  - When to emit: end of agent run, before final `IMPLEMENTATION_COMPLETE` / `REVIEW_COMPLETE` / `TEST_COMPLETE` signal
  - Format: full YAML example
  - Type enum table (from §4)
  - Path rules (relative to project root)
  - Note: this is **in addition to** the existing `{phase}-{role}-output.json` convention; both can coexist

### Phase H — Tests

- [ ] **H1** `test/orchestration.test.js` (extend existing or new):
  - `createManifest` initializes `output_files: []` for all phases
  - `addOutputFile` adds entry, fills size/created_at from fs
  - `addOutputFile` is idempotent on `path` within same phase
  - `addOutputFile` to nonexistent phase throws
  - `addOutputFile` with missing file sets `size: null`
- [ ] **H2** `test/output-parser.test.js` (new):
  - Parses plain `OUTPUT_FILES:` block
  - Parses fenced code block variant
  - Dedupes by path
  - Returns `[]` when no block present
  - Handles multiple blocks in one output
- [ ] **H3** `test/cmd-manifest.test.js` (new, optional for iter 1):
  - `manifest --list` shows all features
  - `manifest --feature <id> --files` flat list
  - `manifest --feature <id> --summary` counts
  - Error on missing feature
  - `--type code` filter
  - Defer to iter 2 if test infra for CLI is not yet established

### Phase I — Manual verification (end-to-end)

- [ ] **I1** Init a fresh project, plan a small feature, approve, work through it.
  - Verify MANIFEST.yaml has `output_files: []` initialized for all phases.
  - After phase 8 completes, verify the developer's emitted `OUTPUT_FILES:` block landed in `output_files[]`.
  - Verify paths are relative to project root.
  - Verify size/created_at are filled.
- [ ] **I2** Run `jonggrang manifest` and `jonggrang manifest --list` — confirm output is readable and correct.
- [ ] **I3** Run `jonggrang manifest --feature <id> --files --absolute` — confirm absolute path resolution works.
- [ ] **I4** Run `jonggrang manifest add --feature <id> --phase 8 --files '[{"path":"foo.ts","type":"code"}]'` and verify it lands in the manifest. Use this to confirm hook integration will work (or do a real hook run).
- [ ] **I5** Trigger a phase 11 (Code Quality) run, confirm reviewer's `OUTPUT_FILES:` block ends up in `phases[11].output_files[]`.
- [ ] **I6** Trigger a phase 14 (Testing) run, confirm tester's entries land in `phases[14].output_files[]`.
- [ ] **I7** Grep for `.yml` references in issue / docs — note for sync: the issue body uses `.yml`, but the codebase uses `.yaml`. No code change needed; add a one-line note in the PR description acknowledging the rename for clarity.

## 7. Out of scope (iter 1)

- **13 other phases** (1–7, 9, 10, 12, 13, 15–17): not instrumented in iter 1. Pattern is established; iter 2 is a copy-paste job across the remaining phases' prompt builders.
- **Chokidar hook fallback**: not implemented in iter 1. Only if post-iter-1 testing shows significant gap (e.g., agents forget to emit).
- **Web UI integration** for `output_files[]`: not in iter 1. Web dashboard does not currently display per-file output; the CLI is the primary surface. Future iter can add to Pipeline view.
- **Backfill** of existing features: explicitly not done. Existing MANIFEST.yaml files remain without `output_files[]` field (no migration script).
- **Cleanup of `agents[].output_path`**: marked deprecated, not removed. May be removed in iter 2 once confirmed no consumers.

## 8. Risks / notes

- **Agent cooperation**: iter 1 depends on agents emitting the `OUTPUT_FILES:` block. Risk: agent forgets, parser sees nothing, `output_files[]` stays empty. Mitigation: parser is permissive (doesn't fail the run); iter 2 chokidar catches stragglers.
- **Output format drift**: agents may emit the block in slightly different shapes (extra spaces, code-fenced, lowercased header, etc.). The parser must be robust. Plan: 3 unit test cases for each variant in H2.
- **Path duplication** between phases: same file modified by phase 8 and phase 11 should appear in both `output_files[]` arrays. This is correct behavior (each phase gets credit for what it did), but the `--files` flat list will show the file twice with different phase tags. Document this in `--files` output header.
- **Size mismatch over time**: `size` is captured at parse time. If the file is later modified, the manifest still has the original size. Acceptable — this is a manifest of "what was produced at this phase", not a current state. Note in docs.
- **No gitignore impact**: `.output/features/` is already git-tracked per existing decision. New `output_files[]` entries do not change this.
- **Hook event mismatch**: the claude/opencode/pi hooks all have different event models (PostToolUse, onMessage, etc.). D4 must investigate the right event for capturing agent stdout/stderr in each. **This is the highest-risk unknown** — agent picking up this plan should start by reading the existing `hooks/claude/feedback-loop.sh` and `hooks/opencode/plugin.js` to find the existing event model and follow that pattern. If unclear, ping the issue thread.
- **JSON vs YAML emission**: agents may emit either. Parser must handle both. The spec is YAML in the example, but a JSON block `{"OUTPUT_FILES": [...]}` should also work (or be explicitly rejected — pick one and document).

## 9. Reference

- Issue: https://github.com/porcupine-md/jonggrang/issues/50
- Pinned direction comment: https://github.com/porcupine-md/jonggrang/issues/50#issuecomment-4687060491
- Existing MANIFEST code: `lib/orchestration.js:113-185` (`getManifestPath`, `readManifest`, `writeManifest`, `createManifest`), `:208-220` (`completePhase`), `:267-285` (`registerAgent`)
- Existing output convention: `skills/core/persisting-agent-outputs/SKILL.md`
- Existing simplify pattern (iter 2 model): `lib/orchestration.js:300-380` (`getChangedFilesForSimplify`, `getDiffForFile`, `gatherDiffs`)
- Plan format reference: `docs/plans/2026-06-08-per-plan-work-mode.md`
- Plan doc convention: `docs/PHILOSOPHY.md` + `AGENTS.md` iron rule
