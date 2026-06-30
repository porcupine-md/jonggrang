---
feature: plan-ask-clarifying-questions
branch: feat/planner
work_type: LARGE
description: Give the planning agent a first-class intake command — `jonggrang plan ask` — that it uses to SUBMIT clarifying questions (instead of hallucinating assumptions), mirroring `jonggrang task import`. The user answers (pick an option with its rationale, or free text), and the agent re-plans with real answers. Covers standard + --deep planning, persistence across plan revisions, and the web UI.
created_at: 2026-06-28
status: implemented (P1–P5) — E2E tested with the claude backend
---

> **Implementation status (2026-06-29):** P1–P5 built and E2E-tested in `/tmp` with
> the `claude` backend. P6 (orchestrate-mode) dropped — this is a plan-mode feature.
> Headless CLI path (Pass A → answers → Pass B), `--deep`, `--revise` reuse, and the
> full web round-trip (POST /plan → `plan.questions` socket → POST /plan/answers →
> plan.md) all pass. The interactive-TTY `@clack` collection is validated by
> contract + API checks (not auto-tested in the sandbox — no reliable PTY); smoke-test
> manually: `jonggrang plan "something vague" --tool claude`.

# Plan: `jonggrang plan ask` — Agent-Submitted Clarifying Questions

> **Scope:** design only, nothing implemented yet. Build the **CLI intake command
> first**, test in `/tmp` with the `claude` backend, then the orchestration loop,
> then web. This doc is for review.
>
> **Revision note (v2):** corrected the mental model. `plan ask` is a **tool the
> agent calls to write its questions** (like `task import`), *not* a command the
> user runs. This removes the earlier "parse questions out of the agent's stdout
> text" idea, which risked the agent hallucinating malformed output.

---

## 1. Mental Model — read this first

`plan ask` is to **questions** what `jonggrang task import` is to **tasks**: an
**agent-facing intake command**. The planning agent calls it to submit structured
clarifying questions; the CLI validates and stores them. The user never types
`plan ask` themselves.

```
jonggrang task import  →  agent writes TASKS into the store   (bin/jonggrang.js:3133)
jonggrang plan ask     →  agent writes QUESTIONS into the store   (NEW, mirrors it)
```

**Why this shape:** if the agent is uncertain, we do not want it to guess and
write a confident-but-wrong plan ("agent halu"). Instead it must *stop and ask*,
through a strict, validated command — exactly the discipline `task import` already
enforces for tasks.

### The full loop

```
            jonggrang plan "<desc>"                 (user runs this, or the web)
                     │
                     ▼
        ┌────────────────────────────┐   PASS A: agent analyzes the goal.
        │ planning agent (runAgent)  │   If ambiguous → it CALLS
        │  prompt: "analyze goal;    │   `jonggrang plan ask --input '<json>'`
        │   if unsure, plan ask;     │   (writes questions store) and STOPS.
        │   else write plan.md"      │   If clear → it writes plan.md, done.
        └─────────────┬──────────────┘
                      │ questions submitted?
            ┌─────────┴──────────┐
            │ no                 │ yes
            ▼                    ▼
      plan.md written     ┌──────────────────────────────┐
      → approve menu      │ collect answers from USER      │
                          │  • CLI (TTY): @clack prompts   │
                          │  • Web: render a form          │
                          │  • headless: emit + wait        │
                          └───────────────┬───────────────┘
                                          │ answers store
                                          ▼
                          ┌──────────────────────────────┐
                          │ PASS B: re-run planning agent  │
                          │  prompt + answers → plan.md    │
                          └──────────────────────────────┘
```

- **`plan ask`** is only ever invoked by the agent, inside Pass A.
- The **user-answering** and **Pass B re-run** are orchestration the CLI/web own.
- Answers reach Pass B via `jonggrang plan "<desc>" --answers <file>` (see §5).

---

## 2. Implementation Phases (build order)

