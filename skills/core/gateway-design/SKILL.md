---
name: gateway-design
description: Route design-system / DESIGN.md / design-token work to the right library skill. Detects visual-identity intent and returns the design-md skill path.
type: gateway
tier: core
domains: [design, visual-identity, design-tokens]
trigger: "design token, design system, DESIGN.md, color palette, typography, WCAG, contrast, visual identity, brand, theme"
---

## Purpose

You are the Design Gateway. Detect intent from the current task and return the exact library skill path to load. Do NOT execute — only route.

## Intent Detection → Skill Routing

| Intent Keywords | Load Skill |
|---|---|
| `design token`, `design system`, `DESIGN.md`, `color palette`, `typography`, `WCAG`, `contrast`, `theme`, `visual identity`, `brand` | `skills/library/design/design-md/SKILL.md` |

## Output Format

```
GATEWAY_DESIGN:
Domain: design
Skills to load:
  - [absolute/path/to/SKILL.md]

Instructions: Read the above skill file before authoring or verifying DESIGN.md.
```
