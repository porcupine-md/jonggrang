---
name: design-md
description: Author/extract/validate/export/integrate Google's DESIGN.md token spec files — full pipeline from reference websites, user prompts, or designer assets to agent-ready design systems with WCAG linting.
version: 1.0.0
author: Coding Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  agent:
    tags: [design, design-system, tokens, ui, accessibility, wcag, tailwind, dtcg, google]
    related_skills: [popular-web-designs, claude-design, excalidraw, architecture-diagram]
---

# DESIGN.md Skill

DESIGN.md is Google's open spec (Apache-2.0, `google-labs-code/design.md`) for
describing a visual identity to coding agents. One file combines:

- **YAML front matter** — machine-readable design tokens (normative values)
- **Markdown body** — human-readable rationale, organized into canonical sections

Tokens give exact values. Prose tells agents *why* those values exist and how to
apply them. The CLI (`npx @google/design.md`) lints structure + WCAG contrast,
diffs versions for regressions, and exports to Tailwind or W3C DTCG JSON.

## When to use this skill

- User asks for a DESIGN.md file, design tokens, or a design system spec
- User wants consistent UI/brand across multiple projects or tools
- User pastes an existing DESIGN.md and asks to lint, diff, export, or extend it
- User asks to port a style guide into a format agents can consume
- User wants contrast / WCAG accessibility validation on their color palette

For purely visual inspiration or layout examples, use `popular-web-designs`
instead. For *process and taste* when designing a one-off HTML artifact
from scratch (prototype, deck, landing page, component lab), use
`claude-design`. This skill is for the *formal spec file* itself.

## File anatomy

```md
---
version: alpha
name: Heritage
description: Architectural minimalism meets journalistic gravitas.
colors:
  primary: "#1A1C1E"
  secondary: "#6C7278"
  tertiary: "#B8422E"
  neutral: "#F7F5F2"
typography:
  h1:
    fontFamily: Public Sans
    fontSize: 3rem
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  body-md:
    fontFamily: Public Sans
    fontSize: 1rem
rounded:
  sm: 4px
  md: 8px
  lg: 16px
spacing:
  sm: 8px
  md: 16px
  lg: 24px
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: 12px
  button-primary-hover:
    backgroundColor: "{colors.primary}"
---

## Overview

Architectural Minimalism meets Journalistic Gravitas...

## Colors

- **Primary (#1A1C1E):** Deep ink for headlines and core text.
- **Tertiary (#B8422E):** "Boston Clay" — the sole driver for interaction.

## Typography

Public Sans for everything except small all-caps labels...

## Components

`button-primary` is the only high-emphasis action on a page...
```

## Token types

| Type | Format | Example |
|------|--------|---------|
| Color | `#` + hex (sRGB) | `"#1A1C1E"` |
| Dimension | number + unit (`px`, `em`, `rem`) | `48px`, `-0.02em` |
| Token reference | `{path.to.token}` | `{colors.primary}` |
| Typography | object with `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, `fontFeature`, `fontVariation` | see above |

Component property whitelist: `backgroundColor`, `textColor`, `typography`,
`rounded`, `padding`, `size`, `height`, `width`. Variants (hover, active,
pressed) are **separate component entries** with related key names
(`button-primary-hover`), not nested.

## Canonical section order

Sections are optional, but present ones MUST appear in this order. Duplicate
headings reject the file.

1. Overview (alias: Brand & Style)
2. Colors
3. Typography
4. Layout (alias: Layout & Spacing)
5. Elevation & Depth (alias: Elevation)
6. Shapes
7. Components
8. Do's and Don'ts

Unknown sections are preserved, not errored. Unknown token names are accepted
if the value type is valid. Unknown component properties produce a warning.

## ⚠️ MANDATORY: Design Brief (Soul Gate)

**Before you write a single token, you MUST dig out and write down the Design Brief.**
Without it, DESIGN.md produces output that is technically accurate but emotionally empty — generic, "AI-looking", not memorable.

The Design Brief is a **mandatory preamble** that answers 5 questions before extraction begins:

### 1. Who sees this? (Audience)
Be specific. Not "business owners" — but "small online sellers who run their store over chat apps, 25-40, not accountants, who dislike fiddly tools."

### 2. What should they feel? (Emotional Target)
One dominant word: relief, confidence, curiosity, delight, safety.

### 3. What should they do? (Behavioral Target)
One primary action: "start a free trial in 30 seconds", not "explore features".

### 4. What references are we borrowing from? (Reference Fusion)
At least 2 sources. Format:
```
Reference A (source) → take: [what to take]
Reference B (source) → take: [what to take]
```

### 5. What MUST be avoided? (Anti-target)
"Must not look like accounting software." "Not corporate." "Not a generic SaaS template."

### Implementation Example

The Design Brief is written as a **YAML preamble + prose** at the top of DESIGN.md:

```yaml
---
name: App
design_brief:
  audience: "Small-business owners, 25-40, not accountants, who run their business over chat"
  emotional_target: "Relief — finally a tool that fits how they actually work, without the headache"
  behavioral_target: "Start a free trial in the first 30 seconds and immediately see the result of a single action"
  reference_fusion:
    - source: "the product's own brand site"
      take: "brand identity & trust signal"
    - source: "WhatsApp"
      take: "warmth (#fcf5eb), familiarity, green CTA (#25d366), pill shapes"
    - source: "GitBook"
      take: "confident narrative flow, outcome-first structure, bold graphite typography"
  anti_target: "Must not look like accounting software. Not corporate. Not a generic SaaS template."