| Phase | Deliverable | Why this order |
|---|---|---|
| **P1** | `plan ask` intake command (+ lib store) | The thing the user asked to build & test first. Standalone, testable by calling it directly with sample JSON. |
| **P2** | Planning-prompt change + CLI answer loop (standard mode, TTY) | Makes the agent actually use `plan ask`, and closes the loop interactively. |
| **P3** | Persistence + plan revision reuse | Durable Q&A sidecar; `--revise` reuses prior answers; appended to plan.md. |
| **P4** | `--deep` mode integration | Questions before the 3-phase deep pipeline. |
| **P5** | Web integration | Endpoints + `PlanView.vue` question form + socket events. |
| **P6** | *(optional)* Orchestrate-mode integration | Heaviest; orchestrate is autonomous, so this has caveats (§11). Confirm before doing. |

Each phase is independently shippable. P1 is the foundation everything reuses.

---

## 3. P1 — The `plan ask` Intake Command

Mirrors `taskImport` (`bin/jonggrang.js:3133`) and `cmdTask` flag parsing
(`bin/jonggrang.js:2988-3044`) as closely as possible.

### 3.1 Invocation (3 input modes, identical to `task import`)

```bash
# by flag (what the agent uses most):
jonggrang plan ask --input '{"goal_analysis":"...","questions":[ ... ]}'

# by file:
jonggrang plan ask questions.json

# by stdin pipe:
echo '{"questions":[ ... ]}' | jonggrang plan ask
```

Accepts **either** the canonical object form
`{ "goal_analysis": "...", "questions": [ ... ] }` **or** a bare array of question
objects (goal_analysis then optional, settable via `--goal "<text>"`). Object form
is canonical; the bare array exists for symmetry with `task import`.

Flags (same idiom as `cmdTask`): `--input <json>`, `--goal <text>`, `--pretty`,
`--json`. Output is JSON when non-TTY (so the agent can read what was stored) and
pretty when TTY — exactly like `taskImport` (`bin/jonggrang.js:3160-3165`).

### 3.2 Question object schema (the agent's contract)

```jsonc
{
  "id": "q1",                       // optional; auto-assigned (q1, q2, …) if missing
  "question": "Which auth strategy?",          // REQUIRED
  "rationale": "Determines token storage and revocation.",  // optional (shown as 'Why:')
  "type": "single_choice",          // single_choice | multi_choice | text  (default: text)
  "allow_freetext": true,           // choice types: also offer 'type my own'
  "options": [                      // REQUIRED for choice types, ≥2 items
    { "value": "jwt",     "label": "JWT (stateless)", "rationale": "Scales horizontally, no session store." },
    { "value": "session", "label": "Server sessions", "rationale": "Easy revocation, needs Redis." }
  ]
}
```

### 3.3 Validation (in the new `lib.savePlanQuestions`, mirrors `addTasksBulk`)

- Parse JSON; reject with a clear message on parse error (like `taskImport`
  `bin/jonggrang.js:3150-3156`).
- `questions` non-empty; cap at **6** (avoid an interrogation; log if truncated).
- Each question: `question` required; `type` ∈ {single_choice, multi_choice, text}.
  An **omitted** `type` defaults to `text`; an **explicit unsupported** `type` (e.g. a
  typo like `single-choice`) is **rejected with a clear error** — not silently coerced —
  so the agent fixes its call instead of shipping a broken UX/contract. Choice types
  need ≥2 `options` each with `value`+`label` (`rationale` optional → rendered as hint).
- Auto-assign missing `id`s.
- Empty/zero questions is an **error** for `plan ask` (the agent shouldn't call it
  with nothing) — distinct from "agent chose not to ask", which means it never
  calls the command at all.

### 3.4 Store location (durable — NOT `.ephemeral`)

```
.jonggrang/plan-questions.json     ← questions submitted by the agent
.jonggrang/plan-answers.json       ← answers collected from the user
```

Durable siblings of `plan.md`. **Must not** live under `.jonggrang/.ephemeral/`
because `--deep` mode deletes that directory at the end of its run
(`bin/jonggrang.js:1184-1189`), and we need these to survive for plan revision (P3).

