---
feature: persist-generating-plan-across-refresh
branch: feat/persist-generating-plan-across-refresh
base: "main"
work_type: BUGFIX
description: Keep the in-flight "Generating plan..." view alive across a browser refresh via server-tracked plan processes
created_at: 2026-07-15T12:15:59.985Z
---

# Plan: Persist "Generating Plan" State Across Refresh

## Approach
Today plan operations (generate, answers/Pass B, revise, approve/decompose, extend) are spawned with `wireProjectProcess` but never tracked server-side, so the `generating` spinner lives only in `PlanView.vue` local state and vanishes on refresh — while the still-running planner's `plan.questions` event later pops the "plan ask" dialog with no context. Mirror the existing `activeWork` pattern: introduce a server-side `activePlan` registry keyed by project id that records each running plan op and its kind, register/deregister it around every plan-family spawn, and report it in the `subscribe` snapshot's `process` field (also flagging when a pending-questions draft exists). On (re)subscribe the client restores the correct spinner (generating/revising/approving) from that server truth, so the questions dialog only ever appears following a visible generating context.

## Phases
1. Server-side plan tracking — add an `activePlan` map alongside `activeWork` in `apis/projects/index.js`, expose it via `deps`, and register/deregister the child around every plan-family spawn (generate, answers, revise, extend in `plan.js`; approve in `approve.js`), storing the command kind and cleaning up on `close`.
2. Snapshot reporting — extend the `subscribe` snapshot's `process` field to report a running plan op (its command kind) in addition to `work`, and include a signal that a produced-but-unanswered questions draft exists so the client can distinguish "still generating" from "questions ready".
3. Client state restoration — thread the plan process/kind through the ws + process stores and have `PlanView.vue` restore `generating`/`revising`/`approving` (and re-attach the progress log) from the snapshot on mount/subscribe instead of defaulting them to false.
4. Questions-dialog sequencing — ensure `plan.questions` and any restored pending-questions state surface only after a visible generating context, so on refresh the user sees the spinner (or a clear "questions ready" continuation) rather than a bare dialog appearing from nowhere.
5. Verification — manually exercise refresh during each plan operation and during the Pass A→questions→Pass B flow, and run the existing test suite (notably the project-drafts / plan-related tests).

## Key Decisions
- Server-truth persistence via a dedicated `activePlan` map mirroring `activeWork`, rather than client-side storage — chosen per clarification so refresh reads live process state, not stale localStorage.
- Track the command kind (plan / plan-revise / plan-extend / approve) in the registry so the client restores the correct spinner label and log heading, not a generic "running" state.
- Represent pending-questions in the snapshot so the "plan ask" dialog is rendered as a continuation of a generating context, never cold — satisfying the "must not appear out of nowhere" requirement.
- Cover all spinner-bearing plan operations (generate, revise, approve/decompose, extend) in one consistent tracking mechanism to avoid partial fixes.

## Out of Scope
- Persisting or replaying the full historical process log across refresh (only the spinner/active-state is restored; log tail may resume from reconnect).
- Reworking the underlying planner CLI, the questions signal format, or the drafts-on-disk layout.
- Cancel/kill semantics for plan processes beyond what tracking makes trivially available (no new cancel UI unless already present for work).
- Any change to Work Mode / orchestration-run tracking beyond reusing its established pattern.

## Dependencies
Builds on the existing `activeWork` tracking pattern (`apis/projects/index.js`, `apis/projects/work.js`), the `subscribe`/`subscribed` snapshot flow and its `process` field, `wireProjectProcess`, the `plan.questions` socket event, the client `ws`/`process` Pinia stores, and `PlanView.vue`'s existing generating/revising/approving state.

<!-- jonggrang:clarifications -->
## Clarifications
_Captured from the planning Q&A:_

Goal: Make the in-flight 'Generating plan...' view in the jonggrang web PlanView survive a browser refresh, instead of vanishing and being replaced by the 'plan ask' clarifying-questions dialog. Root cause: the `generating` flag is local-only component state and plan processes aren't tracked server-side, so a refresh loses the spinner while the still-running planner's socket event surfaces the dialog with no context.

- **Which persistence mechanism should back the 'generating' state across refresh?** → Server-truth: track the running plan process (like `activeWork` does for `work`) and report it in the subscribe snapshot's `process` field; client restores the spinner from the snapshot
- **Which in-flight plan operations should persist across refresh?** → All plan operations that currently show a spinner (generate, revise, approve/decompose, extend)
- **On refresh, if the planner has already produced clarifying questions (a questions draft exists), what should the UI show?** → Show the 'plan ask' questions dialog, but only after (and clearly following from) a visible generating context — i.e. the dialog is fine once questions are truly ready, it just must not appear out of nowhere
