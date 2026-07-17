# Commit Convention for Agent Traceability

> Git history is the agent communication layer. A fresh-context agent should be able to recover *why* a change was made — not just *what* changed.

## Why

Free-form `type(scope): description` is human-readable but agent-opaque. When a new agent (or new plan cycle) starts with fresh context, it can read the diff and the MANIFEST, but not the *reasoning* behind a decision: what was sacrificed, what's fragile, what follow-up is needed.

A structured commit message solves this by making the rationale parseable. Combined with MANIFEST (which owns *what/where*), commit history owns *why/tradeoff/caveat*.

## Format (contract for agent commits)

```
<type>: <short summary>

Context: <narrative — feature or plan description, NOT an ID>
What:    <change intent in prose — don't list files, MANIFEST tracks that>
Why:     <rationale for the change>
Tradeoff:<what was sacrificed / alternative rejected, or "none">
Caveats: <next-agent note — incomplete work, fragile code, follow-up, or "none">

Co-authored-by: jonggrang <koko@jonggrang.dev>
```

### Field semantics

| Field | Purpose | May be "none"? |
|---|---|---|
| `Context` | What feature/plan/area this commit belongs to. Narrative — a future agent with no project context should still understand the domain. | No (always write something) |
| `What` | The change intent in prose. *Why this change exists*, not a list of files. MANIFEST owns file tracking. | No |
| `Why` | The rationale: what problem, what alternative was considered, what triggered the change. | No |
| `Tradeoff` | What was sacrificed. Examples: "skipped test coverage for X to ship Y", "kept backward compat by inlining", or `"none"`. | **Yes** |
| `Caveats` | What the next agent should know. Examples: "fragile around edge case Z", "follow-up tracked in #N", or `"none"`. | **Yes** |

### Rules

- **Agent commits MUST follow this format** — it's a contract, not a suggestion. Enforced by a lifecycle hook (see below).
- **Human commits are exempt** — the hook skips validation when no `Co-authored-by:` trailer is present. Humans are still encouraged to follow.
- **All 5 fields must exist.** The value may be `none` for `Tradeoff` and `Caveats` (and only those — `Context`/`What`/`Why` should always have substance).
- **Field names are case-insensitive** (`Context:` = `context:`), but the canonical form is title-case.
- **Context is narrative, not an ID.** Plan-id prefixing is deferred — narrative is more useful to a fresh-context agent than an opaque ID.
- **The `Co-authored-by:` trailer is the agent marker.** It's auto-injected by `COAUTHOR_TRAILER` (lib/jonggrang.js). Its presence triggers validation; its absence is a human commit and skips.
- **MANIFEST owns what/where, commit owns why/tradeoff/caveat.** Don't duplicate file lists in `What:` — describe the *change intent*.

## Enforcement: lifecycle hook (not git commit-msg)

A git `commit-msg` hook is too rigid — it hard-rejects and the agent can't recover (or even see why it was rejected). Instead, a **lifecycle PreToolUse hook** on `Bash(git commit)` does the following:

1. Detects a `git commit` invocation in the bash command.
2. Extracts the message (from `-m`, `-F`, or `--amend`).
3. Checks for a `Co-authored-by:` trailer.
4. If present and any of the 5 required fields are missing → **block the tool call** with a guidance message: which fields are missing + the full format spec.
5. The agent receives the block reason in-context, reasons about it, and retries with the correct format.

This is a soft-guide that lives in the agent's reasoning loop. The agent learns and self-corrects — there is no hard git reject.

The hook is implemented in three places (one per agent backend):

- `hooks/claude/commit-convention.sh` — Claude Code
- `hooks/pi/jonggrang-extension.ts` — Pi (TypeScript extension, `tool_call` handler)
- `hooks/opencode/plugin.js` — OpenCode (JavaScript plugin, `tool.execute.before` handler)

All three implement the same logic so behavior is consistent across backends.

## Example commits

### Example 1: New feature

```
feat: add per-feature task isolation

Context: agents were overwriting each other's tasks when working on parallel features
What:    moved per-task state from a single global file to one file per feature under .jonggrang/.output/features/
Why:     the global file caused data loss when two agents worked on the same project in worktree mode
Tradeoff: lost easy cross-feature task queries — must now read all feature files and merge
Caveats: migration on `jonggrang init` is one-shot; existing repos need a manual `init --migrate` to upgrade

Co-authored-by: jonggrang <koko@jonggrang.dev>
```

### Example 2: Refactor (genuinely no tradeoff)

```
refactor: extract statusColor() helper in bin/jonggrang.js

Context: cmdStatus and taskList had three duplicated status->color switch statements
What:    consolidated into one statusColor(status) helper and replaced all three sites
Why:     DRY; future status changes only need to update one place
Tradeoff: none
Caveats: none

Co-authored-by: jonggrang <koko@jonggrang.dev>
```

### Example 3: Chore with follow-up caveat

```
chore: bump dependencies to latest patch versions

Context: routine security/maintenance update
What:    updated 14 transitive deps in package-lock.json, no source changes
Why:     GitHub Dependabot alerts for known CVEs
Tradeoff: none
Caveats: one new transitive (lodash-es@4.17.21) bumped its peer range — verify consumer compatibility in CI

Co-authored-by: jonggrang <koko@jonggrang.dev>
```

### Example 4: Typo fix (Tradeoff/Caveats legitimately "none")

```
docs: fix typo in README quickstart

Context: README quickstart section
What:    fixed "sucessful" -> "successful" in install instructions
Why:     typo in user-facing docs
Tradeoff: none
Caveats: none

Co-authored-by: jonggrang <koko@jonggrang.dev>
```

## What if the hook blocks my commit?

The block reason tells you exactly which fields are missing. Fix the message, retry. Example flow:

```
$ git commit -m "fix: cache invalidation"
→ {"decision":"block","reason":"COMMIT CONVENTION: agent commit is missing
  required structured field(s):
    - Context:
    - What:
    - Why:
    - Tradeoff:
    - Caveats:..."}

# Agent reads the block reason, appends the 5 fields + trailer, retries:
$ git commit -m "fix: cache invalidation on user delete

Context: stale cache entries after user deletion
What:    invalidate user-scoped cache keys when DELETE /users/:id succeeds
Why:     test suite caught a leak — deleted users' data was still served from cache
Tradeoff: none
Caveats: batch delete (DELETE /users) is not yet handled, see #87

Co-authored-by: jonggrang <koko@jonggrang.dev>"
```

The agent learns the format on the first or second retry and self-corrects thereafter.

## Why not validate field content?

The plan doc (`docs/plans/2026-06-23-structured-commit-convention.md`) explicitly rejected semantic validation:

> Field must exist, may be 'none' — the field must exist, the content need not be meaningful.

Why:
- **Too brittle.** An LLM judging another LLM's prose is unreliable.
- **False rejections.** A commit that *is* good-faith but phrased unusually would be blocked, frustrating the agent.
- **The Co-authored-by trailer is the contract.** If a human trusts the agent enough to mark it as agent-authored, the prose is good enough. If a human wants stricter review, they read the message themselves.

## Related

- [CONTRIBUTING.md §3](../CONTRIBUTING.md#3-commit) — short summary + branch/PR workflow
- [templates/CLAUDE.md.template](../templates/CLAUDE.md.template) — agent onboarding doc with the same format
- [lib/jonggrang.js](../lib/jonggrang.js) — work-loop prompt that injects the format into agent context
- [docs/PHILOSOPHY.md](./PHILOSOPHY.md#hooks) — hook design rationale
- [Issue #62](https://github.com/porcupine-md/jonggrang/issues/62) — original spec
