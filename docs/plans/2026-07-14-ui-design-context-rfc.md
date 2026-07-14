# Giving UI tasks useful context

**Status:** proposal only; this branch does not change Jonggrang runtime behavior.<br>
**Tracking:** [#89](https://github.com/porcupine-md/jonggrang/issues/89)<br>
**Date:** 2026-07-14

## TL;DR

When Jonggrang plans a UI task, the agent needs more than a screenshot or a
paragraph saying "make this feel clean." It should first look at the components
and stories already in the project. The plan then records the user flow,
states, references, and decisions for that one feature. Implementation adds to
the local system, and the review checks the result with the project's own a11y
and visual tests where available.

A useful split is:

- `UX_SPEC.md` belongs to a feature plan. It explains the work at hand.
- The theme, `UI_SYSTEM.md`, component index, and Storybook belong to the
  project. A plan reads them. A plan does not rewrite them as a side effect.

That keeps a feature agent from inventing a new button, token scale, or layout
rule just because it did not find the right context quickly.

## The flow at a glance

```text
Feature request
      |
      v
Read the project UI context
(theme, UI_SYSTEM.md, component index, Storybook)
      |
      v
Write UX_SPEC.md for this feature
(flow, states, references, decisions)
      |
      v
Implement with local components or an approved reference
      |
      v
Add or update the local story, then run a11y and visual checks
      |
      v
Review the feature against the approved UX_SPEC.md
```

The first box reads project knowledge. The second creates feature knowledge.
That boundary is the point of the proposal: a settings-page task can add a
settings-page decision without silently changing the project's button rules.

## Why write this down

Jonggrang already gives agents a plan, codebase context, and a review loop.
That works well for code structure. UI work has an extra problem: a request
like “add notification settings” leaves many product choices open. Which
control fits? Is saving immediate? What happens on failure? Does the page use
an existing settings pattern or need a new one?

[`docs/UI.md`](../UI.md) already does part of this for the Jonggrang dashboard.
It describes the terminal-first style, the CSS variables, and several component
choices. It is useful reference material. It does not list every component the
app has, describe every feature flow, or catch a visual regression. The missing
piece is a small way to bring those sources together for each UI task.

## The working model

Start with what the project already owns:

1. Check the local component index and Storybook. Reuse an existing component
   when it fits.
2. If there is a gap, use an approved primitive or pattern as a starting point.
   Record where it came from.
3. Write down the feature's UX decisions in `UX_SPEC.md` alongside the plan.
4. Add the finished component or page state to the local Storybook when that is
   part of the project.
5. Run the project's accessibility and visual checks.

Storybook is the best reference for implementation because it shows code that
is actually in the repository. A Figma frame, external Storybook, or Tailwind
Plus example can still help, but it is a reference. It does not automatically
become a component the product owns.

The agent should be able to read this information without a browser. A compact
component index is enough for lookup; Storybook remains the place to inspect
variants and states visually. Figma MCP and Code Connect are useful additions
for backends that support them, but the basic flow must work from local files.

## What each file is for

### Project-level files

The project keeps these over time:

- The theme or token source holds visual values. Use the existing framework
  theme in a single-product app. Use DTCG when the same tokens must feed
  several platforms or toolchains.
- `UI_SYSTEM.md` or `DESIGN.md` holds product rules that code cannot express
  well: visual density, hierarchy, confirmation, and component-use rules. It
  points to the token source instead of copying every colour and spacing value.
- The component index maps a component name to its source, variants, story, and
  any local rules.
- Storybook records local components and important page states.

These files can change, but changing them is design-system work. It deserves an
explicit task and review.

### Feature-level file

`UX_SPEC.md` is written during planning and approved with the feature plan. It
captures the user job, the page hierarchy, interaction states, responsive
notes, copy constraints, and any deliberate trade-off. It should link to the
local components and to external references used by the plan.

A plan can propose a new token or component when it finds a real gap. The
proposal should become its own task. The planner must not quietly create a
second button style or token family while implementing an unrelated feature.

## A plan entry can stay small

The plan does not need to paste a design system into every task. This is enough
context for a settings feature:

```yaml
ui_context:
  existing_components:
    - FormField
    - Toggle
    - AppButton
  baseline:
    source: chakra-ui
    reference: Switch
  visual_references:
    - figma: https://figma.com/file/.../node-id
    - pattern: tailwind-plus/application-ui/forms/settings
  token_source: design/tokens.tokens.json
  states:
    - loading
    - saved
    - save-error
  stories_to_add:
    - NotificationSettings.loading
    - NotificationSettings.error
  decisions:
    - Save explicitly; this preference has an immediate effect.
```

The `decisions` field tells the next agent what matters about a reference. A
link alone is ambiguous. The plan can say that the page has one primary action,
uses explicit save rather than autosave, and shows field errors in place.

## Baselines are project-specific

Projects start with the local system. They use a compatible, approved source
when there is a real gap. Tailwind and Chakra appear here only as examples for
target projects.

An existing local Storybook is the normal baseline for a project with working
UI. It already reflects the framework, the component API, and the visual rules
that the repository uses. Another team's Storybook can be a reference, but it
only becomes an implementation baseline when the project can actually use its
package or copy its pattern under the right license.

Possible sources include:

- a framework component library, such as Chakra for React or PrimeVue for Vue;
- a pattern library, such as Tailwind Plus;
- an approved external Storybook or Figma reference.

A project may have none of them. In that case the plan records its assumption
and asks for a design decision.

For a React project, Chakra can provide accessible primitives and a theme.
Tailwind can be the utility layer, while Tailwind Plus can provide layout
patterns. If a React project uses both Chakra and Tailwind, it needs a clear
answer for who owns components and tokens. Without that decision, agents will
create two styles of button, input, and spacing scale.

The Jonggrang dashboard is Vue with PrimeVue and local CSS variables. Its local
Storybook, PrimeVue components, and CSS rules come first. Chakra's ideas around
semantic tokens, component recipes, and accessibility can be borrowed; its
React components cannot be imported into the Vue client.

Commercial patterns also come with license terms. The plan may reference them,
but copied source must stay within the relevant license.

## Tokens: start with the system already there

DTCG is useful when a design system needs to generate tokens for several
targets. It is unnecessary ceremony for every project.

| Project | Value source to keep editable |
|---|---|
| React app built on Chakra | Chakra semantic theme tokens |
| Tailwind app | CSS variables or the Tailwind theme |
| Vue and PrimeVue app | Local CSS variables and PrimeVue theme/overrides |
| Shared web, native, or multi-product system | DTCG, transformed for each target |

Each visual value should have one editable home. Generated CSS or framework
output is a build artifact, not another place to edit the same token.

## What implementation and review should check

For a task with `ui_context`, the developer should inspect the listed source
and stories before coding. The task report should name the reused components,
the new local components, and the states it covered. If the project has a
Storybook convention, material states belong there too.

The reviewer checks whether the implementation follows the agreed flow, uses
the expected local components and tokens, and covers the declared states. The
review also runs or records the configured keyboard, accessibility, and visual
checks. Screenshot checks catch visual drift. Plan approval and review still
need a human decision on the product choice.

## First pass

Issue #89 starts with a small convention:

- a template for `UX_SPEC.md` and `ui_context`;
- optional project paths for a theme, component index, Storybook, and visual or
  accessibility commands;
- prompt guidance for planner, developer, tester, and reviewer when a task is
  UI-related;
- a local-file fallback for agents without browser, Storybook, or Figma access.

Later work can add component-index validation, project-configured visual-test
reporting, and optional Figma MCP/Code Connect support. Those additions should
remain backend-neutral and optional.

We should test the convention rather than assume it helps. Give the same UI
change to agents with no context, a prose-only design document, and this
layered context. Compare duplicated components, hardcoded values, state
coverage, a11y findings, visual diffs, and the number of human corrections.

## Sources checked

| Source | Why it was used | Retrieved |
|---|---|---|
| [Google Labs `DESIGN.md`](https://github.com/google-labs-code/design.md) | Format, linter/export ideas, and alpha status | 2026-07-14 |
| [Google announcement](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-design-md/) | Google's rationale for the format | 2026-07-14 |
| [DTCG 2025.10](https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/) | Stable token specification | 2026-07-14 |
| [Style Dictionary token docs](https://github.com/style-dictionary/style-dictionary/blob/main/docs/src/content/docs/info/tokens.md) | DTCG-oriented token transforms | 2026-07-14 |
| [Figma Code Connect](https://help.figma.com/hc/en-us/articles/23920389749655-Code-Connect) | Mapping Figma components to code | 2026-07-14 |
| [Figma on design systems and MCP](https://www.figma.com/blog/design-systems-ai-mcp/) | MCP context available to supported agents | 2026-07-14 |
| [Skyscanner Backpack](https://github.com/Skyscanner/backpack/blob/main/AGENTS.md) | Existing repository practice for agent UI guidance | 2026-07-14 |
| [Moodle design system](https://github.com/moodlehq/design-system) | Existing component-index and Storybook practice | 2026-07-14 |
| [CMS design system](https://github.com/CMSgov/design-system) | Existing Storybook and visual-test practice | 2026-07-14 |
| [designtoken.md](https://designtoken.md/) | Markdown token-sheet format; vendor claims treated as unverified | 2026-07-14 |
| [WaveSpeed comparison](https://wavespeed.ai/blog/posts/design-md-vs-design-tokens-ai-workflows/) | Opinion framing only, not benchmark evidence | 2026-07-14 |