### 3.5 New `lib/jonggrang.js` functions (export at line 2350)

| Function | Mirrors | Purpose |
|---|---|---|
| `savePlanQuestions(file, payload)` | `addTasksBulk` | validate + normalize + write questions store; return stored object |
| `getPlanQuestions(file)` | `getTasks` | read questions store (`{questions:[]}` if none) |
| `clearPlanQuestions(file)` | — | delete questions store (called before Pass A) |
| `savePlanAnswers(file, answers)` | — | validate + write answers store |
| `getPlanAnswers(file)` | `getTasks` | read answers store |

### 3.6 Routing & help

- In `cmdPlan` (`bin/jonggrang.js:1014`), intercept at the top **before** the
  positional parser (the loop at 1021-1027 would otherwise treat `ask` as a
  description):
  ```js
  if (args[0] === 'ask') return cmdPlanAsk(args.slice(1));
  ```
- `cmdPlanAsk(subArgs)` parses flags like `cmdTask`, reads input (flag/file/stdin
  per §3.1), calls `lib.savePlanQuestions`, prints result. Pure intake — **no
  interactive prompts here.**
- Help: add a `plan ask` block to `cmdHelp` (and/or a `plan ask --help`), with the
  schema example, modeled on `cmdTaskHelp` (`bin/jonggrang.js:3267`).

### 3.7 P1 acceptance (test in `/tmp`, no agent needed yet)

```bash
mkdir -p /tmp/jg-ask && cd /tmp/jg-ask
git init -q && echo x > README.md && git add -A && git commit -qm init
node <repo>/bin/jonggrang.js init

# happy path via --input
node <repo>/bin/jonggrang.js plan ask --input '{"goal_analysis":"add health endpoint","questions":[{"question":"Path?","type":"single_choice","options":[{"value":"/healthz","label":"/healthz","rationale":"k8s convention"},{"value":"/health","label":"/health","rationale":"shorter"}]}]}'
cat .jonggrang/plan-questions.json     # valid, ids assigned

# via stdin + file, plus error paths (bad JSON, empty array, missing question)
echo '{"questions":[{"question":"Notes?","type":"text"}]}' | node <repo>/bin/jonggrang.js plan ask
node <repo>/bin/jonggrang.js plan ask --input 'not json'      # clean error, exit 1
```

- [ ] Stores valid JSON, assigns ids, echoes stored object (non-TTY JSON / TTY pretty).
- [ ] All three input modes work; bad input fails cleanly like `task import`.

---

## 4. P2 — Teach the Agent + Close the Loop (standard mode, TTY)

### 4.1 Planning prompt change (`lib/jonggrang.js`)

Extend `buildDraftPlanPrompt` (line 526) with an instruction block:

> **Before planning, analyze the goal.** Restate in 1-2 sentences what the user
> wants to achieve. If anything material is ambiguous (architecture choice, scope,
> data model, compatibility), **do not guess.** Submit clarifying questions by
> running:
> `jonggrang plan ask --input '<json>'`  (schema below), then STOP — do not write
> `.jonggrang/plan.md`. Only when the request is unambiguous (or answers are
> already provided below) write the plan.

The agent runs the command itself (claude/codex/opencode/jonggrang can all run
shell commands). This is the same trust model as the agent calling `task import`
during decomposition.

### 4.2 CLI orchestration in `cmdPlan` (standard branch, around 1194-1205)

```
clearPlanQuestions()                      # fresh slate
runAgent(buildDraftPlanPrompt(...))       # PASS A
q = getPlanQuestions()
if q.questions.length and not plan.md-just-written:
    if TTY:   answers = interactiveAnswer(q)      # §4.3
              savePlanAnswers(answers)
              runAgent(buildDraftPlanPrompt(..., {clarifications}))   # PASS B
    else:     emitSignal('plan_questions', {...}); return            # headless → web/script
# then existing setPlanBase + showPlanOptions  (1208-1223) unchanged
```

