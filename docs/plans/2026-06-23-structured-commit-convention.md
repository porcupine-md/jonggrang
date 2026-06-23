---
plan: structured-commit-convention
issue: 62
branch: feat/structured-commit-convention
status: draft
created_at: 2026-06-23
---

# Structured Commit Convention for Agent Traceability (#62)

## Problem

Agents commit with free-form `type(scope): description` messages (CONTRIBUTING.md §3,
CLAUDE.md.template:25, lib/jonggrang.js:496). When a new agent (or new plan cycle)
starts with fresh context, it can read *what* changed (git diff, MANIFEST
`output_files`) but not *why* a decision was made, what tradeoff was accepted, or
what's fragile/incomplete. Git history is human-readable but not agent-recoverable.

## Goal

Make agent commit messages machine-parseable for context recovery, so a downstream
agent can `git log` + parse the structured fields and rebuild the rationale of
previous work — complementing (not duplicating) the deterministic MANIFEST.

## Design (reconciled from #62 discussion)

### Commit format (source of truth)

```
<type>: <summary>

Context: <feature or plan description, human-readable — NOT an ID>
What: <what changed in this commit>
Why: <rationale for the change>
Tradeoff: <what was sacrificed / alternative rejected, or "none">
Caveats: <next agent should know — incomplete work, fragile code, follow-up — or "none">

Co-authored-by: jonggrang <...>
```

### Rules

- **Agent commits MUST follow this format** — contract, not suggestion.
- **Human commits exempt** but encouraged.
- The `Co-authored-by:` trailer (already auto-injected via `COAUTHOR_TRAILER`) is
  the **agent-commit marker**. Its presence ⇒ validate the structured fields.
  Absence ⇒ human commit, skip validation.
- `Context:` is narrative (e.g. "per-feature task isolation"), **not** an ID.
  Rationale: plan-id hierarchy is deferred (#64 shipped `feature_id`, not plan-id);
  narrative context is more useful to a fresh-context agent than an opaque ID.
- All 5 fields (`Context`, `What`, `Why`, `Tradeoff`, `Caveats`) MUST be present.
  Values MAY be `none` — the field must exist, the content need not be meaningful.
  (Typo fixes, version bumps genuinely have no tradeoff.)
- **MANIFEST owns what/where** (deterministic, via `git diff` after phases 8/12/14).
  **Commit owns why/tradeoff/caveat** (narrative). Do NOT duplicate file lists in
  the commit `What:` — describe the *change intent*, not the file list.

### Enforcement: lifecycle hook (NOT git commit-msg hook)

Reasoning (per maintainer): a git `commit-msg` hook is too rigid — it hard-rejects
and the agent can't reason about *why* it was rejected. Instead, use a **lifecycle
hook** (PreToolUse on `Bash(git commit)`) that:

1. Detects the commit command, extracts the message.
2. Checks for `Co-authored-by:` trailer (agent marker).
3. If present and structured fields are missing → **block the tool call** with a
   guidance message: which fields are missing + a format example. The agent
   receives the feedback in-context, reasons, and retries with the correct format.
4. If absent (human commit) → pass through, no validation.

This is a soft-guide that lives in the agent's reasoning loop, not a hard git
reject. The agent learns and self-corrects.

## Acceptance criteria (from #62)

- [ ] Document the commit convention (CONTRIBUTING.md + new docs/COMMIT-CONVENTION.md)
- [ ] Add lifecycle hook that checks required fields (What, Why, Tradeoff, Caveats)
- [ ] Update agent skills/prompts to produce commits in this format
- [ ] Add example commits in documentation

## Implementation split (parallel, no file overlap)

Coordinated with jong-code (shared worktree — disjoint file areas to avoid conflict).

### Track A — convention spec + agent prompt injection (me)

Source of truth for the format; the hooks and docs in Track B reference this.

- `docs/plans/2026-06-23-structured-commit-convention.md` (this file)
- `lib/jonggrang.js` — work-loop prompt instruction (~L496): replace
  `type(scope): description` guidance with the structured format + example
- `templates/CLAUDE.md.template` (~L25): same update for the agent onboarding doc
- `CONTRIBUTING.md` (§3): rewrite the commit section with structured format +
  examples + the agent/human distinction

### Track B — enforcement hook + reference docs (jong-code)

References the format defined in Track A's plan doc + CONTRIBUTING.

- `hooks/claude/commit-convention.sh` (new) — PreToolUse hook: detect
  `git commit`, check trailer + fields, block-with-guidance if agent commit missing
  fields. This is the core enforcement.
- `hooks/claude/settings.json` — register the new hook
- `hooks/pi/jonggrang-extension.ts` — equivalent PreToolUse handler for pi backend
- `hooks/opencode/plugin.js` — equivalent for opencode backend
- `skills/core/orchestrating-feature/SKILL.md` (~L95, Phase 16) — update "commit
  with conventional format" → "commit with structured convention (see COMMIT-CONVENTION)"
- `docs/COMMIT-CONVENTION.md` (new) — full reference: format, rules, agent vs human,
  field semantics, 3-4 example commits, how the hook enforces
- `docs/PHILOSOPHY.md` — mention the commit-convention hook in the Hooks section
- `README.md` — link to docs/COMMIT-CONVENTION.md from the contributing/commit area

### Sequencing

Track A's plan doc + CONTRIBUTING format spec land FIRST (commit), so Track B's
hook has a stable format to validate against. After that, both tracks proceed in
parallel on disjoint files. Cross-review at the end (I review the hook logic,
jong-code reviews the prompt injection).

## Out of scope

- `plan-id` prefix (deferred — would need plans/<plan-id>/ hierarchy from #64)
- Hard git `commit-msg` hook (rejected — too rigid, agent can't reason)
- Semantic validation of field content (only presence checked)
- Retroactive rewriting of existing git history
