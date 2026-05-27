# DESIGN.md as a Design Artifact in Orchestrate Mode

> Design doc — how Jonggrang's orchestrate pipeline produces, consumes, and verifies
> a Google `DESIGN.md` design-token spec for UI/frontend work.
>
> **Status:** Approved design (pre-implementation) · **Date:** 2026-05-27 · **Scope:** Orchestrate mode only

---

## Problem

Coding agents that implement UI have no persistent sense of a project's visual
identity — colors, typography, spacing, component rules. Each fresh-context
agent re-guesses, producing inconsistent, "generic AI" UI. Jonggrang already
forces discipline on *code* quality through its pipeline; it has no equivalent
gate for *design* quality.

[Google DESIGN.md](https://github.com/google-labs-code/design.md) solves the
persistence problem: one git-tracked file holds machine-readable design tokens
(YAML front matter) plus human-readable rationale (markdown body), lintable for
WCAG contrast and broken references. This doc specifies how that artifact enters
Jonggrang's orchestrate pipeline.

## Goal

For features that touch UI, the pipeline should:

1. **Author** a `DESIGN.md` by gathering the user's preferences, references,
   assets, and extractable URLs into tokens + a Design Brief + narrative.
2. **Consume** it during implementation — the UI agent reads it, never hardcodes
   equivalent values.
3. **Verify** it twice: the spec itself (lint + WCAG), and the implemented UI
   against the spec (token compliance).

Non-goal: Work Loop mode (deferred). Non-goal: non-UI features — the whole flow
is gated and never runs for pure backend/api/database work.

## Scope gate: `has_ui`

The entire design flow is conditional. The Lead classifies `has_ui: bool` during
**Phase 2 (Triage)**, alongside the existing `work_type` classification, inferred
from the description and discovery (UI/frontend keywords, or discovery finding a
`frontend` domain). Design phases enter `active_phases` only when `has_ui` is
true — the same mechanism as phase-skipping by work type.

## Architecture decision: a sixth role, **Designer**

We add a dedicated **Designer** specialist role rather than attaching design work
to the Lead. Rationale: in a real team the designer is distinct from the lead and
the engineer, and design-token taste (gather → extract → construct → verify) is a
specific domain of work. This is consistent with Jonggrang's assembly-line
identity — each role owns one kind of work.

### Designer role definition

| Aspect | Value |
|---|---|
| Agent | `*-designer` |
| Responsibilities | Gather → Extract → Construct → self-lint `DESIGN.md` (spec); verify UI vs tokens |
| Primary skill | `design-md` (library, via `gateway-design`) |
| Completion signals | `DESIGN_COMPLETE` (author phase), `DESIGN_UI_VERIFIED` (UI verify phase) |

`DESIGN_UI_VERIFIED` is a distinct signal (not reused `REVIEW_COMPLETE`) because
the Designer is a domain-specific worker, not the general Reviewer.

### Tool boundary

| Can use | Cannot use | Why |
|---|---|---|
| `Read`, `Bash`, `Task` | `Edit`, `Write` | Designer is a **coordinator + verifier**, not an executor |

- `Bash` — required for `npx @google/design.md lint`, WCAG checks, and DevTools/CSS
  extraction from reference URLs.
- `Task` — spawn extraction sub-agents (mirrors Lead).
- **Emit-pattern** — Designer emits `DESIGN.md` content as its phase output; the
  platform persists it to disk, exactly as the Lead emits `architecture_plan_json`
  (Phase 7) and the TestLead emits `test_plan_json` (Phase 12). No `Write` needed,
  no tool-boundary violation.

### Verify discipline (author ≠ reviewer-of-same-artifact)

The Designer holds **both** verify points without breaking Jonggrang's read-only
reviewer principle, because the spec and the UI are *different artifacts*:

- **Review point #1 — spec validity:** Designer runs `lint` + WCAG while
  constructing. This is a *deterministic self-check* (a CLI, not subjective
  judgment) and is a normal part of "construct."
- **Review point #2 — UI vs spec:** Designer reviews the **Developer's** UI
  output. Different artifact, different author → this is *independent review*, not
  self-review.

The existing **Reviewer** role is untouched and keeps code-quality, compliance,
and test-quality phases.

## Phase placement

New phases run only when `has_ui`. The old Phase 9 name **`DesignVerify`** is kept
as-is (it verifies software design vs architecture plan — unrelated to UI tokens)
to minimize moving parts.

| Phase | Name | Role | Work |
|---|---|---|---|
| 2 *(extend)* | Triage | Lead | + classify `has_ui` |
| between 6–7 | **DesignSystem** *(human pause)* | **Designer** | Gather references/assets/URLs → extract → construct `DESIGN.md` → self-lint. Emits `DESIGN_COMPLETE` |
| 8 *(extend)* | Implement | Developer | Read `DESIGN.md`, use tokens, never hardcode equivalents |
| review cluster | **DesignVerifyUI** | **Designer** | Verify UI complies with `DESIGN.md` tokens. Emits `DESIGN_UI_VERIFIED` |

**Why DesignSystem sits between Brainstorm (6) and Architect (7):**

1. The architecture plan for a UI feature should reference the design system —
   `DESIGN.md`'s `components:` section (button-primary, card, input) informs
   component architecture. Designer runs first; Architect references its output.
2. Brainstorm (6) is already a human-pause. Placing the design human-pause
   adjacent consolidates user interaction into one window instead of scattering
   pauses across the pipeline.

Consequence: the pipeline grows from 16 to ~18 phases; `active_phases` gains two
entries only when `has_ui`. Docs to update: WORKFLOW.md, JONGGRANG.md,
ORCHESTRATION.md, PHILOSOPHY.md, templates/agents/.

## Skill placement

`design-md` is needed only for UI work → **library tier**, routed via a gateway,
matching the existing Gateway Pattern (`gateway-frontend`, `gateway-backend`, …):

```
skills/
├── core/
│   └── gateway-design/        ← NEW (lightweight router only)
└── library/
    └── design/
        └── design-md/
            ├── SKILL.md        ← copied from ~/.hermes-skills/creative/design-md
            └── references/     ← deep-research.md, fusion, narrative (JIT-loaded)
```

Flow: Designer invokes `gateway-design` → gateway returns
`Read skills/library/design/design-md/SKILL.md`.

## Artifact location

`DESIGN.md` is canonical at **project root**, git-tracked — the single source of
truth, read every session. The first UI feature *creates* it; later features
*read + extend* it, using `diff` to detect regressions across features.

| Location | Holds | Nature |
|---|---|---|
| `./DESIGN.md` | Canonical token spec | Living, git-tracked |
| `.jonggrang/jonggrang.json` → `design` | Pointer + settings | Config |
| `.jonggrang/.output/features/<id>/` | Per-feature snapshot + diff report | Audit trail |

Config schema addition in `jonggrang.json`:

```jsonc
{
  "design": {
    "enabled": true,            // or auto-on when triage sets has_ui
    "artifact": "./DESIGN.md",  // canonical path, project root
    "lint": true,               // run npx @google/design.md lint
    "wcag": "AA"                // contrast threshold
  }
}
```

`AGENTS.md` gains a line — *"Always read DESIGN.md before generating UI; never
hardcode color values"* — so the Developer reads it during Implement (the
integration pattern from the design-md skill).