Detection of "did the agent ask vs plan": clear the questions store before Pass A,
then check it after. (plan.md presence is the secondary signal.)

### 4.3 Interactive answering (`@clack/prompts`, imported at `bin/jonggrang.js:12`)

Add `multiselect` to the import. Mapping:

| `type` | clack call | notes |
|---|---|---|
| `single_choice` | `select({message, options})` | `options[].hint = option.rationale`; append `{value:'__freetext__', label:'✎ Type my own answer…'}` when `allow_freetext` |
| `multi_choice` | `multiselect({message, options})` | same hint mapping + optional `__freetext__` |
| `text` | `text({message, placeholder})` | free input |

- Question-level `rationale` printed as a dim `Why: …` line before the prompt.
- `__freetext__` selection chains into a `text()` prompt.
- `isCancel()` → abort cleanly, write no plan (consistent with the rest of the CLI).

### 4.4 Answers schema (Pass-B input)

```jsonc
{
  "goal_analysis": "…echoed for traceability…",
  "answers": [
    { "id":"q1", "question":"Which auth strategy?", "type":"single_choice",
      "value":"jwt", "label":"JWT (stateless)", "freetext":null },
    { "id":"q2", "question":"Notes?", "type":"text",
      "value":"reuse Postgres users table", "freetext":"reuse Postgres users table" }
  ]
}
```
"Type my own" on a choice → `value:"__freetext__"`, `freetext:"<typed>"`.

### 4.5 Pass B prompt

`buildDraftPlanPrompt(description, configFile, tasksFile, { clarifications })` —
when `clarifications` present, inject a `## Clarifications from User` section
(goal + Q/A pairs) and tell the agent: answers are authoritative, **do not** ask
again, write `plan.md`. Backward compatible (existing caller at 1204 passes nothing).

---

## 5. `--answers` flag (the headless seam for web + scripting)

`jonggrang plan "<desc>" --answers <file|->` runs **Pass B directly**: skip Pass A
question-gen, load answers, generate the plan. Also `--answers-inline <base64-json>`
to avoid any filesystem/ownership issues inside the Docker sandbox (see the known
sandbox bind-mount EACCES gotcha — passing answers inline sidesteps it entirely).

This one flag is what lets the **web** drive the exact same logic without
duplicating it: web collects answers in a form → calls `plan --answers-inline …`.

---

## 6. P3 — Persistence Across Plan Revisions

"Persistent buat plan revision": once answered, the clarifications stick and inform
future revisions.

- **Durable store:** `.jonggrang/plan-questions.json` + `.jonggrang/plan-answers.json`
  (already durable per §3.4). When `plan.md` is archived to
  `.jonggrang/.output/features/<id>/`, copy both sidecars alongside it.
- **Human-visible:** after Pass B, the CLI deterministically appends/updates a
  `## Clarifications` section in `plan.md` (idempotent) so the decisions are
  visible and travel with the plan even without the sidecar.
- **Revise reuses them:** `buildRevisePlanPrompt` (`lib/jonggrang.js:606`) gains an
  optional `clarifications` arg; `cmdPlan` revise branch (1041-1060) loads the
  answers store and passes it, so revisions respect prior decisions.
- **Revise can ask again:** `jonggrang plan ask` during a revise run appends new
  questions; their answers are **merged** into the answers store (new entries, prior
  ones preserved). This gives the "persistent + growable" Q&A across revisions.

---

## 7. P4 — `--deep` Mode Integration

Deep mode is the 3-phase pipeline discovery → analysis → condense
(`bin/jonggrang.js:1135-1193`).

- Insert the **same Pass-A question step at the start** of deep mode: run an
  analyze-goal pass that may call `plan ask`; collect answers (TTY) or emit
  (headless); persist to the durable store **before** the pipeline runs (deep mode
  wipes `.ephemeral` at the end — the durable store is unaffected).
- Inject answers into `buildDeepPlanDiscoveryPrompt` (line 2117) and
  `buildDeepPlanCondensePrompt` (line 2260) via an added `opts.clarifications` arg,
  so discovery is guided by the answers and the final plan honors them.
