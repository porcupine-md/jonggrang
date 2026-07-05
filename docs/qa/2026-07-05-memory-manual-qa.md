# Manual QA Scenarios — PR #80 / Issue #79 (Repo-tracked Memory Layer)

> These scenarios verify what automated scripts **cannot**: error message
> quality, MEMORY.md content quality (no hallucination), and true agent
> policy usage. Run them by hand. Each has a "What to look for" note.
>
> Prereq: `cd` into the jonggrang repo.
> ```bash
> REPO=/Users/anshori/Works/ans4175/porcupine/jonggrang
> JG="node $REPO/bin/jonggrang.js"
> ```

---

## Scenario A — Error message quality (no agent needed)

**Goal:** invalid input should produce actionable errors, not crashes or
cryptic stack traces. An agent reading the error should understand what to fix.

```bash
T=$(mktemp -d) && cd "$T" && git init -q && git commit -q --allow-empty -m init
printf '.jonggrang/.ephemeral/\n' > .gitignore
mkdir -p .jonggrang/.output/features/feat-x
echo '{"name":"t","project":{"stack":"node"}}' > .jonggrang/jonggrang.json
echo '{"tasks":[{"id":"task-001","title":"t","status":"pending","feature_id":"feat-x"}]}' \
  > .jonggrang/.output/features/feat-x/jonggrang-tasks.json
```

### A1. Fragment add — task doesn't exist
```bash
$JG memory fragment add --feature feat-x --task task-999 --file /tmp/nonexistent.md
```
**Expect:** exit ≠ 0, error mentions `task-999 not found in feature feat-x`.
**Look for:** does the error tell you WHICH task id is wrong and WHERE?

### A2. Fragment add — file doesn't exist
```bash
$JG memory fragment add --feature feat-x --task task-001 --file /tmp/does-not-exist.md
```
**Expect:** exit ≠ 0, error mentions `fragment file not found: /tmp/does-not-exist.md`.

### A3. Fragment add — missing flags
```bash
$JG memory fragment add --feature feat-x --task task-001
```
**Expect:** exit ≠ 0, error lists all 3 required flags (`--feature --task --file`).

### A4. Read — feature doesn't exist
```bash
$JG memory read --feature feat-tidak-ada
```
**Expect:** exit ≠ 0, error says feature folder not found + suggests checking `.output/features/`.

### A5. Recall — missing --phase
```bash
$JG memory recall --query "idempotency"
```
**Expect:** exit ≠ 0, error says `--phase <plan|approve|work|review|simplify|test> is required`.

### A6. Compact — feature doesn't exist
```bash
$JG memory compact --feature feat-nope
```
**Expect:** exit ≠ 0, error says `feature not found: feat-nope`.

### A7. Promote — feature has no memory yet (compact not run)
```bash
$JG memory promote --feature feat-x
```
**Expect:** exit ≠ 0, error says `no feature memory to promote` + suggests running `compact` first.

**Cleanup:** `cd $REPO && rm -rf "$T"`

---

## Scenario B — Compact & promote content quality (needs agent)

**Goal:** verify the LLM path produces good MEMORY.md — no hallucination,
no silent fragment loss, promote is more abstract than feature.

**Prereq:** agent CLI configured (claude by default).

```bash
T=$(mktemp -d) && cd "$T" && git init -q && git commit -q --allow-empty -m init
printf '.jonggrang/.ephemeral/\n' > .gitignore
mkdir -p .jonggrang/.output/features/feat-billing
echo '{"name":"t","project":{"stack":"node"},"tool":"claude"}' > .jonggrang/jonggrang.json
echo '{"tasks":[{"id":"task-001","title":"add idempotency","status":"completed","feature_id":"feat-billing"}]}' \
  > .jonggrang/.output/features/feat-billing/jonggrang-tasks.json
```

### B1. Stage a fragment
```bash
cat > /tmp/frag.md << 'EOF'
## What Done
- Added job-level idempotency key to reconciliation job

## Why
Retries were duplicating invoices — without a key, the same settlement
could be processed twice if the cron retried mid-failure.

## Tradeoffs
- Slight write amplification (extra index lookup per job)
- Chose job-boundary key over row-level: simpler, covers the race window

## Lessons / Promotion Candidates
- For financial/background jobs, require idempotency at job boundary
  BEFORE adding retry logic. Retries + no idempotency = silent duplicates.
EOF

$JG memory fragment add --feature feat-billing --task task-001 --file /tmp/frag.md
```

### B2. Compact (LLM) — ~30-120s
```bash
$JG memory compact --feature feat-billing
```
**Expect:** "Feature memory updated" + "Archived 1 fragment(s)".

