# UI guide and handoff for UI work

**Status:** proposal only; this branch does not change Jonggrang runtime behavior.<br>
**Tracking:** [#89](https://github.com/porcupine-md/jonggrang/issues/89)<br>
**Date:** 2026-07-14

## TL;DR

A project gets one tracked UI guide at `.jonggrang/UI.md`. It describes the
product's visual and interaction rules in the same practical style as this
repository's [`docs/UI.md`](../UI.md).

A UI plan reads that guide and writes a small feature snapshot at
`.jonggrang/.output/features/<feature-id>/UI_HANDOFF.md`. Task breakdown adds a
small `ui_context` object only to UI-related tasks. Each task receives its own
slice of the handoff, not the entire guide.

```text
.jonggrang/UI.md
project-wide guide
        |
        v
feature plan
        |
        +-- UI_HANDOFF.md
        |   feature decisions and guide references
        |
        +-- jonggrang-tasks.json
            ui_context for each UI task
                    |
                    v
              developer / tester / reviewer
```

The guide is global. The handoff is frozen with the approved feature. The task
context is narrow enough to fit the task.

## Why this is one guide plus two handoffs

`docs/UI.md` already shows the useful shape of a UI guide: philosophy, tokens,
typography, components, layout patterns, and rules. Splitting those sections
into several mandatory files would make a small project maintain a design
system it does not need.

The feature and task layers solve a different problem. A global guide cannot
say whether one feature needs explicit save, which state belongs to task 003,
or which existing component should be reused. That information belongs with the
approved plan.

The resulting ownership is simple:

| Location | Contains | Changes when |
|---|---|---|
| `.jonggrang/UI.md` | Product-wide UI rules and source map | A product rule or durable pattern changes |
| `.jonggrang/.output/features/<id>/UI_HANDOFF.md` | Approved feature decisions and references to the guide | The plan is approved or intentionally extended |
| `jonggrang-tasks.json` `ui_context` | Task-specific instructions and source paths | Tasks are broken down or appended |

`docs/UI.md` remains the dashboard documentation for this repository. The new
`.jonggrang/UI.md` is the guide that Jonggrang reads inside any managed project.
A future migration can seed it from an existing `docs/UI.md`; this RFC does not
move or overwrite the current file.

## What belongs in `.jonggrang/UI.md`

The guide is Markdown. It should stay readable and point to code instead of
copying generated CSS or component source.

```md
# UI guide

## Product and users
Who uses the product and what they need to do most often.

## Flavor and visual direction
For example: dense operations tool, calm consumer app, editorial content, or
an existing product that this project must match.

## Source map
- Tokens/theme: client/src/assets/main.css
- Components: client/src/components/
- Stories: none
- Reference: https://figma.com/...

## Tokens and typography
The token source, font choices, scale, and rules for new values.

## Components and layout patterns
Existing primitives, recurring page patterns, and rules for adding a new one.

## Interaction, responsive, and accessibility rules
Loading, empty, error, confirmation, keyboard, and viewport expectations.

## Rules summary
The few rules an agent should not miss.
```

The headings can grow with the project. The required idea is smaller: a person
and an agent should be able to find the visual direction, the real source
files, existing patterns, and hard rules without hunting through the repository.

DTCG, Storybook, Figma, Tailwind, and Chakra are optional sources. If the
project already has one, the guide points to it. Jonggrang does not add those
dependencies just to fill out the guide.

## Creating a guide when one is missing

A plan that affects UI first looks for `.jonggrang/UI.md`, the framework,
existing components, theme files, and live screens. Most of the guide can come
from the repository.

If there is no guide, the planner uses the existing `plan ask` flow for the
parts code cannot answer. It asks only what is needed to make a usable first
draft:

1. What should the UI follow: existing product, Figma, screenshots, a URL, or a
   new direction?
2. Which flavor is closest: application, dashboard, marketing, content, or
   custom?
3. Who uses the feature and what must be visible or easy to do first?
4. Are there non-negotiables such as a brand rule, mobile support, accessibility
   requirement, or a pattern to avoid?

The planner recommends a flavor from the codebase when it can. The user can
keep it, choose another, or give a reference. A flavor is a starting template,
not a visual theme that Jonggrang forces on every project.

The plan draft contains the proposed `UI.md` together with the feature plan.
Approval materializes the guide at `.jonggrang/UI.md`; the user can edit or
revise it before approval through the normal plan flow.

## When a guide already exists

The planner reads the relevant guide sections and code. It should not ask the
user to reconfirm the whole guide on every UI plan.

It asks a question when the request conflicts with the guide, a needed rule is
missing, or the guide points at a source that no longer exists. The plan then
shows the relevant rule and the proposed change. This keeps the guide useful
without turning planning into a repeated design interview.

## Feature handoff

`UI_HANDOFF.md` is a compact feature snapshot. It names the canonical guide and
records the feature decisions that were approved with the plan.

```md
# UI handoff: notification settings

Guide: .jonggrang/UI.md
Guide revision: <content digest at approval>

## Shared direction
- Use the existing settings-section pattern and semantic theme values.
- Keep one primary action per viewport.

## References
- docs/UI.md#settings-section-card
- client/src/assets/main.css
- client/src/components/app/BaseModal.vue

## Task task-003
Scope: save and inline error state.
States: loading, save-error, saved.
Decision: explicit save; the preference changes product behaviour immediately.
Check: npm test
```

The handoff does not copy all of `.jonggrang/UI.md`. It contains the feature's
shared decisions plus short sections for tasks that need UI work. If a feature
has many UI tasks, the file can have more `## Task task-xxx` sections. The task
loader reads `## Shared direction` and the section for its own task id.

This gives the feature a stable record without injecting a large document into
every fresh agent context.

## Task contract

Task breakdown adds `ui_context` only when a task affects UI:

```yaml
ui_context:
  handoff: .jonggrang/.output/features/notification-settings/UI_HANDOFF.md
  sections:
    - Shared direction
    - Task task-003
  guide: .jonggrang/UI.md
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

The developer, tester, and reviewer receive this object and the selected
handoff sections. The guide and source paths remain available when they need
more detail. A backend without browser, Figma, or Storybook access still has
the local guide and source files.

Non-UI tasks have no `ui_context` and keep the current prompt size.

## Keeping the guide current

The planner may draft changes to `.jonggrang/UI.md` before a feature starts.
That draft is reviewed together with the plan.

During implementation, task agents do not edit the global guide. They can note
a repeated pattern or missing rule in their task output. At feature review, the
reviewer decides whether it is worth promoting. The proposal is appended to
`UI_HANDOFF.md` under `## Proposed guide updates`.

The user chooses whether to promote those updates to `.jonggrang/UI.md`. This
keeps one project-wide source of truth and prevents a task from changing global
rules just because it needed a local exception.

A change to `.jonggrang/UI.md` after approval does not silently rewrite an
in-progress feature. The approved handoff remains that feature's contract. A
user can extend or revise the plan when the feature should adopt the newer
rule.

## First implementation slice

Issue #89 should start with the smallest useful version:

- detect UI-affecting plans and look for `.jonggrang/UI.md`;
- use `plan ask` to fill a missing guide from the four questions above;
- draft and approve a new or changed guide with the plan;
- write `UI_HANDOFF.md` during feature approval;
- add `ui_context` to UI tasks and inject only their selected handoff sections;
- record proposed guide updates at review without auto-promoting them.

Storybook lookup, component-index generation, Figma MCP, DTCG transforms, and
visual-regression wiring can be added later when a project already uses them.

## Sources checked

| Source | Why it was used | Retrieved |
|---|---|---|
| [Google Labs `DESIGN.md`](https://github.com/google-labs-code/design.md) | Guide format, linting, and export ideas | 2026-07-14 |
| [DTCG 2025.10](https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/) | Typed token format when a project needs cross-target tokens | 2026-07-14 |
| [Figma Code Connect](https://help.figma.com/hc/en-us/articles/23920389749655-Code-Connect) | Optional mapping from design components to code | 2026-07-14 |
| [Skyscanner Backpack](https://github.com/Skyscanner/backpack/blob/main/AGENTS.md) | Existing repository practice for agent UI guidance | 2026-07-14 |
| [Moodle design system](https://github.com/moodlehq/design-system) | Component documentation and agent lookup practice | 2026-07-14 |
| [CMS design system](https://github.com/CMSgov/design-system) | Storybook and visual-test practice | 2026-07-14 |
| [designtoken.md](https://designtoken.md/) | Markdown token-sheet format; vendor claims treated as unverified | 2026-07-14 |
