# UI guide, feature handoff, and task context

**Status:** proposal only; this branch does not change Jonggrang runtime behavior.<br>
**Tracking:** [#89](https://github.com/porcupine-md/jonggrang/issues/89)<br>
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
  |     -> plan ask -> guide draft + baseline choice -> user approval
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

| Source | What the guide keeps |
|---|---|
| Existing [`docs/UI.md`](../UI.md) | Philosophy, tokens, typography, components, layout patterns, and a rules summary |
| Google `DESIGN.md` | Design rationale, structured identity, references, and clear do/don't rules |
| `designtoken.md` | A practical coverage checklist: colour, type, spacing, component states, and visual references |
| DTCG | A canonical typed token source when a project needs to transform tokens across targets |
| Storybook and Code Connect | Optional links to real components and their code mapping |

`.jonggrang/UI.md` therefore contains rationale and token-use rules. It does
not copy a full CSS file, DTCG JSON, or Storybook into Markdown. Token values
still have one editable source in project code or in a DTCG file.

## Why there are three levels

A single guide is enough for the product system. It cannot carry every decision
for every feature. A task needs even less context than a feature.

| Location | Contains | Changes when |
|---|---|---|
| `.jonggrang/UI.md` | Product rationale, baseline, source map, and reusable rules | A durable product rule changes |
| `.jonggrang/.output/features/<id>/UI_HANDOFF.md` | Approved feature decisions and selected guide references | A plan is approved, revised, or extended |
| `jonggrang-tasks.json` `ui_context` | A task's selected handoff sections, files, states, and checks | Tasks are broken down or appended |

`docs/UI.md` remains the human-facing dashboard documentation in this
repository. `.jonggrang/UI.md` is the guide read by Jonggrang inside any
managed project. A future command may seed it from an existing `docs/UI.md`.
This proposal does not move or overwrite the current document.

## `.jonggrang/UI.md` format

The guide is Markdown. A small frontmatter block makes its key sources and
status easy to inspect.

```md
---
format: jonggrang-ui-guide/v1
baseline: neutral-application@1
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
colour, type, spacing, radius, elevation, and component states as relevant.
For a simple project this points to CSS variables or a framework theme. For a
multi-target system it can point to DTCG JSON.

#### 5. Components and layout patterns

Record reusable primitives, recurring page patterns, and how to handle a gap.
An agent should be able to find the existing button, form, dialog, table,
navigation, empty state, or settings pattern before it creates another one.

#### 6. Interaction, responsive, and accessibility rules

Capture shared behaviour that is absent from a static design: loading, empty,
error, destructive actions, keyboard and focus handling, responsive behaviour,
and contrast requirements. Feature-specific states stay in the handoff.

#### 7. References and verification

Link design references and name existing Storybook, screenshot, accessibility,
or visual-test commands. State `none` when the project has no such resource.

#### 8. Rules summary

End with the small set of rules a UI agent should not miss. Typical examples are
"use semantic tokens", "reuse local components first", "show errors beside
the affected field", and "keep one primary action per viewport".

The planner may add a section when repository evidence needs it. Useful examples
include data-table rules for analytics, chart rules for trading, localization
rules for multi-language products, and role-state rules for admin software.
It should not add empty template sections.

## Baselines when the user has no preference

A baseline is a starting point for a guide and, when needed, an initial token
template. It is not a required UI library and it is not copied into every
project.

The planner uses this order:

1. Reuse the existing project system when the repository already has one.
2. Use a user-provided design reference, framework theme, or component system.
3. Recommend a Jonggrang starter baseline when the repository and user provide
   no usable direction.
4. Ask the user when the product shape makes the recommendation uncertain.

The initial starter set should be small and modular:

```text
templates/ui-baselines/
  core/
    semantic-token-contract.md
    guide-sections.md
  neutral-application/
    manifest.yml
    guide-fragment.md
    tokens.css.template
  dashboard/
    manifest.yml
    guide-fragment.md
    tokens.css.template
  marketing/
    manifest.yml
    guide-fragment.md
    tokens.css.template
```

A pack manifest identifies its `id`, version, intended product shape, supported
framework targets, guide fragment, token template, and plan questions. The core
contract keeps semantic names consistent. Each pack contributes only the rules
and token values appropriate to its product shape.

Jonggrang can ship one `neutral-application@1` pack first. More packs can be
added without changing the plan flow. External systems such as Chakra,
Tailwind Plus, or a commercial design kit may be referenced by a pack, but their
source is never copied without the project's license allowing it.

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

When `.jonggrang/UI.md` is missing, the audit supplies the first draft. The
planner uses the existing `plan ask` flow only for information code cannot
reveal:

1. What should the UI follow: an existing product, Figma, screenshots, a URL,
   or a new direction?
2. Does the recommended flavor and baseline fit, or should it use another one?
3. Who uses the feature and what must be visible or easy to do first?
4. Are there non-negotiables such as a brand rule, mobile support, accessibility
   requirement, or a pattern to avoid?

The draft plan contains the guide, baseline choice, token status, and feature
plan. The user can edit any of them through the normal plan flow. Approval
writes `.jonggrang/UI.md`, creates the feature handoff, and adds the
UI-foundation task when the token status is `planned`.

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

```md
# UI handoff: notification settings

Guide: .jonggrang/UI.md
Guide revision: <content digest at approval>
Baseline: neutral-application@1
Token source: client/src/assets/main.css (ready)
Guide status: unchanged

## Shared direction
- Use the existing settings-section pattern and semantic theme values.
- Keep one primary action per viewport.

## References
- .jonggrang/UI.md#components-and-layout-patterns
- client/src/assets/main.css
- client/src/components/app/BaseModal.vue

## Task task-003
Scope: save and inline error state.
States: loading, save-error, saved.
Decision: explicit save; the preference changes product behaviour immediately.
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

The handoff contains shared feature direction and short `## Task task-xxx`
sections. A large feature may have many task sections, but the loader reads
only `## Shared direction` and the section for its own task id. It never
injects the complete guide or every feature task into a fresh context.

## Task contract and prompt context

Task breakdown adds `ui_context` only to UI-related tasks:

```yaml
ui_context:
  handoff: .jonggrang/.output/features/notification-settings/UI_HANDOFF.md
  sections:
    - Shared direction
    - Task task-003
  guide: .jonggrang/UI.md
  guide_revision: <content digest at approval>
  baseline: neutral-application@1
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
handoff sections. The root guide and exact source files remain available when
more detail is needed. A backend without a browser, Figma, or Storybook can
still work from local paths.

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

## First implementation slice

Issue #89 should start with the smallest useful version:

- detect UI-affecting plans and audit `.jonggrang/UI.md` when present;
- create a draft guide with `plan ask` when the guide is missing or incomplete;
- select an existing or starter baseline when no token source exists;
- add a dependent UI-foundation task when the selected token source is planned;
- show guide status, guide diff, and baseline choice beside the plan before
  approval;
- write the approved guide and `UI_HANDOFF.md` at feature approval;
- add `ui_context` to UI tasks and inject only their selected handoff sections;
- record post-feature guide proposals without auto-promoting them.

The initial implementation can ship the neutral application starter only.
Dashboard, marketing, and framework-specific packs can follow without changing
the guide, handoff, or task contract.

## Sources checked

| Source | Why it was used | Retrieved |
|---|---|---|
| [Google Labs `DESIGN.md`](https://github.com/google-labs-code/design.md) | Guide format, rationale, linting, and export ideas | 2026-07-14 |
| [DTCG 2025.10](https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/) | Typed token format when a project needs cross-target tokens | 2026-07-14 |
| [Style Dictionary token docs](https://github.com/style-dictionary/style-dictionary/blob/main/docs/src/content/docs/info/tokens.md) | Token transforms for projects using DTCG | 2026-07-14 |
| [Figma Code Connect](https://help.figma.com/hc/en-us/articles/23920389749655-Code-Connect) | Optional mapping from design components to code | 2026-07-14 |
| [Skyscanner Backpack](https://github.com/Skyscanner/backpack/blob/main/AGENTS.md) | Existing repository practice for agent UI guidance | 2026-07-14 |
| [Moodle design system](https://github.com/moodlehq/design-system) | Component documentation and agent lookup practice | 2026-07-14 |
| [CMS design system](https://github.com/CMSgov/design-system) | Storybook and visual-test practice | 2026-07-14 |
| [designtoken.md](https://designtoken.md/) | Markdown token-sheet format; vendor claims treated as unverified | 2026-07-14 |