- Existing fallbacks (1158-1174) untouched.

---

## 8. P5 — Web Integration

The web spawns the CLI and streams output (`apis/projects/index.js`
`spawnForProject`/`wireProjectProcess`; `POST /:id/plan` at `apis/projects/plan.js:235`).
We keep that model and add a question round on top of the **durable store** + the
**`--answers-inline`** seam — no new planning logic on the server.

### 8.1 Flow

```
client: New Plan form → "Generate Plan"
   │  POST /:id/plan  { description, deep, tool, model, effort, base }      (existing)
   ▼
server: spawnForProject(['plan', desc, ...])  → PASS A runs in the project
   │  agent calls `jonggrang plan ask` → writes .jonggrang/plan-questions.json
   │  the spawned `plan` process is non-TTY → emits plan_questions signal & exits
   ▼
server: on that signal (or by watching the store file) → emit socket
        'plan.questions' { project_id, goal_analysis, questions }
   ▼
client: PlanView.vue renders a QUESTION FORM (radio + rationale hints,
        'type my own', checkboxes, textareas)
   │  POST /:id/plan/answers  { answers: [...] }
   ▼
server: validate answers → spawnForProject(['plan', desc, ...,
            '--answers-inline', base64(answers)])  → PASS B → writes plan.md
   ▼
client: existing plan.content / process.exited events render the plan  (unchanged)
```

### 8.2 Server changes (`apis/projects/plan.js`)

- **`POST /:id/plan/answers`** — new. Validate `answers` (array, bounded size, each
  `{id,type,value/freetext}`); reuse `tool/model/effort/base` validation from the
  existing handler (235-263). Spawn `plan … --answers-inline <b64>`; wire socket.
- Existing `POST /:id/plan` unchanged for the no-questions path; when the agent
  asks, the process emits `plan_questions` and the server relays `plan.questions`.
- Add `plan_questions` to whatever stdout-signal handling `wireProjectProcess`
  does (or have the server watch `.jonggrang/plan-questions.json`).

### 8.3 Client changes (`client/src/components/plan/PlanView.vue`)

- New **Questions step** between submit and result. Render each question:
  single_choice → radio group (label + muted rationale per option) + a "Type my
  own" radio revealing an input; multi_choice → checkboxes; text → textarea.
- New socket listener `plan.questions` (alongside the existing `plan.content` /
  `process.log` / `process.exited` handlers ~line 748).
- `generatePlan` (line 607) unchanged for the direct path; add `submitAnswers()`
  that POSTs to `/plan/answers`.

### 8.4 Sandbox note

Answers go in via `--answers-inline` (base64), not a host-written file, to avoid
the container-vs-host ownership EACCES problem on bind mounts. The agent's own
`plan ask` write lands in `.jonggrang/` inside the container, which is already
mirrored — same path the existing flow uses.

---

## 9. P6 — Orchestrate-Mode (OPTIONAL — confirm before building)

In orchestrate mode the Lead produces the architecture plan/tasks (Phase 7). A
clarification gate would sit **before** the Lead finalizes tasks, using the same
`plan ask` store + answers injection into `buildPhaseContext`.

**Caveat / tension:** orchestrate mode is designed to run **autonomously** (no
human in the loop mid-run). A blocking question round contradicts that. Options:
(a) only ask in `supervised` autonomy; (b) ask up-front (before phase 1) and store
answers in `MANIFEST.yaml`; (c) defer P6 entirely.

→ **Recommendation:** do P1-P5 first; treat P6 as a separate follow-up. I flagged
this because "semua out-of-scope dimasukkan" includes it — but it needs its own
decision given the autonomy conflict. **Tell me if you want P6 in this feature or
split out.**

---

## 10. Testing

### CLI (`/tmp`, `claude` backend)
- **P1:** §3.7 (call `plan ask` directly, no agent).
- **P2:** `jonggrang plan ask`-aware run end to end:
  ```bash
  node <repo>/bin/jonggrang.js plan "add login to the dashboard" --tool claude
  # expect: agent restates goal, runs `plan ask`, you answer interactively,
  #         then plan.md appears reflecting your answers
  ```
