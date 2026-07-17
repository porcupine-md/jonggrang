# UI guide, feature handoff, and task context

**Status:** accepted; implemented by the Issue #89 delivery branch.

**Tracking:** [#89](https://github.com/porcupine-md/jonggrang/issues/89)

**Date:** 2026-07-14

## The decision

A managed project may have one tracked guide at `.jonggrang/UI.md`. It is the
place for product-level UI rationale, rules, and pointers to the real code.

A UI feature gets a frozen snapshot at
`.jonggrang/.output/features/<feature-id>/UI_HANDOFF.md`. Task breakdown adds a
small `ui_context` object only to tasks that affect UI.

```text
UI plan
  |
  +-- audit repository and .jonggrang/UI.md
  |
  +-- no usable guide
  |     -> optional user guide + plan ask -> guide draft + baseline choice
  |        -> user approval
  |
  +-- usable guide
        -> feature UI_HANDOFF.md -> task ui_context -> task prompt
```

The root guide is product-wide. The handoff is the approved feature record. A
task receives a selected slice of the handoff, not the full guide or every task
in the feature.

## What we took from the research

The guide borrows the useful parts of several approaches without making all of
them mandatory:

- Existing [`docs/UI.md`](../UI.md) contributes philosophy, tokens, typography,
  components, layout patterns, and a rules summary.
- Google `DESIGN.md` contributes design rationale, structured identity,
  references, and clear do/don't rules.
- `designtoken.md` contributes a practical coverage checklist: colour, type,
  spacing, component states, and visual references.
- DTCG supplies a canonical typed token source when a project needs to
  transform tokens across targets.
- Storybook and Code Connect supply optional links to real components and their
  code mapping.

`.jonggrang/UI.md` therefore contains rationale and token-use rules. It does
not copy a full CSS file, DTCG JSON, or Storybook into Markdown. Token values
still have one editable source in project code or in a DTCG file.

## The detail level to borrow from `docs/UI.md`

The project guide should borrow the level of specificity in the existing
`docs/UI.md`, not merely its headings. A component rule is useful when an agent
can implement it without guessing. A layout rule is useful when it shows the
spacing, state, or source component that makes the pattern recognisable.

- **Philosophy:** terminal-first, sharp-corner, and density guidance becomes
  product rationale plus visual direction and explicit do/don't rules.
- **Tokens:** colour, surface, text, and light-mode values become a token
  contract with canonical source, mode rules, and a representative snippet.
- **Typography:** the font stack, type scale, and spacing values become a table
  of values agents should reuse.
- **Component recipes:** buttons, inputs, dialogs, tags, and tabs become
  entries with a use case, source path, variants/states, and concrete usage or
  CSS.
- **Layout patterns:** sidebar, settings, Kanban, and timeline patterns become
  markup/CSS entries with a representative screen path.
- **Framework integration:** dark/light handling, icons, motion, and PrimeVue
  overrides become conditional sections when the project uses them.
- **Rules summary:** a short fallback is injected or referenced by UI tasks.

A guide does not need every dashboard-specific section from `docs/UI.md`. It
does need the same directness for the components and patterns that matter to
its own product.

## Why there are three levels

A single guide is enough for the product system. It cannot carry every decision
for every feature. A task needs even less context than a feature.

- `.jonggrang/UI.md` contains product rationale, baseline, source map, and
  reusable rules. It changes when a durable product rule changes.
- `.jonggrang/.output/features/<id>/UI_HANDOFF.md` contains approved feature
  decisions and selected guide references. It changes when the plan is
  approved, revised, or extended.
- `jonggrang-tasks.json` `ui_context` contains a task's selected handoff
  sections, files, states, and checks. It changes when tasks are broken down or
  appended.

`docs/UI.md` remains the human-facing dashboard documentation in this
repository. `.jonggrang/UI.md` is the guide read by Jonggrang inside any
managed project. A future command may seed it from an existing `docs/UI.md`.
This proposal does not move or overwrite the current document.

## Optional user-level guide

`~/.jonggrang/UI.md` is an opt-in personal reference. Jonggrang reads it only
when a project has no `.jonggrang/UI.md`, during project initialization or a
new UI plan. It can carry a user's usual direction, preferred references, and
starter-baseline preference.

It is not a shared token source for every project. A project may select it as
input, modify it, or ignore it. After approval, the project guide and its token
source are the authority for that project.

The lookup order is:

```text
project .jonggrang/UI.md
  > an explicit baseline or reference chosen for this project
  > optional ~/.jonggrang/UI.md
  > the product-shape baseline recommended by Jonggrang
```

## `.jonggrang/UI.md` format

The guide is Markdown. A small frontmatter block makes its key sources and
status easy to inspect.

```md
---
format: jonggrang-ui-guide/v1
baseline: dashboard-operational@1
ui_framework: vue + primevue
token_source: client/src/assets/main.css
token_status: ready
component_source: client/src/components/
storybook: none
references: []
---

# UI guide
```

`none` and `planned` are valid values. A missing Storybook or DTCG file is not
an error. A missing token source needs a foundation task before other UI work
can use a new visual value.

### Required sections

The guide has eight required sections. Each can be short. The requirement is
that a person and an agent can find the decision and its evidence.

#### 1. Product and UX rationale

Who uses the product, their recurring jobs, the product shape, and the
trade-offs that affect UI. This tells an agent why the UI should be dense, calm,
fast to scan, guided, or conservative around destructive actions.

#### 2. Visual direction and baseline

Describe the visual character and what the project follows: existing code, a
framework component system, Figma, an approved reference, or a starter baseline.
Include a few clear do/don't rules.

#### 3. Source map

List the real paths to inspect: theme or token source, shared components,
representative screens, Storybook, tests, Figma, and other references. This
prevents duplicate components and duplicated token values in the guide.

#### 4. Token contract, typography, and spacing

Name the canonical token source and the rules for new values. Cover semantic
colour, surface, text, type, spacing, radius, elevation, and component states
as relevant. For a simple project this points to CSS variables or a framework
theme. For a multi-target system it can point to DTCG JSON.

Show enough direct detail to prevent a new arbitrary value: a representative
token snippet, type scale, spacing scale, and any dark/light override or
colour-mixing rule that the project uses. The complete generated token file
stays at the canonical source path.

#### 5. Components and layout patterns

Record reusable primitives, recurring page patterns, and how to handle a gap.
For every component or pattern an agent is expected to reuse, include its source
path and at least one concrete usage, variant, or CSS example. An agent should
be able to find the existing button, form, dialog, table, navigation, empty
state, or settings pattern before it creates another one.

State the creation rule as well: reuse an existing component first; add a
variant when the primitive fits; create a local component only when the pattern
will recur or needs its own accessibility behaviour; use a baseline primitive
only when local code has no fit. A new component records its source path,
states, and a Storybook story or representative screen when the project has
that convention.

Use the same entry shape for every reusable component or layout pattern:

```md
### Component or pattern name
Use when: <the user/job condition>
Source: <project path>
Variants and states: <normal, loading, disabled, error, etc.>
Example: <short markup or CSS snippet>
Avoid: <the common wrong use>
```

This is intentionally more direct than "use the existing button." It tells the
agent which file to inspect, what states must work, and when a new component is
actually justified.

#### 6. Interaction, responsive, and accessibility rules

Capture shared behaviour that is absent from a static design: loading, empty,
error, destructive actions, keyboard and focus handling, responsive behaviour,
and contrast requirements. Feature-specific states stay in the handoff.

When repository evidence calls for it, add direct sections for theme modes,
icons, motion, and framework overrides. A PrimeVue project, for example, should
state where overrides live and which defaults must be removed; a project with
no component framework does not need that section.

#### 7. References and verification

Link design references and name existing Storybook, screenshot, accessibility,
or visual-test commands. State `none` when the project has no such resource.

#### 8. Rules summary

End with the small set of rules a UI agent should not miss. Typical examples are
"use semantic tokens", "reuse local components first", "show errors beside
the affected field", and "keep one primary action per viewport".

The planner may add a section when repository evidence needs it. Useful examples
include data-table rules for analytics, chart rules for trading, localization
rules for multi-language products, role-state rules for admin software, theme
modes, icons, motion, and framework overrides. It should not add empty template
sections.

## Guide validation and agent reading rules

The platform validates the parts that can be checked without asking a model to
judge taste:

- frontmatter uses `jonggrang-ui-guide/v1` and names a baseline;
- all eight required headings exist;
- source-map paths exist, or are marked `none` or `planned` with an owner task;
- a `ready` token source exists and a `planned` token source has a dependent
  UI-foundation task;
- referenced component paths, guide headings, and feature task ids resolve;
- a selected baseline pack id and version exist in the local catalog.

The agent follows this order when it works on a UI task:

1. Read the selected feature handoff sections.
2. Read the root-guide sections named by `ui_context` when the handoff needs
   more rationale or a reusable rule.
3. Read the named implementation source files before changing a component or
   token.
4. Report `UI_GUIDE_DRIFT` when the handoff, guide, and current code disagree.
   It must not silently invent a new token, component, or rule to reconcile the
   conflict.

The current user request and approved feature handoff set the work scope. The
root guide sets product policy. The token and component source files are the
implementation evidence. A baseline pack and optional user-level guide only
supply defaults before the project guide is approved.

## Baselines when the user has no preference

A baseline is a starting point for a guide and, when needed, an initial token
template. It is not a required UI library and it is not copied into every
project.

The planner uses this order:

1. Reuse the existing project system when the repository already has one.
2. Use an explicit project reference, framework theme, component system, or
   baseline selected by the user in the plan.
3. Read the optional `~/.jonggrang/UI.md` as a personal reference when the
   project has no guide.
4. Recommend a Jonggrang starter baseline when no usable direction remains.
5. Ask the user when the product shape makes the recommendation uncertain.

The initial starter set should be small and modular:

```text
templates/ui-baselines/
  core/
    semantic-token-contract.md
    guide-sections.md
  landing-page-minimalist/
    manifest.yml
    guide-fragment.md
    tokens.css.template
  dashboard-operational/
    manifest.yml
    guide-fragment.md
    tokens.css.template
  mobile-app-minimalist/
    manifest.yml
    guide-fragment.md
    tokens.css.template
```

A pack manifest identifies its `id`, version, intended product shape, supported
framework targets, guide fragment, token template, and plan questions. The core
contract keeps semantic names consistent. Each pack contributes only the rules
and token values appropriate to its product shape.

Jonggrang ships three deliberately opinionated version-one packs:
`landing-page-minimalist@1`, `dashboard-operational@1`, and
`mobile-app-minimalist@1`. They cover three common product shapes without
collapsing into one generic card-and-gradient aesthetic. More packs can be added
without changing the plan flow. A guide and handoff pin the selected pack id and
version, so a later pack release never silently changes an in-progress feature.
External systems such as Chakra, Tailwind Plus, or a commercial design kit may
be referenced by a pack, but their source is never copied without the project's
license allowing it.

## When a token source is missing

A missing token source is a planning decision. It is not permission for each
task to introduce its own colours, spacing, and radius values.

The planner proposes one baseline and one destination path. The user approves
both with the plan. Possible choices are an existing framework theme, an
approved external or brand source, a Jonggrang starter pack, or DTCG when the
project needs one token source transformed for several targets.

A starter pack is only a template. The plan creates a first UI-foundation task
that writes the selected token template to the approved project path, such as
`src/styles/tokens.css` or a framework theme module. That file becomes the
canonical token source. `.jonggrang/UI.md` stores the baseline id, source path,
and readiness state. It does not duplicate the token values.

Other UI tasks depend on the foundation task. That task is the only
implementation task allowed to change the guide's token status from `planned`
to `ready`, together with the source path it created and validated.

## Guide audit and `plan ask`

For every UI-affecting plan, the planner audits the project before asking the
user anything. It looks for:

- the frontend framework and installed component libraries;
- global styles, theme files, CSS variables, and token files;
- shared components, routes, and representative screens;
- Storybook, visual tests, accessibility checks, and screenshots if present;
- existing `docs/UI.md`, `.jonggrang/UI.md`, Figma links, and design references;
- stale source paths or rules in the current guide that conflict with code.

When `.jonggrang/UI.md` is missing, the audit combines repository evidence
with the optional `~/.jonggrang/UI.md` when it exists. The user-level guide is
reference material, not a file copied unchanged into the project. A keyword
match may recommend a starter pack, but it never selects one. Before using a
built-in template, `plan ask` first offers a custom preference/reference; only a
user with no preference is offered the recommendation for explicit consent.
The planner uses the existing flow only for information code cannot reveal:

1. What should the UI follow: an existing product, Figma, screenshots, a URL,
   or a new direction?
2. Does the recommended flavor and baseline fit, or should it use another one?
3. Who uses the feature and what must be visible or easy to do first?
4. Are there non-negotiables such as a brand rule, mobile support, accessibility
   requirement, or a pattern to avoid?

The draft plan contains the guide, baseline choice, token status, and feature
plan. The user can edit any of them through the normal plan flow. Approval
writes `.jonggrang/UI.md`, creates the feature handoff, and adds the
UI-foundation task when the token status is `planned`. For an approved built-in
pack, the loader carries the exact token template into that task's bounded
handoff section; the task copies rather than regenerates its values.

When a guide already exists, the planner audits only relevant sections. It asks
the user when a source path is stale, a needed rule is missing, or the request
conflicts with the guide. The plan shows one status:

```text
UI guide: unchanged
UI guide: update proposed
UI guide: needs input
```

It does not repeat a full design interview for every UI plan.

## Feature UI handoff

`UI_HANDOFF.md` is a compact, approved feature snapshot. It names the root
guide, its revision, the baseline, and the feature decisions. It does not copy
the root guide.

Every handoff has a feature intent, shared direction, references, and one short
section for every UI task. A task section answers six questions: what outcome
it owns, which existing component/pattern it uses, what it changes, how every
required state behaves, what it must avoid, and how to verify it.

```md
# UI handoff: notification settings

Guide: .jonggrang/UI.md
Guide revision: <content digest at approval>
Baseline: dashboard-operational@1
Token source: client/src/assets/main.css (ready)
Guide status: unchanged

## Feature intent
Administrators choose which team notifications they receive. The preference
must be understandable before it takes effect.

## Shared direction
- Use the settings-section pattern and semantic theme values.
- Keep one primary action per viewport.

## References
- .jonggrang/UI.md#components-and-layout-patterns
- client/src/assets/main.css
- client/src/components/app/BaseModal.vue

## Task task-003
Objective: save the changed preferences and show the result inline.
Use: existing primary button and settings-section pattern.
Change: submit the form without navigation.

States:
- loading: disable Save and show its loading state.
- saved: show a short inline success message.
- save-error: preserve values and show an inline error near the controls.

Do not: autosave, add a new toast system, or create a new button style.
Acceptance: Save remains keyboard reachable; an error is associated with the
changed controls; only one primary action is visible.
Sources: `client/src/assets/main.css`,
`client/src/components/app/BaseModal.vue`.
Check: npm test
```

If a feature introduces a missing token source or changes a durable UI rule, the
handoff says so explicitly:

```md
Guide status: update approved
Token source: src/styles/tokens.css (planned in task-001)

## Guide refinement
Add an inline-validation rule because this feature introduces the first
reusable validated form pattern.
```

The handoff contains feature intent, shared direction, and short
`## Task task-xxx` sections. A large feature may have many task sections, but
the loader reads only `## Feature intent`, `## Shared direction`, and the
section for its own task id. It never injects the complete guide or every
feature task into a fresh context.

## Task contract and prompt context

Task breakdown adds `ui_context` only to UI-related tasks:

```yaml
ui_context:
  handoff: .jonggrang/.output/features/notification-settings/UI_HANDOFF.md
  sections:
    - Feature intent
    - Shared direction
    - Task task-003
  guide: .jonggrang/UI.md
  guide_revision: <content digest at approval>
  guide_sections:
    - Components and layout patterns
    - Interaction, responsive, and accessibility rules
  baseline: dashboard-operational@1
  read_order:
    - handoff
    - guide_sections
    - source_files
  on_conflict: report UI_GUIDE_DRIFT
  token_source: client/src/assets/main.css
  source_files:
    - client/src/assets/main.css
    - client/src/components/app/BaseModal.vue
  states:
    - loading
    - save-error
    - saved
  verification:
    - npm test
```

The developer, tester, and reviewer prompt receives this object and the named
handoff sections. The root guide stays available by its path; it is not injected
in full. An agent reads the listed guide sections when the handoff leaves a
question open, then follows the named source files if it needs implementation
detail. A backend without a browser, Figma, or Storybook can still work from
local paths.

Non-UI tasks have no `ui_context`, so their prompt size and workflow stay as
they are today.

## Keeping the guide current after a feature

Task agents do not edit `.jonggrang/UI.md` directly, apart from the designated
UI-foundation task updating the planned token source that its approved task
owns. They can report a repeated pattern, missing rule, or local exception in
task output.

At feature review, the reviewer may add `## Proposed guide updates` to the
feature handoff. The user promotes selected updates to `.jonggrang/UI.md`.
This keeps the root guide curated and prevents a local exception from becoming
global policy.

A later update to `.jonggrang/UI.md` does not silently change an approved
feature. Its handoff keeps the guide revision and decisions used for that
feature. The user can revise or extend the feature plan if pending tasks should
adopt the newer rule.

## Delivery sequence

The implementation should cover the complete path, in this order.

### 1. Define the files and baseline-pack interface

Add the `.jonggrang/UI.md` and feature `UI_HANDOFF.md` formats, the task
`ui_context` schema, and a versioned baseline-pack manifest. Ship the three
version-one product-shape packs together. The manifest and the guide both pin a
pack id and version.

### 2. Detect UI work and audit the project

Planning classifies UI-affecting work, locates the guide, and inspects local UI
evidence. The audit reports the framework, theme/token source, components,
screens, verification tools, references, and guide drift.

### 3. Create or revise the root guide

For a missing or incomplete guide, the planner uses focused `plan ask`
questions, selects or recommends a baseline, and drafts the guide beside the
plan. For an existing guide, it proposes only the relevant change. The plan UI
shows guide status, the guide diff, baseline choice, and token status before
approval.

### 4. Materialize the approved design foundation

Approval writes the guide. If the token source is `planned`, task breakdown
creates the UI-foundation task and blocks later UI tasks on it. That task writes
and validates the canonical token source, then marks the guide source `ready`.

### 5. Build the feature handoff and tasks

Approval writes `UI_HANDOFF.md` with the guide revision, baseline, shared
feature direction, references, and task sections. Task breakdown adds
`ui_context` to each UI task and points at its matching handoff and guide
sections.

### 6. Inject bounded context at task runtime

Developer, tester, and reviewer prompts receive the task context plus the
selected handoff text. They can read the named root-guide sections and source
files when necessary. The runtime does not inject the full guide or unrelated
task sections.

### 7. Review and promote durable changes

Review records visual, accessibility, and component-reuse results. It can add
proposed guide updates to the feature handoff. The user promotes selected
updates to the root guide; task agents cannot promote them themselves.

### 8. Grow baseline packs and optional integrations

Add further product-shape and framework-specific packs through the pack
interface. Add Storybook lookup, component-index generation, Figma MCP, DTCG
transforms, and visual-regression wiring only for projects that use them. These
extensions do not change the root-guide, handoff, or task-context contract.

## Sources checked

| Source | Why it was used | Retrieved |
| --- | --- | --- |
| [Google Labs `DESIGN.md`](https://github.com/google-labs-code/design.md) | Guide format, rationale, linting, and export ideas | 2026-07-14 |
| [DTCG 2025.10](https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/) | Typed token format when a project needs cross-target tokens | 2026-07-14 |
| [Style Dictionary token docs](https://github.com/style-dictionary/style-dictionary/blob/main/docs/src/content/docs/info/tokens.md) | Token transforms for projects using DTCG | 2026-07-14 |
| [Figma Code Connect](https://help.figma.com/hc/en-us/articles/23920389749655-Code-Connect) | Optional mapping from design components to code | 2026-07-14 |
| [Skyscanner Backpack](https://github.com/Skyscanner/backpack/blob/main/AGENTS.md) | Existing repository practice for agent UI guidance | 2026-07-14 |
| [Moodle design system](https://github.com/moodlehq/design-system) | Component documentation and agent lookup practice | 2026-07-14 |
| [CMS design system](https://github.com/CMSgov/design-system) | Storybook and visual-test practice | 2026-07-14 |
| [designtoken.md](https://designtoken.md/) | Markdown token-sheet format; vendor claims treated as unverified | 2026-07-14 |

## Worked example

The following fictional project, **ParcelOps Console**, shows how the three
artifacts fit together. It is a review example, not a baseline that Jonggrang
will copy into a project.

### 1. Project guide: `.jonggrang/UI.md`

````md
---
format: jonggrang-ui-guide/v1
baseline: existing-project
ui_framework: vue + primevue
token_source: client/src/assets/main.css
token_status: ready
component_source: client/src/components/
storybook: none
references:
  - https://figma.example.com/file/parcelops-console
---

# ParcelOps Console UI guide

## Product and UX rationale
ParcelOps is used by warehouse operators during a shift. They scan shipment
exceptions, resolve them quickly, and move to the next item. The UI favours
information density, keyboard use, and clear status over decorative space.

## Visual direction and baseline
Follow the existing console: dark by default, square corners, monospace labels,
and one green primary action. Do not add marketing-card layouts, gradients, or
rounded pills. PrimeVue is the component baseline; local components wrap it
when the same pattern appears in more than one screen.

## Source map
- Tokens and global styles: `client/src/assets/main.css`
- Shared components: `client/src/components/app/`
- Existing exception screen: `client/src/views/ExceptionsView.vue`
- Dialog example: `client/src/components/app/BaseModal.vue`
- Visual reference: `https://figma.example.com/file/parcelops-console`
- Storybook and visual regression: none

## Token contract, typography, and spacing
Use `--po-*` CSS variables from `main.css`. New colours need a semantic name;
do not add raw hex values to a component.

```css
:root {
  --po-bg: oklch(0.165 0.014 245);
  --po-surface: oklch(0.195 0.014 245);
  --po-border: oklch(0.32 0.014 245);
  --po-text: oklch(0.92 0.006 95);
  --po-text-muted: oklch(0.60 0.008 95);
  --po-action: oklch(0.78 0.16 145);
  --po-danger: oklch(0.68 0.18 25);
  --po-radius: 0px;
}
```

Use the mono font stack at 13px/1.6 for body text. Keep related controls 8px
apart and separate groups by 16px.

| Use | Size | Weight | Token |
|---|---:|---:|---|
| Section heading | 11px | 600 | `--po-text-muted` |
| Body and controls | 13px | 400 | `--po-text` |
| Metadata | 11px | 400 | `--po-text-muted` |

A new token belongs in `main.css` with a semantic name and a dark/light value
when the application supports both modes. Use `color-mix()` for faded status
backgrounds instead of introducing a raw alpha colour.

## Components and layout patterns

### Primary action

Use PrimeVue `Button` with the local primary class for the one action that
commits the current screen. The loading state belongs on the button; do not add
a second spinner beside it.

```vue
<Button
  label="Save preferences"
  :loading="saving"
  class="po-button-primary"
  @click="save"
/>
```

```css
.po-button-primary {
  background: var(--po-action);
  color: var(--po-bg);
  border: 1px solid var(--po-action);
  border-radius: var(--po-radius);
}
```

### Shipment status

Use the existing `StatusTag` component rather than a hand-written coloured
badge. It maps known statuses to semantic tokens and keeps the label readable.

```vue
<StatusTag :status="shipment.status" />
```

Source: `client/src/components/app/StatusTag.vue`.

### Confirmation dialog

Use `BaseModal` for destructive or irreversible actions. It owns focus return
and escape handling. The caller supplies the action text and button callback.

```vue
<BaseModal v-model:open="confirming" title="Cancel shipment">
  <p>This cannot be undone after the carrier pickup is confirmed.</p>
  <template #actions>
    <Button severity="secondary" @click="confirming = false">Keep shipment</Button>
    <Button severity="danger" @click="cancelShipment">Cancel shipment</Button>
  </template>
</BaseModal>
```

Source: `client/src/components/app/BaseModal.vue`.

### Settings section

Use this layout for a small group of related preferences. Do not create a new
card pattern for a single form section.

```vue
<section class="po-settings-section">
  <header>
    <h2>Alert preferences</h2>
    <p>Choose which warehouse exceptions need immediate attention.</p>
  </header>
  <!-- controls go here -->
</section>
```

```css
.po-settings-section {
  background: var(--po-surface);
  border: 1px solid var(--po-border);
  border-radius: var(--po-radius);
  padding: 20px;
}
```

### When there is a gap

Check `ExceptionsView.vue` and the shared component directory first. Add a
variant to an existing component when its behaviour fits. Create a local
component when the same pattern will be reused or when it needs its own focus,
keyboard, or state handling. Add the component path and its states to this
guide; add a Storybook story when Storybook exists.

## Interaction, responsive, and accessibility rules
Show save errors beside the affected control. Destructive actions need a clear
confirmation. Focus returns to the triggering control when a dialog closes.
The desktop console supports 1280px and above; below that, filter controls stack
before the data table scrolls horizontally. Keyboard focus uses the green ring.

## Theme modes and PrimeVue overrides
Dark is the default. Light mode overrides `--po-bg`, `--po-surface`,
`--po-text`, and `--po-action` for contrast. All PrimeVue overrides live in
`client/src/assets/main.css`; do not add scoped overrides that compete with the
global theme. Use PrimeIcons for shared icon names. Motion is limited to
background, border, and colour transitions under 150ms.

## References and verification
The source map and Figma file are references only. Run `npm test` and the
existing lint command. There is no screenshot command yet.

## Rules summary
- Reuse local components before creating one.
- Use semantic `--po-*` tokens.
- Keep one primary action per viewport.
- Put errors near the control that caused them.
````

### 2. Feature handoff: `.jonggrang/.output/features/alert-preferences/UI_HANDOFF.md`

```md
# UI handoff: alert preferences

Guide: .jonggrang/UI.md
Guide revision: sha256:8f20...b19c
Baseline: existing-project
Token source: client/src/assets/main.css (ready)
Guide status: unchanged

## Feature intent
Warehouse operators choose which exception alerts need attention during a shift.
They must understand the effect before saving and return to scanning quickly.

## Shared direction
- Keep the exception-console density and settings-section layout.
- Use existing `StatusTag`, `BaseModal`, and `--po-*` tokens.
- The page has one primary action: Save preferences.

## References
- .jonggrang/UI.md#components-and-layout-patterns
- .jonggrang/UI.md#interaction-responsive-and-accessibility-rules
- client/src/views/ExceptionsView.vue
- client/src/components/app/BaseModal.vue

## Task task-003
Objective: persist preferences and make the result obvious without a page reload.
Use: existing primary `Button`; no new toast or alert component.
Change: wire Save to the preference endpoint and place feedback below the
settings section header.

States:
- loading: Save is disabled and shows its built-in loading state.
- saved: show a short green inline message for five seconds.
- save-error: keep the user's selections and show the API message inline.

Do not: autosave, navigate away, or add a second primary button.
Acceptance: keyboard users can activate Save and focus stays on the button
while feedback appears. The error message is linked to the settings section.
Sources: `client/src/views/ExceptionsView.vue`,
`client/src/components/app/BaseModal.vue`.
Check: npm test
```

### 3. Task context: `jonggrang-tasks.json`

```json
{
  "id": "task-003",
  "title": "Persist alert preferences and render save feedback",
  "status": "pending",
  "blocked_by": ["task-001"],
  "ui_context": {
    "handoff": ".jonggrang/.output/features/alert-preferences/UI_HANDOFF.md",
    "sections": ["Feature intent", "Shared direction", "Task task-003"],
    "guide": ".jonggrang/UI.md",
    "guide_revision": "sha256:8f20...b19c",
    "guide_sections": [
      "Components and layout patterns",
      "Interaction, responsive, and accessibility rules"
    ],
    "baseline": "existing-project",
    "read_order": ["handoff", "guide_sections", "source_files"],
    "on_conflict": "report UI_GUIDE_DRIFT",
    "token_source": "client/src/assets/main.css",
    "source_files": [
      "client/src/views/ExceptionsView.vue",
      "client/src/components/app/BaseModal.vue"
    ],
    "states": ["loading", "saved", "save-error"],
    "verification": ["npm test"]
  }
}
```

The task prompt receives the `ui_context` object and the two named handoff
sections. It reads the root-guide sections or source files only when the
handoff is not enough to make an implementation decision.