### B3. Inspect feature MEMORY.md — READ THIS CAREFULLY
```bash
cat .jonggrang/.output/features/feat-billing/MEMORY.md
```
**Look for (pass/fail each):**
- [ ] Has frontmatter (`feature_id`, `updated_at`, etc.)
- [ ] Has all 6 sections (Context, Facts, What Done & Why, Lessons Learned, Open Questions, Promotion Candidates)
- [ ] The "idempotency" lesson from the fragment IS present
- [ ] The "tradeoff" (job-boundary vs row-level) IS present
- [ ] **No hallucination** — no facts that weren't in the fragment or tasks
- [ ] **No silent loss** — every fragment section reflected somewhere

### B4. Verify fragment archived (not deleted)
```bash
ls .jonggrang/.ephemeral/memory/archive/feat-billing/
```
**Expect:** the fragment file moved here (retryable if compact needs to re-run).

### B5. Promote (LLM) — ~30-120s
```bash
$JG memory promote --feature feat-billing
```
**Expect:** "Project memory updated".

### B6. Inspect project MEMORY.md — READ THIS CAREFULLY
```bash
cat .jonggrang/MEMORY.md
```
**Look for (pass/fail each):**
- [ ] Has frontmatter (`scope: project`, `updated_at`)
- [ ] Has 4 sections (Conventions, Known Pitfalls, Architectural Decisions, Repeated Lessons)
- [ ] The idempotency lesson IS present, but **more abstract** than feature memory
- [ ] Feature said: "idempotency key to reconciliation job" (specific)
- [ ] Project should say: "idempotency at job boundary for financial jobs" (abstracted, cross-feature)
- [ ] **No task-specific detail leaked** (no "reconciliation", no "task-001", no "cron")

### B7. memory read — see the full picture
```bash
$JG memory read
```
**Expect:** project memory rendered + feature index listing `feat-billing` with tags + updated date.

**Cleanup:** `cd $REPO && rm -rf "$T"`

---

## Scenario C — True agent policy usage (the real test)

**Goal:** verify a real agent ACTUALLY calls `jonggrang memory recall` during
a plan run, not just that the policy string exists in the prompt.

```bash
T=$(mktemp -d) && cd "$T" && git init -q && git commit -q --allow-empty -m init
printf '.jonggrang/.ephemeral/\n' > .gitignore
mkdir -p .jonggrang
echo '{"name":"t","project":{"stack":"node"},"tool":"claude"}' > .jonggrang/jonggrang.json

# Pre-seed project memory so recall has something to find
cat > .jonggrang/MEMORY.md << 'EOF'
---
updated_at: 2026-07-05T10:00:00Z
scope: project
---
## Known Pitfalls
- Always use idempotency keys for financial jobs — retries without keys cause silent duplicates
EOF
```

### C1. Run plan — watch for recall
```bash
$JG plan "add retry logic to billing reconciliation" --yes 2>&1 | tee /tmp/plan-run.log
```

### C2. Check: did the agent call recall?
```bash
grep -i "memory recall" /tmp/plan-run.log
```
**Expect:** at least one line showing the agent ran `jonggrang memory recall --phase plan ...`.

### C3. Check: did the agent reference the seeded memory?
```bash
grep -i "idempotency\|pitfall\|memory" /tmp/plan-run.log | head -10
```
**Look for:** the agent's plan should acknowledge the idempotency pitfall from
memory. If the plan ignores it entirely, the recall didn't reach the agent's
reasoning (policy injection present but not acted on = bug).

**Cleanup:** `cd $REPO && rm -rf "$T"`

---

## Quick reference: what's git-tracked vs ephemeral

| Path | Tracked? | Why |
|---|---|---|
| `.jonggrang/MEMORY.md` | ✅ tracked | project memory, durable, travels with branch |
| `.jonggrang/.output/features/<id>/MEMORY.md` | ✅ tracked | feature memory, durable |
| `.jonggrang/.output/features/<id>/plan.md` | ✅ tracked | archived plan |
| `.jonggrang/.output/features/<id>/MANIFEST.yaml` | ✅ tracked | phase state |
| `.jonggrang/.ephemeral/memory/fragments/<id>/` | ❌ ignored | raw staging, many-writer, churn-prone |
| `.jonggrang/.ephemeral/memory/archive/<id>/` | ❌ ignored | post-compact, TTL 7d, retryable |
| `.jonggrang/locks/` | ❌ ignored | ephemeral file ownership |

**Verify anytime:**
```bash
git check-ignore -v .jonggrang/.output/features/feat-x/MEMORY.md    # should NOT be ignored
git check-ignore -v .jonggrang/.ephemeral/memory/fragments/feat-x/x.md  # SHOULD be ignored
```

---

## Automated companion

For deterministic mechanical checks (no agent), run:
```bash
bash scripts/qa-memory-scenarios.sh           # 11 assertions, no LLM
bash scripts/qa-memory-scenarios.sh --agent   # also runs compact/promote (Scenario B above)
```

The script covers plumbing (file paths, git tracking, read-only contract, policy
injection presence). The manual scenarios above cover what scripts can't:
error clarity, content quality, and true agent behavior.