- **Headless:** ambiguous request in a non-TTY → `plan_questions` signal emitted,
  no plan.md; then `plan "<desc>" --answers answers.json` → plan.md.
- **P3:** answer once, run `plan --revise "…"`, confirm prior answers respected and
  `## Clarifications` present in plan.md.
- **P4:** `plan "<desc>" --deep` triggers the question round before the 3 phases.

### Web (P5)
- New Plan → ambiguous description → question form renders with rationales and
  "type my own" → submit → plan.md streams back. Sandbox + non-sandbox.

### Acceptance checklist
- [ ] `plan ask` works as an agent intake tool (3 input modes, validation).
- [ ] Agent uses it instead of guessing; clear requests skip questions.
- [ ] Each choice question shows per-option rationale + a free-text escape hatch.
- [ ] Answers visibly shape `plan.md`.
- [ ] `--answers` / `--answers-inline` drive Pass B without re-asking.
- [ ] Q&A persists; `--revise` reuses it; `## Clarifications` in plan.md.
- [ ] `--deep` asks before the pipeline; `.ephemeral` cleanup doesn't lose answers.
- [ ] Web form round-trips; sandbox path works via `--answers-inline`.
- [ ] Cancel/Ctrl-C writes no plan.

---

## 11. Resolved Decisions

1. **`plan ask` is agent-facing**, mirroring `task import` (per your correction).
2. **Subcommand name:** `jonggrang plan ask`.
3. **Max questions:** 6 per round.
4. **multi_choice:** included.
5. **Store is durable** (`.jonggrang/plan-*.json`, not `.ephemeral`) so revisions persist.
6. **Q&A is written into `plan.md`** (`## Clarifications`) *and* kept as JSON sidecar.
7. **Free-text escape hatch** ("Type my own") on every choice question.

### Still needs your call
- **P6 orchestrate-mode**: in this feature or split out? (see §9 caveat).
- **Default behavior**: should plain `jonggrang plan`/web "Generate" always allow
  the agent to ask, or only behind an explicit "ask first" toggle? → *Proposed:
  always allow asking; clear requests simply won't trigger it.*
- **Follow-up rounds**: allow a second question round after the first answers, or
  cap at one round per run (revise can add more)? → *Proposed: one round per run.*

---

## 12. Docs to Update (CLAUDE.md "Iron Rule")

| Change | Update |
|---|---|
| New `plan ask` subcommand + `--answers`/`--answers-inline` | `README.md` (Commands at a Glance + Quick flags), `docs/QUICKSTART.md`, `docs/EXAMPLE.md` |
| Question/answer flow in planning | `docs/WORKFLOW.md`, `docs/PHILOSOPHY.md` (planning step, "thin agent" framing) |
| `plan-questions.json` / `plan-answers.json` store | `docs/JONGGRANG.md` (Project File Structure) |
| Web question form + endpoints | `docs/UI.md` |
| Orchestrate gate (if P6) | `docs/ORCHESTRATION.md`, `docs/JONGGRANG.md` (16-phase) |

---

## 13. Dependencies (no new npm deps)

- `taskImport` / `cmdTask` pattern to mirror (`bin/jonggrang.js:2988, 3133`).
- `addTasksBulk` to mirror for `savePlanQuestions` (`lib/jonggrang.js`).
- `buildDraftPlanPrompt` (526) / `buildRevisePlanPrompt` (606) / deep prompts
  (2117, 2260) — extended with `clarifications`.
- `runAgent` (853) — unchanged.
- `@clack/prompts` `select`/`multiselect`/`text` (`bin/jonggrang.js:12`).
- `emitSignal` (271), `showPlanOptions` (1230) — reused.
- Web: `spawnForProject`/`wireProjectProcess` (`apis/projects/index.js`),
  `POST /:id/plan` (`apis/projects/plan.js:235`), `PlanView.vue` (607, ~748).
