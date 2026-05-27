# DESIGN.md Orchestration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `DESIGN.md` design-artifact flow to Jonggrang's orchestrate pipeline — a sixth **Designer** role, two `has_ui`-gated phases (DesignSystem authoring + DesignVerifyUI compliance), a third `design=PASS` feedback gate for the frontend domain, plus skill/config/docs wiring.

**Architecture:** The two new phases are inserted as **fractional phase numbers** (`6.5` DesignSystem, `11.5` DesignVerifyUI) so nothing renumbers — `getActivePhases` sorts numerically and tolerates floats. `has_ui` is classified at triage and gates a new `DESIGN_PHASES` skip-set, orthogonal to the existing `work_type` `PHASE_SKIP_MAP`. The Designer holds no `Edit`/`Write`; it emits `DESIGN.md` content (emit-pattern, like the Lead's architecture plan) and verifies the Developer's UI. Role identity is expressed through dedicated prompt builders (mirroring `buildSimplifyPrompt`) and an agent template — the orchestrate loop special-cases phases by number, it does not gate tools per phase.

**Tech Stack:** Node.js (CommonJS), `js-yaml`, no test framework — tests are self-contained `node` scripts using `assert` and a local `test(name, fn)` helper (mirror `test/backend-args.test.js`). Run individually with `node test/<file>.test.js`.

---

## Reference: exact current state (verified)

- `lib/orchestration.js` — `PHASES` (1–17, integer-keyed object) at lines 15–33; `HEAVY_PHASES` line 36; `PHASE_SKIP_MAP` lines 39–44; `classifyWorkType` 56–87; `getActivePhases(workType)` 94–100; `createManifest(projectRoot, featureId, description, workType)` 148–184; `buildSimplifyPrompt` 430–473; `buildPhaseContext` 483–500; `SIMPLIFY_PHASE = 9` line 374; exports 502–526.
- `lib/roles.js` — `ROLES` 12–63; `ASSEMBLY_LINE` 70; `PHASE_ROLE_MAP` 73–90 (**off-by-one vs PHASES, pre-existing, not used by the orchestrate loop — do NOT "fix" it in this plan**); `getCompletionSignals`/`detectCompletionSignal` 196–214; exports 216–231.
- `lib/feedback.js` — `createDefaultState` 25–39; `activateFeedbackLoop` 75–93; `setDirtyBit` 99–121; `recordPhaseResult(projectRoot, domain, phase, status, agentName)` 127–168 (hardcodes `review`+`testing`); `checkExitGate` 178–215 (hardcodes `review`+`testing`); exports 276–288.
- `lib/gateway.js` — `DOMAINS` 13–21; `ROUTING_TABLE` 29–50; `DOMAIN_KEYWORDS` 56–64; `DOMAIN_PRIORITY` 67; exports 226–238.
- `bin/jonggrang.js` — orchestrate entry classifies work type at 1758–1759, creates manifest 1768; `runOrchestrationLoop` 1780–1894 (phase `for` loop with `if (phaseNum === N)` special-cases at 1810/1818/1826/1838).
- `templates/agents/lead.md` — agent template shape (YAML frontmatter + identity + output schema + signal).
- `test/backend-args.test.js` — test idiom.

**DRY/YAGNI/TDD note:** Each lib change is unit-tested first. The loop wiring (Task 7) and asset/doc tasks (8–10) are verified by running commands / dry-run, not unit tests (no behavior to assert in isolation).

---

## Task 1: `has_ui` classification in orchestration.js

**Files:**
- Modify: `lib/orchestration.js` (add `classifyHasUi`, export it)
- Test: `test/orchestration-design.test.js` (new)

**Step 1: Write the failing test**

Create `test/orchestration-design.test.js`:

```js
'use strict';
const assert = require('assert');
const o = require('../lib/orchestration');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\norchestration.js — design flow\n');

// ── classifyHasUi ─────────────────────────────────────────────
test('classifyHasUi: true for frontend/UI keywords', () => {
  assert.strictEqual(o.classifyHasUi('Build a settings page with a form and modal'), true);
  assert.strictEqual(o.classifyHasUi('Add a React dashboard component'), true);
});
test('classifyHasUi: false for pure backend work', () => {
  assert.strictEqual(o.classifyHasUi('Add a webhook handler and a queue worker'), false);
  assert.strictEqual(o.classifyHasUi('Optimize the database migration'), false);
});
test('classifyHasUi: hint overrides heuristic', () => {
  assert.strictEqual(o.classifyHasUi('Add a queue worker', { hasUi: true }), true);
  assert.strictEqual(o.classifyHasUi('Build a UI page', { hasUi: false }), false);
});

process.exit(failed === 0 ? 0 : 1);
```

**Step 2: Run to verify it fails**

Run: `node test/orchestration-design.test.js`
Expected: FAIL — `o.classifyHasUi is not a function`.

**Step 3: Implement `classifyHasUi`**

In `lib/orchestration.js`, after `classifyWorkType` (after line 87), add:

```js
// UI / frontend signal keywords — used to gate the design (DESIGN.md) phases.
const UI_KEYWORDS = /\b(ui|ux|frontend|front-end|client-side|component|page|screen|view|button|form|modal|dialog|layout|dashboard|css|tailwind|styl(e|ing)|react|vue|angular|svelte|next\.?js|nuxt|responsive|theme|design system|landing|navbar|sidebar|menu)\b/;

/**
 * Decide whether a feature touches UI/frontend, gating the design phases.
 * @param {string} description
 * @param {object} hints - optional { hasUi: boolean } explicit override
 * @returns {boolean}
 */
function classifyHasUi(description, hints = {}) {
  if (typeof hints.hasUi === 'boolean') return hints.hasUi;
  return UI_KEYWORDS.test((description || '').toLowerCase());
}
```

Add `classifyHasUi` to the `module.exports` block (after `classifyWorkType,` near line 506).

**Step 4: Run to verify it passes**

Run: `node test/orchestration-design.test.js`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add lib/orchestration.js test/orchestration-design.test.js
git commit -m "feat: add has_ui classification for design phase gating"
```

---

## Task 2: Fractional design phases + `has_ui`-gated `getActivePhases` + manifest fields

**Files:**
- Modify: `lib/orchestration.js` (PHASES entries, DESIGN_PHASES set, phase-number constants, `getActivePhases` signature, `createManifest` signature)
- Test: `test/orchestration-design.test.js` (extend)

**Step 1: Write the failing tests**

Append to `test/orchestration-design.test.js` (before the final `process.exit`):

```js
// ── phase constants ───────────────────────────────────────────
test('design phase constants are fractional and registered in PHASES', () => {
  assert.strictEqual(o.DESIGN_SYSTEM_PHASE, 6.5);
  assert.strictEqual(o.DESIGN_VERIFY_UI_PHASE, 11.5);
  assert.ok(o.PHASES[6.5] && o.PHASES[6.5].name === 'design-system');
  assert.ok(o.PHASES[11.5] && o.PHASES[11.5].name === 'design-verify-ui');
});

// ── getActivePhases gating ────────────────────────────────────
test('getActivePhases: excludes design phases when hasUi is false', () => {
  const phases = o.getActivePhases('MEDIUM', { hasUi: false });
  assert.ok(!phases.includes(6.5));
  assert.ok(!phases.includes(11.5));
});
test('getActivePhases: includes design phases when hasUi is true', () => {
  const phases = o.getActivePhases('MEDIUM', { hasUi: true });
  assert.ok(phases.includes(6.5));
  assert.ok(phases.includes(11.5));
  // ordering: 6.5 sits between 6 and 7; 11.5 between 11 and 12
  assert.ok(phases.indexOf(6.5) > phases.indexOf(6));
  assert.ok(phases.indexOf(6.5) < phases.indexOf(7));
  assert.ok(phases.indexOf(11.5) > phases.indexOf(11));
  assert.ok(phases.indexOf(11.5) < phases.indexOf(12));
});
test('getActivePhases: default (no opts) excludes design phases — backward compatible', () => {
  const phases = o.getActivePhases('MEDIUM');
  assert.ok(!phases.includes(6.5));
  assert.ok(!phases.includes(11.5));
});
```

**Step 2: Run to verify it fails**

Run: `node test/orchestration-design.test.js`
Expected: FAIL — `o.DESIGN_SYSTEM_PHASE` undefined / `PHASES[6.5]` undefined.

**Step 3: Implement**

In `lib/orchestration.js`:

(a) Add the two fractional phases to the `PHASES` object (insert after line 21 `6: brainstorming` and after line 26 `11: domain-compliance` — JS object literals keep insertion order, but order is irrelevant since `getActivePhases` sorts; place them logically):

```js
  6:   { name: 'brainstorming',       description: 'Design refinement with human-in-loop' },
  6.5: { name: 'design-system',       description: 'Author DESIGN.md: gather references/assets/URLs, extract tokens, construct Design Brief + narrative, self-lint (WCAG + broken refs). UI work only.' },
  7:   { name: 'architecting',        description: 'Technical design AND task decomposition' },
```

```js
  11:   { name: 'domain-compliance',  description: 'Domain-specific mandatory patterns' },
  11.5: { name: 'design-verify-ui',   description: 'Verify implemented UI complies with DESIGN.md tokens. UI work only.' },
  12:   { name: 'code-quality',       description: 'Code review for maintainability' },
```

(b) After `HEAVY_PHASES` (line 36), add the gate set and constants:

```js
// Design phases — gated by has_ui (orthogonal to work_type PHASE_SKIP_MAP)
const DESIGN_SYSTEM_PHASE = 6.5;
const DESIGN_VERIFY_UI_PHASE = 11.5;
const DESIGN_PHASES = new Set([DESIGN_SYSTEM_PHASE, DESIGN_VERIFY_UI_PHASE]);
```

(c) Change `getActivePhases` (lines 94–100) to accept options and strip design phases when `!hasUi`:

```js
function getActivePhases(workType, opts = {}) {
  const { hasUi = false } = opts;
  const skip = PHASE_SKIP_MAP[workType] || new Set();
  return Object.keys(PHASES)
    .map(Number)
    .filter(n => !skip.has(n))
    .filter(n => hasUi || !DESIGN_PHASES.has(n))
    .sort((a, b) => a - b);
}
```

(d) Change `createManifest` (line 148) to accept and persist `hasUi`:

```js
function createManifest(projectRoot, featureId, description, workType, opts = {}) {
  const { hasUi = false } = opts;
  const activePhases = getActivePhases(workType, { hasUi });
  const manifest = {
    feature_id: featureId,
    description,
    work_type: workType,
    has_ui: hasUi,
    design_artifact: hasUi ? './DESIGN.md' : null,
    created_at: new Date().toISOString(),
    // ...rest unchanged...
```

(Leave the rest of `createManifest` body exactly as-is — the `for (const phaseNum of activePhases)` loop already keys `manifest.phases` by phase number and works with `6.5`/`11.5`.)

(e) Add to `module.exports`: `DESIGN_PHASES, DESIGN_SYSTEM_PHASE, DESIGN_VERIFY_UI_PHASE` (next to `HEAVY_PHASES`).

**Step 4: Run to verify it passes**

Run: `node test/orchestration-design.test.js`
Expected: PASS (all tests so far).

Also run existing suite to confirm no regression:
Run: `npm test`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/orchestration.js test/orchestration-design.test.js
git commit -m "feat: add fractional design phases gated by has_ui"
```

---

## Task 3: Designer role + completion signals in roles.js

**Files:**
- Modify: `lib/roles.js` (`ROLES.designer`, `PHASE_ROLE_MAP` fractional entries)
- Test: `test/roles-designer.test.js` (new)

**Step 1: Write the failing test**

Create `test/roles-designer.test.js`:

```js
'use strict';
const assert = require('assert');
const r = require('../lib/roles');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nroles.js — designer role\n');

test('designer role exists with coordinator+verifier tool boundary', () => {
  const d = r.getRole('designer');
  assert.ok(d, 'designer role missing');
  assert.deepStrictEqual(d.tools.sort(), ['Bash', 'Read', 'Task'].sort());
  assert.ok(d.forbidden_tools.includes('Edit'));
  assert.ok(d.forbidden_tools.includes('Write'));
});
test('designer is a coordinator (has Task) and not an executor (no Edit/Write)', () => {
  assert.strictEqual(r.isCoordinator('designer'), true);
  assert.strictEqual(r.isExecutor('designer'), false);
});
test('completion signals registered for designer', () => {
  const signals = r.getCompletionSignals();
  assert.strictEqual(signals['DESIGN_COMPLETE'], 'designer');
  // DESIGN_UI_VERIFIED detectable
  assert.deepStrictEqual(r.detectCompletionSignal('...DESIGN_UI_VERIFIED...'),
    { signal: 'DESIGN_UI_VERIFIED', role: 'designer' });
});

process.exit(failed === 0 ? 0 : 1);
```

**Step 2: Run to verify it fails**

Run: `node test/roles-designer.test.js`
Expected: FAIL — `getRole('designer')` returns null.

**Step 3: Implement**

In `lib/roles.js`, add to the `ROLES` object (after the `tester` entry, before the closing `}` at line 63):

```js
  designer: {
    name: 'designer',
    label: 'Specialized Designer',
    responsibility: 'Design system. Authors and verifies DESIGN.md tokens. Gathers references, extracts tokens, constructs Brief + narrative, verifies UI compliance. Does NOT write source code.',
    tools: ['Read', 'Bash', 'Task'],            // coordinator + verifier: lint via Bash, extract via Task; emits DESIGN.md
    forbidden_tools: ['Edit', 'Write'],
    output_format: 'design_md',
    agent_definition: 'templates/agents/designer.md',
    completion_signal: 'DESIGN_COMPLETE',
  },
```

`detectCompletionSignal`/`getCompletionSignals` derive from `ROLES[*].completion_signal`, so `DESIGN_COMPLETE` is auto-registered. The **second** signal `DESIGN_UI_VERIFIED` is not a `ROLES` field — add it explicitly. Change `getCompletionSignals` (lines 196–202) to include extra signals:

```js
// Extra completion signals not tied 1:1 to a role's primary output.
const EXTRA_SIGNALS = { DESIGN_UI_VERIFIED: 'designer' };

function getCompletionSignals() {
  const signals = {};
  for (const [name, role] of Object.entries(ROLES)) {
    signals[role.completion_signal] = name;
  }
  return { ...signals, ...EXTRA_SIGNALS };
}
```

Add fractional entries to `PHASE_ROLE_MAP` (for consistency / team mode — note the loop does not consume this map, but keep the registry coherent):

```js
  6.5:  'designer',  // design-system — designer authors DESIGN.md
  11.5: 'designer',  // design-verify-ui — designer verifies UI vs tokens
```

(Do NOT add `designer` to `ASSEMBLY_LINE` — it is conditional, not part of the standard linear cycle.)

**Step 4: Run to verify it passes**

Run: `node test/roles-designer.test.js`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add lib/roles.js test/roles-designer.test.js
git commit -m "feat: add Designer role and design completion signals"
```

---

## Task 4: `gateway-design` domain in gateway.js

**Files:**
- Modify: `lib/gateway.js` (`DOMAINS`, `ROUTING_TABLE`, `DOMAIN_KEYWORDS`, `DOMAIN_PRIORITY`)
- Test: `test/gateway-design.test.js` (new)

**Step 1: Write the failing test**

Create `test/gateway-design.test.js`:

```js
'use strict';
const assert = require('assert');
const g = require('../lib/gateway');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\ngateway.js — design domain\n');

test('design domain registered with gateway-design skill', () => {
  assert.ok(g.DOMAINS.design);
  assert.strictEqual(g.DOMAINS.design.gateway_skill, 'gateway-design');
});
test('design-token intent routes to design-md skill', () => {
  const skills = g.routeToSkills('create a design system with design tokens and a color palette');
  assert.ok(skills.includes('design/design-md'));
});

process.exit(failed === 0 ? 0 : 1);
```

**Step 2: Run to verify it fails**

Run: `node test/gateway-design.test.js`
Expected: FAIL — `g.DOMAINS.design` undefined.

**Step 3: Implement**

In `lib/gateway.js`:

(a) Add to `DOMAINS` (after line 18):

```js
  design:   { label: 'Design',   gateway_skill: 'gateway-design' },
```

(b) Add a `design` block to `ROUTING_TABLE` (after the `database` block, line 49):

```js
  design: [
    { keywords: ['design token', 'design system', 'design.md', 'color palette', 'typography', 'wcag', 'theme', 'visual identity'], skill: 'design/design-md' },
  ],
```

(c) Add to `DOMAIN_KEYWORDS` (after line 63):

```js
  design:   ['design token', 'design system', 'design.md', 'palette', 'typography', 'wcag', 'contrast', 'visual identity', 'brand', 'theme'],
```

(d) Add `design` to `DOMAIN_PRIORITY` (line 67) — place it before `frontend` so design-token intent wins over generic frontend:

```js
const DOMAIN_PRIORITY = ['testing', 'database', 'deploy', 'security', 'design', 'frontend', 'api', 'backend'];
```

**Step 4: Run to verify it passes**

Run: `node test/gateway-design.test.js`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add lib/gateway.js test/gateway-design.test.js
git commit -m "feat: add design domain and gateway-design routing"
```

---

## Task 5: Generalized multi-gate feedback loop with conditional `design` sub-phase

**Files:**
- Modify: `lib/feedback.js` (`activateFeedbackLoop`, `setDirtyBit`, `recordPhaseResult`, `checkExitGate`)
- Test: `test/feedback-design.test.js` (new)

**Approach:** Replace the hardcoded `review`+`testing` PASS checks with "every sub-phase present in `domain_phases[d]` is PASS". When `has_ui` and domain is `frontend`, seed a `design` sub-phase so the generalized check naturally requires `design=PASS`. backend/api/database are untouched (only review+testing seeded).

**Step 1: Write the failing test**

Create `test/feedback-design.test.js`:

```js
'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const fb = require('../lib/feedback');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-fb-'));
  return d;
}

console.log('\nfeedback.js — design gate\n');

test('frontend with hasUi requires design=PASS to exit', () => {
  const root = tmpRoot();
  fb.activateFeedbackLoop(root, 'frontend', { hasUi: true });
  fb.recordPhaseResult(root, 'frontend', 'review', 'PASS', 'reviewer');
  fb.recordPhaseResult(root, 'frontend', 'testing', 'PASS', 'tester');
  let gate = fb.checkExitGate(root);
  assert.strictEqual(gate.allowed, false, 'should block: design still PENDING');
  fb.recordPhaseResult(root, 'frontend', 'design', 'PASS', 'designer');
  gate = fb.checkExitGate(root);
  assert.strictEqual(gate.allowed, true, 'should allow: all three gates PASS');
});

test('backend domain unaffected — review+testing only', () => {
  const root = tmpRoot();
  fb.activateFeedbackLoop(root, 'backend');
  fb.recordPhaseResult(root, 'backend', 'review', 'PASS', 'reviewer');
  fb.recordPhaseResult(root, 'backend', 'testing', 'PASS', 'tester');
  const gate = fb.checkExitGate(root);
  assert.strictEqual(gate.allowed, true);
});

test('design FAIL resets and blocks exit', () => {
  const root = tmpRoot();
  fb.activateFeedbackLoop(root, 'frontend', { hasUi: true });
  fb.recordPhaseResult(root, 'frontend', 'review', 'PASS', 'reviewer');
  fb.recordPhaseResult(root, 'frontend', 'testing', 'PASS', 'tester');
  const { allPassed } = fb.recordPhaseResult(root, 'frontend', 'design', 'FAIL', 'designer');
  assert.strictEqual(allPassed, false);
  assert.strictEqual(fb.checkExitGate(root).allowed, false);
});

process.exit(failed === 0 ? 0 : 1);
```

**Step 2: Run to verify it fails**

Run: `node test/feedback-design.test.js`
Expected: FAIL — `activateFeedbackLoop` ignores `hasUi`, no `design` sub-phase, so first test's gate is `allowed:true` after only review+testing.

**Step 3: Implement**

In `lib/feedback.js`:

(a) `activateFeedbackLoop` (line 75) — accept opts and seed `design` for frontend+hasUi:

```js
function activateFeedbackLoop(projectRoot, domain, opts = {}) {
  const { hasUi = false } = opts;
  const state = readFeedbackState(projectRoot);
  state.active = true;
  state.dirty_bit = true;

  if (!state.modified_domains.includes(domain)) {
    state.modified_domains.push(domain);
  }

  if (!state.domain_phases[domain]) {
    state.domain_phases[domain] = {
      review:  { status: 'PENDING', agent: null, timestamp: null },
      testing: { status: 'PENDING', agent: null, timestamp: null },
    };
  }
  if (hasUi && domain === 'frontend' && !state.domain_phases[domain].design) {
    state.domain_phases[domain].design = { status: 'PENDING', agent: null, timestamp: null };
  }

  writeFeedbackState(projectRoot, state);
  return state;
}
```

(b) Add a small generalized helper near the top of the PASS/FAIL section (before `recordPhaseResult`):

```js
// A domain is satisfied when every sub-phase it has is PASS.
function domainPassed(dp) {
  return dp && Object.values(dp).every(p => p.status === 'PASS');
}
// Reset every sub-phase of a domain to PENDING (preserves which sub-phases exist).
function resetDomain(dp) {
  if (!dp) return;
  for (const p of Object.values(dp)) p.status = 'PENDING';
}
```

(c) `recordPhaseResult` (line 127) — generalize reset + allPassed:

Replace the reset-on-FAIL block (lines 143–154) with:

```js
  // If any domain FAILS, reset ALL other domains for next iteration
  if (status === 'FAIL') {
    for (const d of state.modified_domains) {
      if (d !== domain) resetDomain(state.domain_phases[d]);
    }
    state.dirty_bit = true;
  }
```

Replace the `allPassed` computation (lines 157–160) with:

```js
  const allPassed = state.modified_domains.every(d => domainPassed(state.domain_phases[d]));
```

(d) `checkExitGate` (line 178) — generalize `blockedDomains` (lines 189–192):

```js
  const blockedDomains = state.modified_domains.filter(d => !domainPassed(state.domain_phases[d]));
```

And update the `pendingStr` builder (lines 201–206) to print all sub-phases generically:

```js
  const pendingStr = blockedDomains.map(d => {
    const dp = state.domain_phases[d] || {};
    const parts = Object.entries(dp).map(([phase, v]) => `${phase}=${v.status}`).join(', ');
    return `  ${d}: ${parts}`;
  }).join('\n');
```

**Step 4: Run to verify it passes**

Run: `node test/feedback-design.test.js`
Expected: PASS (3 tests).

Regression check (this file changed core gate logic):
Run: `npm test`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/feedback.js test/feedback-design.test.js
git commit -m "feat: generalize feedback gate, add conditional design gate for frontend"
```

---

## Task 6: Design prompt builders in orchestration.js

**Files:**
- Modify: `lib/orchestration.js` (`buildDesignSystemPrompt`, `buildDesignVerifyUiPrompt`, exports)
- Test: `test/orchestration-design.test.js` (extend)

**Step 1: Write the failing tests**

Append to `test/orchestration-design.test.js` (before final `process.exit`):

```js
// ── prompt builders ───────────────────────────────────────────
const manifestStub = {
  description: 'Build a settings page', work_type: 'MEDIUM', has_ui: true,
  design_artifact: './DESIGN.md', active_phases: [6.5, 7, 8, 11.5],
  phases: { 6.5: { name: 'design-system', status: 'pending' } },
};
test('buildDesignSystemPrompt mentions DESIGN.md, gather/extract/construct, lint, and DESIGN_COMPLETE', () => {
  const p = o.buildDesignSystemPrompt(manifestStub, process.cwd());
  assert.match(p, /DESIGN\.md/);
  assert.match(p, /DESIGN_COMPLETE/);
  assert.match(p, /lint/i);
  assert.match(p, /Designer/);
});
test('buildDesignVerifyUiPrompt mentions token compliance and DESIGN_UI_VERIFIED', () => {
  const p = o.buildDesignVerifyUiPrompt(manifestStub, process.cwd());
  assert.match(p, /DESIGN_UI_VERIFIED/);
  assert.match(p, /DESIGN\.md/);
  assert.match(p, /token/i);
});
```

**Step 2: Run to verify it fails**

Run: `node test/orchestration-design.test.js`
Expected: FAIL — builders undefined.

**Step 3: Implement**

In `lib/orchestration.js`, after `buildSimplifyPrompt` (after line 473), add:

```js
// ============================================================
// DESIGN PHASE PROMPT BUILDERS
// ============================================================

/**
 * Phase 6.5 — DesignSystem. Designer authors DESIGN.md (emit-pattern).
 */
function buildDesignSystemPrompt(manifest, projectRoot) {
  const phaseContext = buildPhaseContext(manifest, DESIGN_SYSTEM_PHASE);
  const artifact = manifest.design_artifact || './DESIGN.md';
  return `## Phase 6.5 — Design System (Author DESIGN.md)

${phaseContext}

You are a **Designer**. You own the project's visual identity. You do NOT write source code.
**Allowed tools:** Read, Bash, Task   **Forbidden:** Edit, Write

Invoke the design skill first: use \`gateway-design\` to load \`design/design-md\`.

## Your Job — Gather → Extract → Construct → Self-lint

1. **Gather** — collect the user's design preferences, reference URLs, screenshots,
   and assets to emulate. If references are URLs, spawn extraction sub-agents (Task)
   to pull colors, type, spacing via DevTools/CSS.
2. **Extract** — derive design tokens (color, typography, spacing, radius, shadow)
   from the gathered references. For multi-reference work, fuse 2–3 sources tastefully
   (assign a role per reference; reconcile into ONE coherent system).
3. **Construct** — write a complete \`${artifact}\`: YAML front matter (machine-readable
   tokens) + markdown body (Design Brief + narrative rationale + 8 canonical sections).
4. **Self-lint** — validate deterministically:
   \`npx @google/design.md lint\` (broken \`{token.refs}\`) and WCAG AA contrast.
   Fix any failures before signalling complete.

## Emit-pattern (no Write tool)

Emit the full \`${artifact}\` content as your phase output to:
\`.jonggrang/.output/features/${manifest.feature_id || '{feature_id}'}/06_5-designer-design-md.md\`
The platform persists it to \`${artifact}\` at project root (canonical, git-tracked).
If a \`${artifact}\` already exists, READ it and EXTEND, using \`diff\` to avoid regressions.

## Signal

When \`${artifact}\` is written and lint + WCAG pass, output:
DESIGN_COMPLETE`;
}

/**
 * Phase 11.5 — DesignVerifyUI. Designer verifies implemented UI vs DESIGN.md tokens.
 */
function buildDesignVerifyUiPrompt(manifest, projectRoot) {
  const phaseContext = buildPhaseContext(manifest, DESIGN_VERIFY_UI_PHASE);
  const artifact = manifest.design_artifact || './DESIGN.md';
  return `## Phase 11.5 — Design Verify UI (token compliance)

${phaseContext}

You are a **Designer** performing independent review of the **Developer's** UI output.
**Allowed tools:** Read, Bash, Task   **Forbidden:** Edit, Write

## Your Job

1. Read \`${artifact}\` (the canonical token spec).
2. Inspect the implemented UI / changed frontend files.
3. Verify the implementation uses DESIGN.md tokens and does NOT hardcode equivalent
   values (raw hex colors, ad-hoc spacing, off-spec fonts). Re-run
   \`npx @google/design.md lint\` if the spec was touched.
4. Report PASS or FAIL with specific token violations.

This is independent review (different author, different artifact), not self-review.

## Signal

If the UI complies with the token spec, output:
DESIGN_UI_VERIFIED

If it does not comply, report the violations clearly and do NOT emit the signal
(the feedback loop will route back to the Developer).`;
}
```

Add both builders + the phase constants to `module.exports`.

**Step 4: Run to verify it passes**

Run: `node test/orchestration-design.test.js`
Expected: PASS (all design tests).

**Step 5: Commit**

```bash
git add lib/orchestration.js test/orchestration-design.test.js
git commit -m "feat: add DesignSystem and DesignVerifyUI prompt builders"
```

---

## Task 7: Wire design phases into the orchestrate loop

**Files:**
- Modify: `bin/jonggrang.js` (classify `has_ui` at orchestrate entry; pass to `createManifest`; special-case `6.5` and `11.5` in `runOrchestrationLoop`)

No unit test (loop is integration-level). Verified by `--dry-run`.

**Step 1: Classify `has_ui` and pass to manifest**

At the orchestrate entry (around lines 1757–1770), after `const workType = ...`:

```js
  const workType = orchestration.classifyWorkType(description);
  const hasUi = orchestration.classifyHasUi(description);
  const activePhases = orchestration.getActivePhases(workType, { hasUi });
```

Update the log (after line 1762):

```js
  logInfo(`Work type: ${workType}${hasUi ? ' (has UI — design phases active)' : ''}`);
```

Update `createManifest` call (line 1768):

```js
  const { manifest, manifestPath } = orchestration.createManifest(
    PROJECT_ROOT, featureId, description, workType, { hasUi }
  );
```

**Step 2: Human-pause for DesignSystem + prompt dispatch**

In `runOrchestrationLoop`, mirror the brainstorming human-pause. After the phase-6 brainstorming block (after line 1834), add:

```js
    if (phaseNum === orchestration.DESIGN_SYSTEM_PHASE && activeMode !== 'autonomous') {
      // DesignSystem — pause for human design input in non-autonomous modes
      logInfo('\n[DESIGN SYSTEM PHASE — Human Input Required]');
      logInfo(`Feature: ${manifest.description}`);
      logInfo('Provide design references / preferences (URLs, screenshots, assets) before continuing.');
      logInfo('Resume with: jonggrang work --resume');
      orchestration.failPhase(manifestPath, phaseNum, 'Awaiting human input (design-system)');
      process.exit(0);
    }
```

In the prompt-builder selection (lines 1837–1844), extend the branch:

```js
    let phaseContext;
    if (phaseNum === orchestration.SIMPLIFY_PHASE) {
      phaseContext = orchestration.buildSimplifyPrompt(manifest, PROJECT_ROOT);
    } else if (phaseNum === orchestration.DESIGN_SYSTEM_PHASE) {
      phaseContext = orchestration.buildDesignSystemPrompt(manifest, PROJECT_ROOT);
    } else if (phaseNum === orchestration.DESIGN_VERIFY_UI_PHASE) {
      phaseContext = orchestration.buildDesignVerifyUiPrompt(manifest, PROJECT_ROOT);
    } else {
      phaseContext = orchestration.buildPhaseContext(manifest, phaseNum);
    }
```

**Step 3: Syntax + dry-run verification**

Run: `node --check bin/jonggrang.js`
Expected: no output (valid syntax).

Run a dry-run on a UI feature and confirm `6.5` and `11.5` appear in active phases:
Run: `node bin/jonggrang.js orchestrate "Build a settings page with a form" --dry-run` (use the project's actual dry-run invocation; if the command differs, consult `bin/jonggrang.js` arg parsing)
Expected: log shows `(has UI — design phases active)` and active phases include `6.5` and `11.5`; dry-run prints prompts for those phases without error.

Run a dry-run on a backend feature and confirm design phases are absent:
Run: `node bin/jonggrang.js orchestrate "Add a queue worker" --dry-run`
Expected: active phases do NOT include `6.5`/`11.5`.

**Step 4: Commit**

```bash
git add bin/jonggrang.js
git commit -m "feat: wire design phases into orchestrate loop with has_ui gating"
```

---

## Task 8: Designer agent template + AGENTS.md integration line

**Files:**
- Create: `templates/agents/designer.md`
- Modify: `CLAUDE.md` (the `AGENTS.md` symlink target) — add the DESIGN.md read directive

**Step 1: Create the agent template**

Mirror `templates/agents/lead.md` frontmatter shape. Create `templates/agents/designer.md`:

```markdown
---
description: Specialized Designer — authors and verifies DESIGN.md design tokens, never writes source code
mode: subagent
permission:
  edit: deny
  bash: allow
  webfetch: allow
role: designer
label: Specialized Designer
output_format: design_md
completion_signal: DESIGN_COMPLETE
max_lines: 180
---

# Specialized Designer Agent

## Identity

You are a **Specialized Designer**. You own the project's visual identity through a
git-tracked `DESIGN.md`. You gather, extract, construct, and verify — you never write
source code.

**Allowed tools:** Read, Bash, Task
**Forbidden tools:** Edit, Write (you emit DESIGN.md; the platform persists it)

## Two Jobs (two phases)

### Phase 6.5 — Author DESIGN.md (Gather → Extract → Construct → Self-lint)
1. Gather references (URLs, screenshots, assets, stated preferences).
2. Extract tokens (color, typography, spacing, radius, shadow). Fuse 2–3 references
   tastefully into ONE coherent system — taste, not token-accurate copying.
3. Construct `./DESIGN.md`: YAML front matter (tokens) + markdown (Design Brief +
   narrative + canonical sections).
4. Self-lint: `npx @google/design.md lint` + WCAG AA contrast. Fix failures.
Emit the full file content as phase output. Signal `DESIGN_COMPLETE`.

### Phase 11.5 — Verify UI vs tokens
Read `./DESIGN.md`, inspect implemented UI, confirm tokens are used and no equivalent
values are hardcoded. Signal `DESIGN_UI_VERIFIED` on pass; on fail, list violations and
do not signal (feedback loop routes back to the Developer).

## Skill

Invoke `gateway-design` to load `design/design-md` before authoring.

## Signals
- After authoring + lint pass: `DESIGN_COMPLETE`
- After UI compliance pass: `DESIGN_UI_VERIFIED`
```

**Step 2: Add the integration directive to CLAUDE.md**

`CLAUDE.md` is the `AGENTS.md` symlink source. Add a short directive so the Developer reads the artifact during Implement. Place it under "Working Standards":

```markdown
- **UI work reads `DESIGN.md` first.** When a task touches UI/frontend, read the
  project-root `DESIGN.md` and use its tokens — never hardcode equivalent color,
  spacing, or type values.
```

**Step 3: Verify**

Run: `test -f templates/agents/designer.md && echo OK`
Expected: `OK`.
Reread the added CLAUDE.md line to confirm placement.

**Step 4: Commit**

```bash
git add templates/agents/designer.md CLAUDE.md
git commit -m "feat: add Designer agent template and DESIGN.md read directive"
```

---

## Task 9: design-md skill (core gateway + library skill)

**Files:**
- Create: `skills/core/gateway-design/SKILL.md`
- Create: `skills/library/design/design-md/SKILL.md` (copied from `~/.hermes-skills/creative/design-md/SKILL.md`)
- Create: `skills/library/design/design-md/references/` (deep-research excerpt, fusion, narrative)

**Step 1: Create the gateway skill**

Mirror an existing `skills/core/gateway-*/SKILL.md`. First read one for exact frontmatter:
Run: `cat skills/core/gateway-frontend/SKILL.md`

Then create `skills/core/gateway-design/SKILL.md` with matching shape:

```markdown
---
name: gateway-design
description: Routes design-system / DESIGN.md / design-token work to the design-md library skill
type: gateway
tier: core
domains: [design]
trigger: design token, design system, DESIGN.md, color palette, typography, WCAG, visual identity, theme
---

# Gateway: Design

Route design-system work to the appropriate library skill.

| Intent | Library skill |
|---|---|
| Author/extend DESIGN.md, extract tokens, fuse references, write Brief + narrative, WCAG lint | `design/design-md` |

## Output

GATEWAY_DESIGN:
domain: design
load:
  - skills/library/design/design-md/SKILL.md

Then follow the loaded skill to author or verify DESIGN.md.
```

**Step 2: Copy the library skill**

```bash
mkdir -p skills/library/design/design-md/references
cp ~/.hermes-skills/creative/design-md/SKILL.md skills/library/design/design-md/SKILL.md
```

If the Hermes skill ships its own `references/` or supporting files, copy those too:
```bash
cp -R ~/.hermes-skills/creative/design-md/. skills/library/design/design-md/ 2>/dev/null || true
```

(Optional, if useful and licensing permits) add the deep-research as a JIT reference:
```bash
cp ~/obs-brain/raw/design-md-deep-research.md skills/library/design/design-md/references/deep-research.md
```

**Step 3: Verify the gateway resolves the skill**

The routing test from Task 4 already asserts `design/design-md` is returned. Confirm the file is resolvable on disk:
Run: `node -e "const g=require('./lib/gateway'); console.log(g.resolveSkillPath('design/design-md', './skills'))"`
Expected: prints the absolute path to `skills/library/design/design-md/SKILL.md` (not `null`).

Run: `node -e "const g=require('./lib/gateway'); console.log(g.getGatewaySkillPath('design','./skills'))"`
Expected: prints path to `skills/core/gateway-design/SKILL.md`.

**Step 4: Commit**

```bash
git add skills/core/gateway-design skills/library/design
git commit -m "feat: add gateway-design and design-md library skill"
```

---

## Task 10: Config schema + documentation (Iron Rule)

**Files:**
- Modify: `templates/` jonggrang.json template(s) — add `design` block (locate via `grep -rl '"tool"' templates/`)
- Modify: `docs/CONFIG.md`, `docs/SKILLS.md`, `docs/WORKFLOW.md`, `docs/JONGGRANG.md`, `docs/ORCHESTRATION.md`, `docs/PHILOSOPHY.md`, `docs/AGENTTOOLS.md`, `README.md`

No new code; `design` config is read on demand via `lib.readConfig(CONFIG_FILE, '.design.<key>', default)` where needed (no parser change required — `readConfig` is dot-path generic).

**Step 1: Add the config block to the template(s)**

Find the template:
Run: `grep -rl '"tool"' templates/ .jonggrang/ 2>/dev/null`

Add to the jonggrang.json template:

```jsonc
{
  // ...existing...
  "design": {
    "enabled": true,            // auto-active when triage classifies has_ui
    "artifact": "./DESIGN.md",  // canonical path, project root, git-tracked
    "lint": true,               // run npx @google/design.md lint
    "wcag": "AA"                // contrast threshold
  }
}
```

**Step 2: Update docs per the CLAUDE.md change→docs table**

For each doc, add a section describing the design flow. Keep edits scoped and accurate to what was actually built (fractional phases 6.5/11.5, Designer role, has_ui gating, design gate):

- `docs/CONFIG.md` — document the `design` block (enabled/artifact/lint/wcag). **Required.**
- `docs/SKILLS.md` — add `gateway-design` (core) and `design/design-md` (library) to the skill tables. **Required.**
- `docs/WORKFLOW.md` — add phases 6.5 DesignSystem (human pause) and 11.5 DesignVerifyUI to the phase table; note `has_ui` gating; note the design gate in the feedback-loop section.
- `docs/JONGGRANG.md` — add Designer to the role assembly section (now six roles, with tool boundary Read/Bash/Task, emit-pattern); add the two phases; note design phases in the phase-skipping/`has_ui` discussion; MANIFEST `has_ui` + `design_artifact` fields.
- `docs/PHILOSOPHY.md` — add the Designer to the role/tool-restriction discussion; note design quality gate parallels code quality gate.
- `docs/ORCHESTRATION.md` — note the design phases as part of the deterministic phase set.
- `docs/AGENTTOOLS.md` — note the Designer role's tool profile if backends enumerate roles.
- `README.md` — if it lists roles/phases or config, reflect the sixth role + `design` config snippet; keep it short and link to `docs/CONFIG.md` and `docs/WORKFLOW.md` (do not duplicate detail).

**Step 3: Verify**

Run: `npm run check:syntax` (or `bash scripts/check.sh --syntax-only`)
Expected: all syntax checks pass.

Reread each edited doc section to confirm phase numbers (6.5/11.5), role name (Designer), and signals (DESIGN_COMPLETE / DESIGN_UI_VERIFIED) match the code.

**Step 4: Commit**

```bash
git add templates docs README.md
git commit -m "docs: document DESIGN.md design flow, Designer role, and design config"
```

---

## Final verification (after all tasks)

```bash
npm test                                   # existing suite still green
node test/orchestration-design.test.js     # design phases + builders
node test/roles-designer.test.js           # Designer role
node test/gateway-design.test.js           # design routing
node test/feedback-design.test.js          # design gate
node --check bin/jonggrang.js              # loop wiring syntax
bash scripts/check.sh                       # full project check
```

Consider adding the four new test files to the `test` npm script (or a `pretest` aggregator) so they run in CI — small follow-up, only if the project runs `npm test` in CI.

## Out of scope (deferred, per design doc)

- Work Loop mode design integration (orchestrate only).
- Auto-detecting "minor UI tweak → skip authoring, extend existing" beyond the prompt-level "read+extend if exists" instruction.
- Fixing the pre-existing `PHASE_ROLE_MAP` off-by-one in `roles.js`.
- Per-feature DESIGN.md snapshot/diff archival into `.output/` beyond the emit path (the emit file already lands in `.output/features/<id>/`).
