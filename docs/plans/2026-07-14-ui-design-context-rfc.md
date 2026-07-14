# RFC: UI Design Context for Planning and Implementation

**Status:** Proposed — documentation and issue only; no runtime behavior changes in this branch.<br>
**Tracking:** [#89](https://github.com/porcupine-md/jonggrang/issues/89)<br>
**Date:** 2026-07-14<br>
**Owner:** Jonggrang maintainers

## TL;DR — Storify

📐 **Peta Konteks UI**

```text
Permintaan: “buat settings page”
             ↓
  [Storybook / component index]
       apa yang sudah benar-benar ada?
             ↓
  [approved baseline / reference]
       primitive atau pattern mana yang boleh diadaptasi?
             ↓
  [UX_SPEC.md]
       untuk siapa, flow apa, state apa, dan keputusan apa?
             ↓
  [implementasi lokal + story]
       bukan copy-paste library atau screenshot
             ↓
  [a11y + visual regression]
       apakah hasilnya terbukti tetap benar?
```

Agent yang hanya diberi `DESIGN.md` seperti tukang yang diberi moodboard: ia
menangkap rasa, tetapi masih harus menebak bahan dan ukuran. Storybook memberi
bahan yang benar-benar tersedia; token/theme memberi ukuran yang legal;
`UX_SPEC.md` menjelaskan keputusan untuk ruangan yang sedang dibuat; dan visual
test memeriksa hasil akhirnya. Plan menyusun konteks itu untuk satu fitur — ia
tidak boleh diam-diam mengubah aturan rumahnya (`UI_SYSTEM.md`, token/theme,
dan component index).

## Decision

Jonggrang should not treat a `DESIGN.md`, a token file, Storybook, Figma, or a
third-party component library as sufficient UI context on its own. A UI feature
needs a small, layered context assembled at plan time and verified during
implementation.

The proposed order is:

```text
existing local component/story
  → approved framework baseline or visual reference
  → feature UX specification
  → local implementation + local story
  → accessibility and visual verification
```

The layers have distinct ownership:

| Artefact | Scope | Owner / source of truth | Plan's role |
|---|---|---|---|
| Token/theme source | Product | Existing theme; DTCG only when portability warrants it | Reference; propose a separate token task if a gap exists |
| `UI_SYSTEM.md` | Product | Human-curated product policy | Read; update only through an explicit, reviewed design-system task |
| Component index | Product | Generated or curated from local source and Storybook | Query; add/update entries when a component changes |
| Storybook | Product | Local production components and states | Primary implementation reference and visual baseline |
| `UX_SPEC.md` | Feature | Created during planning, approved with the feature plan | Compose from the other layers and record feature judgement |

This answers an important boundary: **only `UX_SPEC.md` is a normal output of a
feature plan.** A plan consumes the product-level artefacts; it must not
silently rewrite global design policy or invent a parallel token system.

## Problem

Fresh-context coding agents can reproduce local code patterns but lack durable
UI judgement. A generic request such as “build a settings page” leaves the
agent to guess hierarchy, component choice, error states, responsive behavior,
and visual density. A prose-only design document improves the guess, but does
not prove component reuse or visual conformance.

The current dashboard has a useful local precedent in [`docs/UI.md`](../UI.md):
it documents the terminal-first visual policy, CSS tokens, component decisions,
and exceptions. It is valuable guidance, but it is not a component catalogue,
feature flow, or visual test suite. This RFC generalizes the missing workflow;
it does not change the current Vue/PrimeVue dashboard system.

## Research verdict

### `DESIGN.md`

Google's `DESIGN.md` format combines structured visual identity fields with
prose rationale, linting, reference checking, and export paths. It is useful as
an agent-readable policy layer. Its repository labels the format **alpha**, and
prose cannot enforce the use of a particular production component.

**Use it for:** hierarchy, brand intent, do/don't rules, and cross-feature
judgement.

**Do not use it as:** the only token source or the only verification mechanism.

### DTCG tokens and `designtoken.md`

DTCG is the interoperable typed-token format. It is the best canonical source
when tokens must be transformed across targets or toolchains. Tokens constrain
legal values; they do not decide whether a destructive action needs a dialog,
or which CTA has priority.

`designtoken.md` is a useful agent-friendly bootstrap: it can give a small
project a rich token/reference sheet quickly. It is Markdown and
vendor-specific, so it should not be the canonical source for a mature,
multi-target system. Vendor claims about improved agent output are not treated
as independent benchmark evidence.

### Storybook, Figma, and Code Connect

A mature **local Storybook is the primary implementation reference**. It shows
components that really exist, their variants, states, accessibility behavior,
and intended composition. Figma Code Connect further maps Figma components to
production code and enriches Figma MCP context where the agent backend can use
it.

A Storybook URL alone is not a deterministic agent interface: not every backend
has browser/MCP access, and a story usually does not explain a feature's user
flow. A compact local component index gives agents a stable lookup interface;
Storybook remains the visual and behavioral reference. Screenshot regression
turns that reference into verification.

### Baseline libraries and patterns

Framework libraries and commercial pattern libraries are accelerators, not the
product's design system:

- **Chakra UI** is a React component and theming baseline. A React project may
  adapt its primitives through local recipes or wrappers.
- **Tailwind CSS** is a utility implementation layer. **Tailwind Plus**
  (formerly Tailwind UI) provides patterns/templates, not a production
  component API for the project.
- A Vue product must use a Vue-compatible baseline. The Jonggrang dashboard
  currently uses Vue and PrimeVue; Chakra UI is therefore not a usable
  implementation baseline for that dashboard without a framework migration.

Do not make Chakra and Tailwind two competing component systems in one React
product. Select one primary component/token ownership model. Tailwind utilities
can coexist with Chakra only under explicit rules; otherwise agents will create
duplicate primitives and inconsistent token paths. Respect the license of any
commercial template source and do not redistribute copied source outside its
terms.

## Target model

```text
DTCG tokens OR framework theme                 ┐ legal values
UI_SYSTEM.md                                   ├ policy and rationale
local component index + Storybook              ├ available implementation
Figma/reference screenshot (optional)          ├ intended visual direction
feature UX_SPEC.md                             ┘ feature-specific judgement
                         ↓
                  implementation agent
                         ↓
     token/component checks + a11y + visual regression
```

### Token ownership by maturity

Do not require DTCG from day one.

| Product shape | Canonical value source |
|---|---|
| Single React product using Chakra | Chakra semantic theme tokens |
| Single Tailwind product | CSS variables / Tailwind theme |
| Vue dashboard using PrimeVue | Local CSS variables and PrimeVue overrides/theme |
| Multiple platforms or shared token pipeline | DTCG source, transformed into each target |

There must be one editable canonical source for each token. Generated Tailwind,
Chakra, or CSS output must not be edited as a second source of truth.

## Planning contract for UI work

The planner should first inspect local sources. It must choose the smallest
valid next step:

```text
reuse local component
  → adapt an approved baseline primitive/pattern
    → create a local reusable component and story
      → escalate an intentional new design decision
```

For UI-affecting work, the approved plan should include a compact `ui_context`
section, for example:

```yaml
ui_context:
  existing_components:
    - FormField
    - Toggle
    - AppButton
  baseline:
    kind: component-primitive
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
    - One primary CTA; no autosave because the preference has immediate impact.
```

`UX_SPEC.md` may contain this contract plus the user job, hierarchy, interaction
flow, responsive behavior, copy constraints, and measurable acceptance
criteria. A reference must say *what to preserve*; “make it look like this
screenshot” is not an adequate specification.

If no local component or approved baseline is available, the plan records that
uncertainty and requests design review rather than presenting an invented
pattern as established policy.

## Implementation and review contract

An implementation task with `ui_context` should:

1. inspect the listed local source/story before coding;
2. use semantic tokens and the local component boundary, not arbitrary raw
   colors, spacing, or direct third-party imports where policy disallows them;
3. add or update local stories for material component/page states;
4. test keyboard/focus and relevant accessibility behavior;
5. capture the declared viewport/state screenshots when visual tooling exists;
6. report reference reuse, newly introduced components, and visual/a11y results.

A reviewer verifies the plan mapping, component reuse, state coverage,
accessibility, and visual result. It does not use a screenshot as proof of good
UX judgement: human approval remains necessary for subjective product choices.

## Proposed Jonggrang rollout

This is deliberately staged. It must work for all supported agent backends
without requiring a browser, Figma MCP, Storybook, or a particular frontend
framework.

### Phase A — documentation and voluntary convention

- Publish a UI-context skill/template and the plan contract above.
- Let projects declare paths to their theme, component index, Storybook, and
  optional Figma/reference sources.
- Teach planner, developer, tester, and reviewer prompts to consume the
  context only when a task is UI-affecting.
- Preserve a no-design-system fallback that states assumptions clearly.

### Phase B — deterministic local discovery

- Add a compact, queryable component index contract.
- Add validation for referenced local paths/stories and for missing required
  UI states in the plan.
- Keep framework/baseline adapters declarative rather than hardcoding Chakra
  or Tailwind behavior into Jonggrang.

### Phase C — verification integration

- Allow projects to register existing visual regression and accessibility
  commands.
- Make UI verification results part of the task/review output, but do not
  impose a single testing provider.
- Add Figma MCP/Code Connect as optional enrichment only after every supported
  backend has a clear capability boundary and a local fallback.

## Non-goals

- Building a universal design system, a Figma integration, or a component
  generator in the first issue.
- Replacing a project's existing Storybook, theme, or framework library.
- Pixel-perfect screenshot imitation without a stated UX reason.
- Turning design guidance into a blocking instruction that overrides current
  code, user requirements, or accessibility needs.
- Requiring DTCG, Chakra, Tailwind, Storybook, or Figma for all Jonggrang
  projects.

## Success measures for a later implementation

Evaluate the approach with the same UI task under three conditions: no UI
context, prose-only `DESIGN.md`, and the layered contract. Hold model and task
constant. Measure:

- direct third-party imports or duplicated local primitives;
- hardcoded visual values outside the approved token path;
- declared loading/error/empty state coverage;
- accessibility violations;
- visual regressions against approved baselines;
- human corrections and time to an accepted result.

No public source found in this research provides a controlled benchmark proving
that a single design document outperforms the layered approach. These metrics
are therefore the required local validation, not an assumed result.

## Evidence ledger

| Source | Evidence type | Confidence | Retrieved |
|---|---|---:|---|
| [Google Labs `DESIGN.md`](https://github.com/google-labs-code/design.md) | Primary repository: format, lint, export, alpha status | High | 2026-07-14 |
| [Google announcement](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-design-md/) | Primary product explanation | High | 2026-07-14 |
| [DTCG 2025.10 stable announcement](https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/) | Primary specification announcement | High | 2026-07-14 |
| [Style Dictionary token documentation](https://github.com/style-dictionary/style-dictionary/blob/main/docs/src/content/docs/info/tokens.md) | Primary implementation documentation | High | 2026-07-14 |
| [Figma Code Connect](https://help.figma.com/hc/en-us/articles/23920389749655-Code-Connect) | Primary product documentation | High | 2026-07-14 |
| [Figma design systems and MCP](https://www.figma.com/blog/design-systems-ai-mcp/) | Primary product explanation | Medium | 2026-07-14 |
| [Skyscanner Backpack `AGENTS.md`](https://github.com/Skyscanner/backpack/blob/main/AGENTS.md) | Production repository practice | Medium | 2026-07-14 |
| [Moodle design system](https://github.com/moodlehq/design-system) | Production repository practice | Medium | 2026-07-14 |
| [CMS design system](https://github.com/CMSgov/design-system) | Production repository practice | Medium | 2026-07-14 |
| [designtoken.md](https://designtoken.md/) | Vendor product page | Low for performance claims; medium for format description | 2026-07-14 |
| [WaveSpeed comparison](https://wavespeed.ai/blog/posts/design-md-vs-design-tokens-ai-workflows/) | Opinion/case report | Low for causal claims | 2026-07-14 |
