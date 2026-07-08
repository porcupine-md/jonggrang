# Plan: Repo-tracked memory layer (#79)

Branch: `feat/repo-memory-layer`
Issue: https://github.com/porcupine-md/jonggrang/issues/79
Handoff: jong-issue (async)

## Goal

Add a Markdown-first, repo-tracked memory layer so experience from plan/work/review compounds across fresh-context agents — without hidden state, context bloat, or file conflicts.

## Decisions (from discussion with user)

1. **Gitignore**: un-ignore `.jonggrang/.output/` entirely. Remove `.gitignore:29`. Fixes the docs-vs-reality contradiction (docs already say `.output/` is tracked). `.ephemeral/` + `locks/` stay ignored.
2. **Compact/Promote semantics**: LLM summarization via `runAgent` (backend = configured `TOOL`). Failure → keep fragments, write to temp then atomic rename, existing MEMORY.md never corrupted.
3. **progress.txt relationship**: coexist. progress.txt stays raw append-only log. MEMORY.md is the curated layer. compact reads progress.txt as one input source alongside fragments + existing MEMORY.md + task metadata.
4. **Scope**: one PR, phased commits. Track 1: CLI + lib + tests. Track 2: prompt integration. Track 3: gitignore + docs.

## Sub-decisions (assumed, override if wrong)

- **Recall budget**: max 5 snippets, max 2000 chars total, scoped by phase/feature/task/query. Each snippet carries source path + heading + timestamp.
- **Prompt injection set**: `buildDraftPlanPrompt`, `buildAppendPlanPrompt`, `buildRevisePlanPrompt`, `buildTasksFromPlanPrompt`, `buildWorkPrompt`, `buildReviewPrompt`. Deep-plan variants skipped (sub-flow internal to plan).
- **Locking**: reuse `lib/locks.js` `acquireLock(projectRoot, agentId, files=[])` on MEMORY.md path, synthetic agentId `memory-compactor` / `memory-promoter`. No new mutex.
- **Fragment archive**: after compact success, fragments move to `.ephemeral/memory/archive/` (gitignored, TTL 7d). Not deleted immediately (retryable).
- **Agent backend**: compact/promote use configured `TOOL`. If tool not configured → clear error.

## File layout

```
.jonggrang/
├── MEMORY.md                                    # project-level (tracked)
└── .output/features/<feature_id>/
    └── MEMORY.md                                # feature-level (tracked)
    └── (plan.md, MANIFEST.yaml, jonggrang-tasks.json, progress.txt — unchanged)
└── .ephemeral/memory/
    ├── fragments/<feature_id>/<task_id>-<timestamp>.md   # staging (gitignored)
    └── archive/<feature_id>/<task_id>-<timestamp>.md     # post-compact (gitignored, TTL 7d)
```

## CLI shape

Updated per jong-issue comment (2026-07-05): `memory read --project` dropped
from MVP. `memory read` (no flag) is now the clean entrypoint.

```bash
jonggrang memory read                         # project MEMORY.md + generated feature index (read-only)
jonggrang memory read --feature <id>          # feature memory detail
jonggrang memory recall --query "..." [--feature <id>] [--task <id>]
jonggrang memory fragment add --feature <id> --task <id> --file <path>
jonggrang memory compact --feature <id>
jonggrang memory promote --feature <id>
```

`memory read` (no flag) renders `.jonggrang/MEMORY.md` content + an on-the-fly
generated index of feature memories (scanned from `.output/features/*/MEMORY.md`
frontmatter: name/tags/updated_at). READ-ONLY — never rewrites the canonical
file to add links (avoids git churn/conflict). Mutating canonical memory stays
the job of `compact` / `promote` only. `--project` may become an alias later.

## Markdown shapes (from issue comment #1)

Project MEMORY.md + feature MEMORY.md + task fragment — frontmatter + sections per issue spec.

## Flow

```
Task agent done → fragment add (ephemeral staging, many-writer)
  → compact (single-writer, LLM merge fragments+progress+tasks → feature MEMORY.md)
  → fragments archived (TTL, gitignored)
Feature done/review passed → promote (single-writer, LLM distill stable lessons → project MEMORY.md)
```

## Tracks

- [ ] Track 1: CLI commands + lib/memory.js + tests
- [ ] Track 2: prompt builders integration (policy + recall guide, not full content)
- [ ] Track 3: .gitignore un-ignore + docs (README, JONGGRANG, WORKFLOW, CONFIG)

## Acceptance (from handoff)

- [ ] CLI commands exist with sensible validation/errors
- [ ] fragment add stores ephemeral raw fragments only
- [ ] compact creates/updates feature MEMORY.md
- [ ] promote creates/updates project MEMORY.md conservatively
- [ ] prompt builders contain policy/recall guide, not full memory content
- [ ] git tracking/docs decision explicit
- [ ] tests pass (npm test + targeted smoke)
