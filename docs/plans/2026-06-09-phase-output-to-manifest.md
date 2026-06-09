# Plan — Capture per-phase agent output into MANIFEST (Opsi A)

Date: 2026-06-09
Status: proposed
Branch target: `feat/design-md` (or follow-up)

## Problem

In the orchestrate pipeline, the success path never records the agent's
result/summary to the manifest. `runAgent` resolves with only an exit code
(number); its text is streamed to stdout but discarded. The orchestrate loop
then calls `completePhase(manifestPath, phaseNum)` **without** an `output`
argument (`bin/jonggrang.js:2045`), and `completePhase` only writes
`phases[n].output` when an output arg is passed (`lib/orchestration.js:243`).

Result: on success, `manifest.phases[n].output` is empty for every
agent-running phase (implementation, **simplify (9)**, design-verification,
compliance, quality, test, etc.). `output` is only populated on failure
(`failPhase` → `{ error }`), on dry-run (`{ dry_run: true }`), or for the
short-circuit phases that pass their own small object (setup → `{ manifest_path }`,
triage → `{ work_type }`, design-skip → `{ skipped }`).

This is inconsistent with the design-system phase (6.5), which uses an
emit→persist convention (`06_5-designer-design-md.md` → `DESIGN.md`) and is the
only phase whose artifact is actually traceable.

## Goal

Every agent-running phase in the **orchestrate** pipeline records a (truncated)
summary of its agent output into `manifest.phases[n].output`, so the run is
auditable. Out of scope: the `work-loop` / `plan` / `approve` paths (lines
415/522/545/628/1326) which use a different `{ source }` convention and do not
run through this loop.

## Approach

### 1. `runAgent` returns text as well as exit code — backward compatible

`lib/jonggrang.js:816` currently resolves with `code` (number). Change every
`resolve(...)` to resolve with an object `{ code, text }`, while keeping a
backward-compatible shim so existing callers that treat the result as a number
do not break.

Options for compatibility:
- Return a `Number` subclass / boxed value — fragile, avoid.
- **Preferred:** update all call sites to read `.code`. There are a handful
  (`grep -n 'runAgent(' bin/jonggrang.js lib/jonggrang.js`). Update them to
  destructure `{ code, text }` (or `const r = await runAgent(...); r.code`).

Accumulate `text` from the same stream that is already written to stdout
(the `process.stdout.write(text)` points around `lib/jonggrang.js:858`), into a
buffer per run. Cap the buffer while accumulating to avoid unbounded memory.

### 2. Truncate before persisting

Agent transcripts can be large; MANIFEST.yaml must stay small. Follow the
existing repo convention (`progressContent.slice(-2000)` at
`bin/jonggrang.js:2030`). Keep only the **tail** (the summary tends to be last),
e.g. `text.slice(-2000)`, or extract the final summary block. Make the cap a
named constant (e.g. `PHASE_OUTPUT_MAX = 2000`).

### 3. Aggregate per-file simplify

Simplify (phase 9) may run N agents (one per changed file) in the
`for (const unit of phaseUnits)` loop at `bin/jonggrang.js:2051`. Collect each
unit's text instead of overwriting:

```js
let exitCode = 0;
const unitOutputs = [];
for (const unit of phaseUnits) {
  if (unit.label) logInfo(`  → simplify: ${unit.label}`);
  const { code, text } = await lib.runAgent(buildPrompt(unit.core), activeTool, activeMode, PROJECT_ROOT, { debug: DEBUG, model: MODEL, effort: EFFORT });
  unitOutputs.push({ label: unit.label, summary: (text || '').slice(-PHASE_OUTPUT_MAX) });
  exitCode = code;
  if (exitCode !== 0) break;
}
```

### 4. Pass output into completePhase

At the success branch (`bin/jonggrang.js:2045`):

```js
} else {
  const output = phaseUnits.length > 1
    ? { units: unitOutputs }
    : { summary: unitOutputs[0]?.summary || '' };
  orchestration.completePhase(manifestPath, phaseNum, output);
  logSuccess(`Phase ${phaseNum} complete`);
}
```

`completePhase` already persists `output` when provided — no change needed there.

## Files touched

- `lib/jonggrang.js` — `runAgent` returns `{ code, text }`; update internal callers.
- `bin/jonggrang.js` — capture/aggregate/truncate text; pass output to `completePhase`;
  update any other `runAgent(` call sites to read `.code`.
- (no change to `lib/orchestration.js` `completePhase` — already supports `output`.)

## Verification

1. Run a small orchestrate feature end-to-end; inspect
   `.jonggrang/.output/features/{id}/MANIFEST.yaml` — confirm each completed
   agent phase has a non-empty `output.summary` (or `output.units` for split
   simplify), and that the file size stays reasonable (truncation works).
2. Confirm failure path still records `{ error }` (unchanged).
3. Confirm `work-loop` / `plan` / `approve` still pass (callers updated to `.code`).
4. `node -c bin/jonggrang.js && node -c lib/jonggrang.js`.

## Docs to update (per CLAUDE.md Iron Rule)

- `docs/JONGGRANG.md` / `docs/PHILOSOPHY.md` — Persistent State / MANIFEST sections:
  document that each phase now records a truncated `output` summary.
