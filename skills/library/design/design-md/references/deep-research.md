# DESIGN.md — Condensed Research Reference

> Source: Full report at `obs-brain/raw/design-md-deep-research.md` (40.8KB, 10 sections)
> This is the agent-facing condensed version for quick lookups.

## Key Facts

- **Created by:** Google Stitch Team (Google Labs), led by David East (davideast), Cassia Xu
- **Released:** April 21, 2026
- **Status:** Alpha (version: alpha)
- **License:** Apache-2.0
- **Repo:** `google-labs-code/design.md` — 14.9k ⭐, 1.4k forks
- **npm:** `@google/design.md` — 3 versions (0.1.0 → 0.2.0)
- **CLI built with:** TypeScript + Bun + unified/remark + Ink (terminal UI) + clipanion

## Philosophy

**"Token-First, Agent-First"** — One file that serves as the single source of truth for AI coding agents:
- **YAML frontmatter** = machine-readable design tokens (normative values)
- **Markdown body** = human-readable rationale (tells agents *why*)

Problem solved: AI agents have no persistent understanding of design systems across sessions. DESIGN.md bridges this gap.

## Token Schema

```yaml
version: alpha
name: <string>
description: <string>  # optional
colors: { <name>: <hex-color> }
typography: { <name>: { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing?, fontFeature?, fontVariation? } }
rounded: { <scale>: <Dimension> }
spacing: { <scale>: <Dimension | number> }
components: { <name>: { backgroundColor?, textColor?, typography?, rounded?, padding?, size?, height?, width? } }
```

## Canonical Section Order

1. Overview (alias: Brand & Style)
2. Colors
3. Typography
4. Layout (alias: Layout & Spacing)
5. Elevation & Depth (alias: Elevation)
6. Shapes
7. Components
8. Do's and Don'ts

Sections can be omitted; present ones MUST follow this order. Unknown sections preserved.

## CLI Commands

```bash
npx @google/design.md lint DESIGN.md      # validate structure + WCAG
npx @google/design.md diff v1.md v2.md    # detect regressions
npx @google/design.md export --format json-tailwind DESIGN.md > tailwind.theme.json
npx @google/design.md export --format css-tailwind DESIGN.md > theme.css
npx @google/design.md export --format dtcg DESIGN.md > tokens.json
npx @google/design.md spec --rules-only --format json  # spec for agent prompts
```

## Lint Rules (8 rules in v0.2.0)

| Rule | Severity | Checks |
|---|---|---|
| broken-ref | error | Token ref `{colors.X}` doesn't resolve |
| missing-primary | warning | Colors defined but no `primary` |
| contrast-ratio | warning | Component text/background below WCAG AA (4.5:1) |
| orphaned-tokens | warning | Color tokens defined but never referenced |
| token-summary | info | Count of tokens per section |
| missing-sections | info | Optional sections absent when tokens exist |
| missing-typography | warning | Colors defined but no typography |
| section-order | warning | Sections out of canonical order |

## Token Types

| Type | Format | Example |
|---|---|---|
| Color | `#` + hex (sRGB) | `"#1A1C1E"` |
| Dimension | number + unit (`px`,`em`,`rem`) | `48px`, `-0.02em` |
| Token Reference | `{path.to.token}` | `{colors.primary}` |
| Typography | object (see schema) | `{fontFamily: Inter, fontSize: 1rem}` |

## Component Property Whitelist

`backgroundColor`, `textColor`, `typography`, `rounded`, `padding`, `size`, `height`, `width`

Variants are separate entries (e.g., `button-primary-hover`), NOT nested.

## Pitfalls

- Hex colors MUST be quoted strings in YAML
- Negative dimensions MUST be quoted: `letterSpacing: "-0.02em"`
- Token references use dotted path: `{colors.primary}`, not `{primary}`
- `version: alpha` — spec may change; watch for breaking changes
- Don't nest component variants: `button-primary.hover` ✗, `button-primary-hover` ✓

## Official Examples

1. **Atmospheric Glass** — Glassmorphism, Inter, dark gradient bg, multi-level blur
2. **Paws & Paths** — Friendly corporate, pet adoption, warm palette
3. **Totality Festival** — Cosmic/premium, festival branding

## Integration Patterns

- **Project root DESIGN.md + CLAUDE.md** — most common
- **`.agents/skills/design-system/SKILL.md`** — Google's own convention
- **Agent reads:** YAML for exact values, prose for rationale/context
- **Export ecosystem:** Tailwind v3 (JSON), Tailwind v4 (CSS), W3C DTCG (JSON)