colors:
  primary: "#25d366"
  # ...
---
```

**Agent enforcement rule:** If the Design Brief is incomplete (the 5 questions are not yet answered), DO NOT proceed to token extraction. Ask the user first. If the user can't answer, infer from the product context + reference fusion, then confirm with the user.

### Narrative Structure (First-Class Section)

After the Design Brief + Overview, add a `## Narrative` section that defines the content structure:

```markdown
## Narrative

Landing page section flow:
Hero (big claim + visual demo) → Outcome (what changes, not features)
→ Who It's For (specific persona, early placement)
→ Why It's Different (comparison framing) → How To Use (short, visual)
→ Testimonials (specific: name, city, numbers) → CTA

Tone rules:
- Casual, friendly tone — second person ("you"), not formal
- Emoji in headings OK (💬, 🚀, ✅) — for a consumer / SMB audience
- Avoid domain jargon: replace "accounts receivable" with "who hasn't paid yet"
- One CTA per section, no more

Persona placement: "Who It's For" appears AFTER the outcome section, not at the end.
This matters — readers need to see the value first, then recognize themselves.
```

### Why This Matters

Without a Design Brief + Narrative, an agent will:
- Generate accurate colors but not know why those colors were chosen
- Build a layout that matches the tokens but not know the optimal section order
- Produce UI that is "technically correct" but "has no soul"

With a Design Brief + Narrative, the agent has the context to make **audience-aware** design decisions — not just token-accurate ones.

---

## Workflow: authoring a new DESIGN.md

### Step 0 — Design Brief (MANDATORY)
1. Answer the 5 Design Brief questions above. Ask the user about anything unclear.
2. Write `design_brief:` in the YAML preamble.
3. Write the `## Narrative` section in the markdown body.

### Step 1 — Extract Tokens
1. From a reference website (Mode B), user prompt (Mode A), designer assets (Mode C), or multi-reference fusion (Mode D).
2. Write the YAML tokens: `name`, `colors`, `typography`, `rounded`, `spacing`, `components`.

### Step 2 — Write DESIGN.md
3. **Use token references** (`{colors.primary}`) in the `components:` section.
4. **Write all prose sections** (Overview, Colors, Typography, Layout, Elevation, Shapes, Components, Do's and Don'ts).

### Step 3 — Lint & Verify
5. Run `npx @google/design.md lint DESIGN.md`. Fix errors.
6. Cross-check extracted tokens vs the reference (browser console).

### Step 4 — Export (optional)
7. If the user has an existing project, generate Tailwind/DTCG exports.