## Feedback-loop integration

A `frontend` domain currently reaches `COMPLETE` when `review=PASS AND test=PASS`.
We add a conditional third gate for the frontend domain when `has_ui`:

```
frontend COMPLETE  ⟺  review=PASS  AND  test=PASS  AND  design=PASS
```

Mechanism reuses the existing dirty-bit state machine exactly:

1. Developer edits `src/components/**` → `frontend: PENDING`.
2. `DesignVerifyUI` (Designer) checks UI vs tokens:
   - pass → `feedback.recordPhaseResult("designer", "frontend", "pass")`
   - fail → **all domains reset to PENDING** (existing reset-on-fail rule) → loop
     back to Developer.
3. Exit blocked until `frontend` passes all three gates.

Properties:
- **Conditional** — the `design` gate applies only to the `frontend` domain and
  only when `has_ui`. backend/api/database domains are untouched.
- **Consistent** — the Designer becomes a phase-result recorder for the frontend
  domain, peer to Reviewer and Tester. No new mechanism, one new contributor to
  the existing state machine.

## MANIFEST.yaml additions

```yaml
has_ui: true
agents:
  designer: { model: claude-sonnet-4-5 }
active_phases: [ ..., <DesignSystem>, ..., <DesignVerifyUI>, ... ]  # only when has_ui
design_artifact: "./DESIGN.md"
```

## Decision summary

| Aspect | Decision |
|---|---|
| Structure | New specialist role **Designer** (6th role) |
| Tool boundary | `Read`/`Bash`/`Task`, no Edit/Write (emit-pattern) |
| Designer tasks | Gather → Extract → Construct → self-lint (spec) + DesignVerifyUI (UI vs tokens) |
| New phases | `DesignSystem` (between Brainstorm 6 & Architect 7, human-pause) + `DesignVerifyUI` (review cluster); old `DesignVerify` name kept |
| Gating | `has_ui` classified at Triage (Phase 2) |
| Completion signals | `DESIGN_COMPLETE` (author), `DESIGN_UI_VERIFIED` (verify) |
| Skill | `library/design/design-md/` + core `gateway-design` |
| Artifact | `./DESIGN.md` root + `design` pointer in jonggrang.json + per-feature snapshot |
| Feedback-loop | third `design=PASS` gate for frontend domain, conditional on `has_ui` |

## Open items for implementation

- Exact final phase numbers after inserting two phases (renumber vs. fractional).
- `gateway-design` content (intent detection → returns design-md skill files).
- How `has_ui` is detected precisely (keyword heuristics vs. discovery domain signal).
- Whether `DESIGN.md` authoring is skipped when one already exists and the feature
  is a minor UI tweak (author vs. extend-existing decision).
- Docs to update per CLAUDE.md "Iron Rule": WORKFLOW, JONGGRANG, ORCHESTRATION,
  PHILOSOPHY, CONFIG, SKILLS, AGENTTOOLS, templates/agents/.