### Step 5 — Implement & Review
8. Generate UI from DESIGN.md. See the [5-Phase Pipeline](#workflow-5-phase-designmd--landing-page-pipeline) for the full workflow.
9. If the output still "feels off" even though the tokens are accurate → **check the Design Brief and Narrative, not the tokens.**

## Workflow: lint / diff / export

The CLI is `@google/design.md` (Node). Use `npx` — no global install needed.

```bash
# Validate structure + token references + WCAG contrast
npx -y @google/design.md lint DESIGN.md

# Compare two versions, fail on regression (exit 1 = regression)
npx -y @google/design.md diff DESIGN.md DESIGN-v2.md

# Export to Tailwind theme JSON
npx -y @google/design.md export --format tailwind DESIGN.md > tailwind.theme.json

# Export to W3C DTCG (Design Tokens Format Module) JSON
npx -y @google/design.md export --format dtcg DESIGN.md > tokens.json

# Print the spec itself — useful when injecting into an agent prompt
npx -y @google/design.md spec --rules-only --format json
```

All commands accept `-` for stdin. `lint` returns exit 1 on errors. Use the
`--format json` flag and parse the output if you need to report findings
structurally.

### Lint rule reference (what the 7 rules catch)

- `broken-ref` (error) — `{colors.missing}` points at a non-existent token
- `duplicate-section` (error) — same `## Heading` appears twice
- `invalid-color`, `invalid-dimension`, `invalid-typography` (error)
- `wcag-contrast` (warning/info) — component `textColor` vs `backgroundColor`
  ratio against WCAG AA (4.5:1) and AAA (7:1)
- `unknown-component-property` (warning) — outside the whitelist above

When the user cares about accessibility, call this out explicitly in your
summary — WCAG findings are the most load-bearing reason to use the CLI.

## Pitfalls

- **Don't nest component variants.** `button-primary.hover` is wrong;
  `button-primary-hover` as a sibling key is right.
- **Hex colors must be quoted strings.** YAML will otherwise choke on `#` or
  truncate values like `#1A1C1E` oddly.
- **Negative dimensions need quotes too.** `letterSpacing: -0.02em` parses as
  a YAML flow — write `letterSpacing: "-0.02em"`.
- **Section order is enforced.** If the user gives you prose in a random order,
  reorder it to match the canonical list before saving.
- **`version: alpha` is the current spec version** (as of Apr 2026). The spec
  is marked alpha — watch for breaking changes.
- **Token references resolve by dotted path.** `{colors.primary}` works;
  `{primary}` does not.

## Workflow: extracting DESIGN.md from user input

This skill covers three extraction modes. For deep research background,
see `references/deep-research.md`.

### Mode A: From User Prompt (Vibe → Tokens)

When the user describes a design in words ("dark SaaS, teal accent, Inter font, clean minimal"):

1. **Parse intent → token categories.** Map user vocabulary directly:

| User says | DESIGN.md token |
|---|---|
| "dark theme" | `colors.surface` = dark, `colors.on-surface` = light |
| "blue / teal / purple primary" | `colors.primary` = the named color |
| "font Inter / Plus Jakarta Sans" | `typography.*.fontFamily` = the named font |
| "rounded corners" | `rounded.*` scale |
| "soft shadows" | `Elevation & Depth` prose |
| "card-based" | `Layout` + `components.card-*` |

2. **Infer missing tokens.** What the user doesn't say, derive from context:

- No typography scale? → Generate 6 levels: `h1`, `h2`, `h3`, `body-lg`, `body-md`, `label-sm`
- No spacing? → Default 8px grid: `xs: 4px, sm: 8px, md: 16px, lg: 24px, xl: 32px`
- No rounded? → `sm: 4px, md: 8px, lg: 12px, full: 9999px`
- No components? → Minimal set: `button-primary`, `button-primary-hover`, `card-default`, `input-field`
- No monospace font mentioned? → `JetBrains Mono` or `Fira Code`
- "Dark theme" without surface hierarchy? → Generate 4 surface levels from darkest to lightest

3. **Ask clarification questions** when it matters — don't guess on critical values:

- "Bold & playful" or "Professional & serious"? → shapes Overview tone
- How dark is "dark"? `#000` (OLED) or `#0f1117` (GitHub)?
- Which blue? `#2563eb` (royal), `#3b82f6` (sky), `#06b6d4` (cyan)?
- Any accent/secondary colors beyond primary?
- Border-radius preference: sharp (2-4px), moderate (6-8px), pill (9999px)?

### Mode B: From Reference Website (Visual → Tokens)

When the user says "copy the style of linear.app" or "make it like vercel.com":

**Vision-based (if agent has browser + vision):**
1. Navigate to the site, take a full-page screenshot
2. Analyze visually: dominant background, text colors, accent/CTA color, border colors
3. Identify: font family characteristics, size hierarchy, spacing density, border-radius, shadow/elevation patterns, component styles (solid/outline/ghost buttons, card borders, input fields)
4. Translate observations into DESIGN.md tokens

**DevTools CSS extraction (higher precision):**
1. Navigate to the site in browser
2. Run JS to extract CSS custom properties:
   ```js
   // Check for design tokens
   getComputedStyle(document.body).getPropertyValue('--primary')
   // Check font
   getComputedStyle(document.querySelector('h1')).fontFamily
   // Detect Tailwind
   document.querySelector('[class*="bg-"]') ? 'Tailwind detected' : 'Custom'
   ```
3. If site is open source, check their GitHub for Tailwind config or design tokens
4. Map extracted CSS values to DESIGN.md format

### Mode C: From Designer Assets (Asset → Tokens)

**Screenshot/image:** Vision analysis → extract colors (pixel → hex), typography, layout, spacing.

**Figma (principles — agent can't always access Figma API):** Instruct the user to export:
- Color styles → `colors:` tokens
- Text styles → `typography:` tokens (font, size, weight, line-height, letter-spacing)
- Effect styles → `Elevation & Depth` prose
- Layout grid → `spacing:` + `rounded:` tokens
- Component variants → `components:` tokens

**PDF brand guide:** OCR → parse palette (hex codes), typography (font names/sizes), spacing guidelines → map to DESIGN.md.

### Mode D: Multi-Reference Fusion (2+ sources → 1 DESIGN.md)

Single-reference extraction often produces generic output — if the reference
site is itself bland, copying its tokens just inherits that blandness. Fusing
2–3 references produces something distinctive. This is the **highest-value mode**
and the one most likely to give UI that "has soul."

**Step 1 — Assign a role to each reference.** Don't pull everything from every
source. Decide what each reference contributes:

```
Reference A (source) → take: colors / palette
Reference B (source) → take: typography style + shape language
Reference C (source) → take: narrative structure / flow
```

Example (App): `App.id` (brand identity & trust) + `WhatsApp`
(warmth `#fcf5eb`, green CTA `#25d366`, pill shapes) + `GitBook` (confident
outcome-first narrative flow).

**Step 2 — Build a fusion matrix.** For each token category, pick the winning
source and resolve conflicts deliberately:

| Category | Source | Decision |
|---|---|---|
| Colors / palette | Reference A | Base brand + accent |
| Surface / warmth | Reference B | Background tone, container levels |
| Shape / rounding | Reference B | Pill buttons, card radius |
| Typography | Reference B | Font family + scale |
| Spacing / density | Reference C | Section rhythm, whitespace |
| Narrative flow | Reference C | Section order, tone |

**Step 3 — Extract per source** using Mode A/B/C as appropriate (vision, DevTools
CSS, or assets), but only pull the category assigned to that source.

**Step 4 — Reconcile into one coherent system.** Fusion ≠ collage. Translate the
borrowed pieces into a single internally-consistent palette and scale. If two
references clash (e.g., one sharp-cornered, one pill-shaped), the Design Brief's
anti-target and emotional target break the tie — don't average them.

**Critical:** the goal is *tasteful synthesis*, not token-accurate copying. A
DESIGN.md that captures the *vibe* of its references while being internally
coherent succeeds; one that matches tokens 1:1 but feels dead fails. See the
Taste Calibration Rule below.

## Workflow: integrating DESIGN.md with coding agents

### File placement

```
my-project/
├── DESIGN.md          ← design tokens + rationale (single source of truth)
├── CLAUDE.md          ← agent instructions, references DESIGN.md
├── AGENTS.md          ← multi-agent compatible alternative
├── .agents/
│   └── skills/
│       └── design-system/
│           └── SKILL.md  ← agent rules for applying DESIGN.md tokens
├── src/
└── ...
```

### CLAUDE.md / AGENTS.md integration

```markdown
## Design System

Always read `DESIGN.md` before generating UI. It contains our complete
design tokens (colors, typography, spacing, components) and rationale.
Never hardcode color values — always reference tokens from DESIGN.md.
```

### .agents/skills/design-system/SKILL.md

```markdown
---
name: design-system
description: Apply project design tokens from DESIGN.md to all UI output.
---

# Design System

## Rules

1. Always read `DESIGN.md` at project root before generating any UI code.
2. Use token references exactly as defined — never hardcode equivalent values.
3. Before returning UI output, validate:
   - All colors come from DESIGN.md tokens (no magic hex values)
   - Typography follows the defined scale
   - Spacing uses the defined scale
   - Rounded corners match the defined scale
   - Components reference their DESIGN.md definitions
4. When a UI element has no corresponding component token, derive from
   the closest existing component.
```

### How agents read DESIGN.md

| Layer | How read | Used for |
|---|---|---|
| YAML tokens | Parsed as structured data | Exact values: colors, fonts, sizes, spacing |
| Markdown prose | Natural language context | Rationale, tone, personality, dos/don'ts |

Tokens are the **source of truth**; prose provides **guidance**. Agents should read tokens first, then prose.

### Injection per platform

| Platform | Method |
|---|---|
| **Claude Code** | `CLAUDE.md` at root + `DESIGN.md` at root. Claude auto-reads CLAUDE.md. |
| **Cursor** | `.cursorrules` + `DESIGN.md`. Cursor indexes all project files. |
| **GitHub Copilot** | `.github/copilot-instructions.md` + `DESIGN.md`. Copilot reads workspace. |
| **Coding Agent** | `CLAUDE.md` or `AGENTS.md` + this skill |
| **Gemini CLI** | Project context auto-indexed, `DESIGN.md` at root |
| **Generic agent** | Inject DESIGN.md content into system prompt |

### Export to frameworks

```bash
# Tailwind v3
npx @google/design.md export --format json-tailwind DESIGN.md > tailwind.theme.json
# Merge into tailwind.config.js → theme.extend

# Tailwind v4 (CSS-based)
npx @google/design.md export --format css-tailwind DESIGN.md > theme.css
# Import in main CSS → @theme { ... }

# W3C DTCG (platform-agnostic)
npx @google/design.md export --format dtcg DESIGN.md > tokens.json
# Convert to CSS variables, Style Dictionary, Figma Tokens, etc.
```

### Update & sync workflow

```
1. Designer updates Figma variables
2. Export to DESIGN.md (or update DESIGN.md manually)
3. npx @google/design.md lint DESIGN.md → validate
4. npx @google/design.md diff DESIGN-v1.md DESIGN-v2.md → detect regressions
5. Export to Tailwind/DTCG → update theme files
6. Run visual regression tests (Storybook, Chromatic, Percy)
7. Agent auto-reads updated DESIGN.md next session
```

### Best practices

- DESIGN.md must be in version control (Git) alongside code
- Never duplicate token values elsewhere — DESIGN.md is the single source of truth
- Lint in CI/CD: `npx @google/design.md lint DESIGN.md` as GitHub Actions check
- Diff on PR to catch token regressions before merge
- Prose for human context, tokens for machine consumption
- Component tokens complement prose components — don't do YAML only, add prose in ## Components

## When to NOT use DESIGN.md

DESIGN.md is a tool for **design system persistence** across agents and sessions.
Don't use DESIGN.md when:

- **Single-file project** — one HTML landing page. It's faster to iterate directly in HTML/CSS.
- **Weak visual reference** — if the reference site itself looks generic, extracting tokens just produces even more generic output.
- **Quick exploration** — if you don't yet know what the look should be, bypass DESIGN.md, build 2-3 visual variants, then formalize tokens once the direction is clear.
- **Narrative-heavy content** — DESIGN.md only captures visual tokens, not narrative structure. A good landing page = 20% visual + 60% narrative + 20% taste.

### Multi-Reference Fusion

Don't extract from just one reference — fusing 2–3 sources produces more
distinctive output. See [Mode D](#mode-d-multi-reference-fusion-2-sources--1-designmd)
for the full workflow (role assignment, fusion matrix, reconciliation).

Example: App = the product's own brand site (brand identity) + WhatsApp (warmth + green palette) + GitBook (confident narrative flow, outcome-first structure).

### Taste Calibration Rule

If an implementation from a DESIGN.md that is already technically accurate (lint 0 errors, tokens match) still "feels off" or "AI-looking" — **the problem isn't the tokens. It's the narrative or composition.** Don't add tokens. Change the content structure.

## Workflow: content/narrative structure (NEW)

DESIGN.md currently focuses on visual tokens. For a landing page, the minimum narrative structure should be:

```
Hero (big claim, visual demo) → Outcome (what changes, not features) 
→ Who It's For (specific persona, early placement) 
→ Why It's Different (comparison framing) → How To Use (short, visual) 
→ Testimonials (specific: name, city, numbers) → CTA
```

This borrows the GitBook pattern: outcome-first, not a feature list. The target audience doesn't need features explained — they need to see what changes after they use it.

When generating DESIGN.md from incomplete input, these defaults apply:

| Token category | Default |
|---|---|
| Typography scale | 6 levels: `h1`, `h2`, `h3`, `body-lg`, `body-md`, `label-sm` |
| Spacing scale | 8px grid: `xs: 4px, sm: 8px, md: 16px, lg: 24px, xl: 32px` |
| Rounded scale | `sm: 4px, md: 8px, lg: 12px, full: 9999px` |
| Minimum components | `button-primary`, `button-primary-hover`, `card-default`, `input-field` |
| Monospace companion | `JetBrains Mono` or `Fira Code` (if not specified) |
| Dark mode surfaces | 4 levels from darkest → lightest (if not specified) |

## Recommended component set

When building a DESIGN.md from scratch, start with these components:

| Component | Required variants |
|---|---|
| `button-primary` | `-hover`, `-active`, `-disabled` |
| `button-secondary` | `-hover` |
| `card-default` | `-elevated` (if elevation used) |
| `input-field` | `-focus`, `-error`, `-disabled` |
| `chip-default` | `-selected`, `-hover` |
| `list-item` | `-interactive`, `-hover` |

Variant naming convention: `{component}-{variant}` (e.g., `button-primary-hover`), never nested.

## Pitfalls

- **Don't nest component variants.** `button-primary.hover` is wrong;
  `button-primary-hover` as a sibling key is right.
- **Hex colors must be quoted strings.** YAML will otherwise choke on `#` or
  truncate values like `#1A1C1E` oddly.
- **Negative dimensions need quotes too.** `letterSpacing: -0.02em` parses as
  a YAML flow — write `letterSpacing: \"-0.02em\"`.
- **Section order is enforced.** If the user gives you prose in a random order,
  reorder it to match the canonical list before saving.
- **`version: alpha` is the current spec version** (as of Apr 2026). The spec
  is marked alpha — watch for breaking changes.
- **Token references resolve by dotted path.** `{colors.primary}` works;
  `{primary}` does not.
- **Don't guess critical colors.** If the user says "blue" without specifying
  which blue, ask. The difference between `#2563eb`, `#3b82f6`, and `#06b6d4`
  changes the entire feel of the UI.
- **When extracting from a website, validate.** Visual analysis can misread
  colors due to overlays, transparency, and screen calibration. Always
  cross-check with DevTools CSS extraction when possible.
- **DESIGN.md is the single source of truth.** Don't let the agent hardcode
  equivalent hex values in generated code — always reference tokens.
- **CRITICAL: Token accuracy ≠ good design.** Extracting exact hex values and
  matching them 1:1 produces generic, "AI-looking" output. The real skill is
  **tasteful fusion**: merge the *vibe* of 2+ references (e.g., WhatsApp warmth
  + GitBook confidence), translate to a coherent palette, and apply
  judgment on spacing, typography, and layout proportions. A DESIGN.md that
  perfectly matches tokens but feels dead is a failure. A DESIGN.md that
  captures the *soul* of the references while being internally coherent is
  success.
- **Flat > shadow-heavy.** Modern SaaS landing pages (GitBook, WhatsApp,
  Linear, Vercel) use flat design with color contrast for hierarchy, not heavy
  box-shadows. Shadow-based cards feel dated and "template-y."
- **Pill shapes are the dominant modern pattern.** Rounded-full (9999px) for
  buttons and chips, 16-24px for cards. Sharp corners feel outdated.
- **Generous whitespace is not "wasted space."** Section padding of 80-120px,
  breathing room between elements — this is what separates professional from
  amateur. Compact designs feel claustrophobic.
- **One CTA per viewport.** Multiple competing buttons dilute action. The
  primary button should be the unmistakable next step.

## Workflow: 5-Phase DESIGN.md → Landing Page Pipeline

When the goal is to produce a UI artifact (landing page, component library, app shell) from a DESIGN.md, use this orchestrated pipeline for quality output:

```
Phase 1: EXTRACT   → DESIGN.md from reference (website, prompt, or assets)
Phase 2: VERIFY    → lint + WCAG + cross-check visual accuracy
Phase 3: IMPLEMENT → generate HTML/CSS from DESIGN.md tokens
Phase 4: REVIEW    → compare output vs reference, find gaps
Phase 5: ENHANCE   → update DESIGN.md from review findings
```

Iterate phases 3–5 until review shows only minor refinements.

### Phase details

**Phase 1 — Extract:** Use Mode A/B/C from extraction workflows above. Pre-extract known tokens before writing (CSS custom properties, computed styles). Write DESIGN.md with all 8 canonical sections + YAML frontmatter.

**Phase 2 — Verify:** Run `npx @google/design.md lint`. WCAG warnings from the *original design's choices* (e.g., low-contrast brand colors) are expected — document them, don't force-fix them. Cross-check extracted colors against reference using browser console.

**Phase 3 — Implement:** Generate HTML single-file with Tailwind CDN. Use `tailwind.config` in `<script>` for token values. **Critical:** if Tailwind `extend.colors` doesn't apply to custom CSS classes, use inline `style` attributes or `<style>` block with explicit hex values from DESIGN.md. Always verify button/card rendering matches tokens via browser console after generation.

**Phase 4 — Review:** Check: button colors match DESIGN.md, card border-radius matches, typography scale correct, section alternating pattern present, content tone matches target audience. Create structured review: ✅ accurate / ⚠️ needs refinement / ❌ wrong.

**Phase 5 — Enhance:** Apply review findings. Add missing components, fix incorrect token values, refine prose. Run `diff` to document changes. Bump version folder (v1 → v2 → v3).

### Implementation pitfalls learned

- **Tailwind CDN `extend.colors` may not apply to custom CSS classes.** If `btn-primary` defined in `<style>` uses `background: #0f172a` but Tailwind config has `primary: '#0f172a'`, Tailwind utility classes work but custom classes need inline styles or explicit hex values. Verify in browser console.
- **`transparent` as component backgroundColor.** The DESIGN.md CLI treats `transparent` as `#00000000` and reports WCAG failures. Use the actual intended background color instead (e.g., `{colors.primary}` for ghost buttons on dark headers).
- **WCAG warnings on brand-identity colors are NOT bugs.** If the reference site uses low-contrast combinations intentionally (e.g., dark button + green text), document it in verify report but don't change the design.
- **System font stack in DESIGN.md.** Sites using `ui-sans-serif, system-ui, -apple-system, sans-serif` won't show custom font names in computed styles. That's fine — map to the system font stack in typography tokens.

### Content adaptation for landing pages

When generating a landing page from DESIGN.md:
- Adapt narrative to the target audience, not just the reference site's audience
- Use pain-point-first headlines ("Orders piling up, payments slipping through the cracks?")
- Include a social proof section (even "Trusted by hundreds..." is better than none)
- CTA should be low-friction ("Start Free", not "Sign Up Now")
- Match tone to the audience: casual where it fits, emoji in headings OK, no corporate jargon

### Folder structure for pipeline runs

```
~/design-md-test/
├── plan.md                 ← objectives, agents, iterations
├── v1/
│   ├── DESIGN.md
│   ├── verify-report.md
│   ├── output/index.html
│   └── review-report.md
├── v2/
│   ├── DESIGN.md
│   ├── diff-report.md
│   ├── output/index.html
│   └── review-report.md
└── v3/
    └── output/index.html   ← final deliverable
```

## Spec source of truth

- Repo: https://github.com/google-labs-code/design.md (Apache-2.0)
- CLI: `@google/design.md` on npm
- License of generated DESIGN.md files: whatever the user's project uses;
  the spec itself is Apache-2.0.
- Deep research reference: `references/deep-research.md` (40KB, 10 sections)
- Fusion redesign technique: `references/fusion-redesign.md` — when single-reference extraction produces generic output, fuse 2-3 references for tasteful results
- Landing page narrative flow: `references/landing-page-narrative-flow.md` — battle-tested section structure for SaaS landing pages
- Full pipeline example: `references/pipeline-example.md` (App case study)
