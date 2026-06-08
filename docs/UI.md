# Jonggrang Web — UI Design Guidelines

> Design system for the Jonggrang dashboard client (`client/`).  
> Reference site: **jonggrang.dev** — all visual decisions trace back to that aesthetic.

---

## 1. Philosophy

- **Terminal-first.** The UI is a power tool, not a product. Monospace everywhere, zero decoration.
- **Sharp corners.** `border-radius: 0px` on all interactive and container elements. No pills, no cards with rounded edges. Exception: circular status dots and timeline markers (those use `border-radius: 50%`).
- **Muted by default, green for action.** Most UI is dim and recedes. Green (`--jg-green`) is the single accent — used only for primary actions, active states, and success indicators.
- **Density.** Small text, tight padding, minimal chrome. Every pixel earns its place.
- **Two modes, one palette.** Night (dark) is the default. Light mode exists with properly darkened accent colors for contrast.

---

## 2. Design Tokens

All tokens live in `client/src/assets/main.css` as CSS custom properties.

### 2.1 Accent Colors (mode-invariant in dark, overridden in light)

```css
--jg-green:  oklch(0.78  0.16  145)   /* primary action, success */
--jg-red:    oklch(0.68  0.18  25)    /* danger, error */
--jg-orange: oklch(0.78  0.14  70)    /* warning, in-progress */
--jg-violet: oklch(0.70  0.16  295)   /* decorative only */
--jg-cyan:   oklch(0.78  0.14  220)   /* info */
```

### 2.2 Surface Colors

| Token | Night | Light | Usage |
|---|---|---|---|
| `--jg-bg` | `oklch(0.165 0.014 245)` | `oklch(0.985 0.004 95)` | Page background |
| `--jg-card` | `oklch(0.195 0.014 245)` | `oklch(1.00 0.000 0)` | Card / panel surface |
| `--jg-hover` | `oklch(0.225 0.014 245)` | `oklch(0.95 0.004 245)` | Hover state background |
| `--jg-border` | `oklch(0.32 0.014 245)` | `oklch(0.85 0.008 95)` | Borders, dividers |

### 2.3 Text Colors

| Token | Night | Light | Usage |
|---|---|---|---|
| `--jg-text` | `oklch(0.92 0.006 95)` | `oklch(0.18 0.014 245)` | Primary text |
| `--jg-text-dim` | `oklch(0.78 0.008 95)` | `oklch(0.30 0.010 245)` | Secondary text |
| `--jg-text-muted` | `oklch(0.60 0.008 95)` | `oklch(0.46 0.010 245)` | Placeholders, labels |
| `--jg-text-faint` | `oklch(0.45 0.008 95)` | `oklch(0.62 0.010 245)` | Timestamps, metadata |

### 2.4 Light Mode Accent Overrides

Green and other accents are darkened in light mode for WCAG contrast on white backgrounds:

```css
html:not(.dark) {
  --jg-green:  oklch(0.52 0.18  145);
  --jg-red:    oklch(0.50 0.18  25);
  --jg-orange: oklch(0.52 0.14  70);
  --jg-cyan:   oklch(0.50 0.14  220);
}
```

### 2.5 Global Shape Token

```css
--radius: 0px;   /* Sharp corners everywhere */
```

---

## 3. Typography

**Font stack:**
```css
--font-mono: 'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace;
```

Single font family for the entire UI. No serif or sans-serif. Base size is `13px` at `line-height: 1.6`.

### Type Scale

| Usage | Size | Weight | Color |
|---|---|---|---|
| Section headers (uppercase) | 11px | 600 | `--jg-text-faint` |
| Body / component text | 12–13px | 400 | `--jg-text` |
| Labels, secondary | 11–12px | 400 | `--jg-text-muted` |
| Metadata (timestamps, paths) | 10–11px | 400 | `--jg-text-faint` |
| Tags / badges | 9px | 600 | varies |

**Section headers** always use `text-transform: uppercase` and `letter-spacing: 0.07em`.

---

## 4. Spacing

No design-token spacing scale — use raw values consistently:

| Context | Value |
|---|---|
| Component internal padding | 8px 12px – 10px 16px |
| Gap between related items | 6–8px |
| Gap between sections | 12–16px |
| Button padding | 5px 14px (default), 3px 10px (small) |
| Tag / badge padding | 2px 5px |
| Section header padding | 10px 16px |

---

## 5. Color Mixing Patterns

Use `color-mix(in oklch, ...)` for transparent variants — never hardcode rgba:

```css
/* Subtle background tint */
color-mix(in oklch, var(--jg-green) 12%, var(--jg-bg))

/* Soft border */
color-mix(in oklch, var(--jg-green) 50%, transparent)

/* Danger bg on hover */
color-mix(in oklch, var(--jg-red) 10%, transparent)
```

---

## 6. Components

### 6.1 Buttons

All buttons: `border-radius: 0px`, `font-family: var(--font-mono)`, `font-size: 12px`, `font-weight: 500`.

#### Primary (solid green)
```
background: var(--jg-green)
color: oklch(0.12 0.04 145)        ← dark green text for contrast
border: 1px solid var(--jg-green)
padding: 5px 14px
```
Hover: `color-mix(in oklch, var(--jg-green) 85%, white)` tint.

#### Secondary (outline)
```
background: transparent
color: var(--jg-text-muted)
border: 1px solid var(--jg-border)
```
Hover: `background: var(--jg-hover)`, `color: var(--jg-text)`.

#### Danger (outline red)
```
background: transparent
color: var(--jg-red)
border: 1px solid color-mix(in oklch, var(--jg-red) 45%, transparent)
```
Hover: faint red background, solid red border.

#### Disabled
```
opacity: 0.35
cursor: not-allowed
```

#### Small variant
```
font-size: 11px
padding: 3px 10px
```

### 6.2 Inputs & Textarea

```
background: var(--jg-bg)
color: var(--jg-text)
border: 1px solid var(--jg-border)
border-radius: 0px
font-family: var(--font-mono)
font-size: 12px
```

**Focus ring:**
```
border-color: var(--jg-green)
box-shadow: 0 0 0 1px color-mix(in oklch, var(--jg-green) 30%, transparent)
```

Placeholder: `--jg-text-faint`.

### 6.3 Checkboxes

Native `<input type="checkbox">` styled via:
```css
accent-color: var(--jg-green);
width: 12px; height: 12px;
flex-shrink: 0;
```
Focus ring: `outline: 1px solid var(--jg-green)`.

Do **not** use PrimeVue Checkbox component — native + accent-color is sufficient and lighter.

### 6.4 SelectButton (Segmented Control)

Used for the theme switcher (Night / Light / System).

```
border: 1px solid var(--jg-border)
border-radius: 0px
overflow: hidden
```

Each segment:
```
background: transparent
color: var(--jg-text-muted)
border-right: 1px solid var(--jg-border)
font-size: 11px
padding: 5px 14px
```

**Active segment:**
```
background: color-mix(in oklch, var(--jg-green) 12%, var(--jg-bg))
color: var(--jg-green)
```

**Critical:** Override `.p-togglebutton-content` (PrimeVue inner element) to remove its default `border-radius: 6px` and white background — this is the source of the "bubble" effect.

### 6.5 Tags / Badges

#### PrimeVue Tag
```
font-size: 9px
font-weight: 600
text-transform: uppercase
letter-spacing: 0.08em
border-radius: 0px
padding: 2px 5px
```

Severity palette (PrimeVue): `success` = green, `warn` = orange, `danger` = red, `info` = cyan, `secondary` = muted.

#### Counter Badge (e.g. 16/16)
PrimeVue `<Badge>` overridden to:
```
font-size: 9px
border-radius: 0px
background: var(--jg-hover)
color: var(--jg-text-faint)
border: 1px solid var(--jg-border)
padding: 1px 5px
letter-spacing: 0.04em
```

#### Sidebar chip (e.g. Pipeline 15/16)
```css
.snav-chip {
  font-size: 9px;
  background: var(--jg-hover);
  color: var(--jg-text-faint);
  padding: 1px 4px;
  border-radius: 0px;
  letter-spacing: 0.04em;
}
```

### 6.6 Progress Bar

```
height: 2px
border-radius: 0px
background (track): var(--jg-hover)
background (value): var(--jg-green)
```

### 6.7 Dialog / Drawer

```
background: var(--jg-card)
border: 1px solid var(--jg-border)
border-radius: 0px
box-shadow: 0 8px 32px oklch(0 0 0 / 0.4)
```

Header has a `border-bottom: 1px solid var(--jg-border)`.

### 6.8 Tabs

```
/* Tab list */
border-bottom: 1px solid var(--jg-border)
background: transparent

/* Tab item */
font-size: 12px
color: var(--jg-text-muted)
padding: 8px 16px
border-bottom: 2px solid transparent

/* Active tab */
color: var(--jg-green)
border-bottom-color: var(--jg-green)
```

### 6.9 Select Dropdown

```
background: var(--jg-card)
border: 1px solid var(--jg-border)
border-radius: 0px
box-shadow: 0 4px 16px oklch(0 0 0 / 0.3)
```

Selected option: `color: var(--jg-green)`, faint green background.

### 6.10 Scrollbar

```css
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--jg-border); border-radius: 0px; }
::-webkit-scrollbar-thumb:hover { background: var(--jg-text-faint); }
```

---

## 7. Layout Patterns

### Sidebar nav link
```
display: flex; align-items: center; gap: 8px;
padding: 8px 12px;
border-radius: 0px;
font-size: 12px;
color: var(--jg-text-muted);
```

Active: `background: color-mix(in oklch, var(--jg-green) 12%, transparent)`, `color: var(--jg-green)`.

### Project card
```
background: var(--jg-card)
border: 1px solid var(--jg-border)
border-radius: 0px
padding: 16px
```
Hover: `border-color: var(--jg-green)`, `background: var(--jg-hover)`.

### Settings section card
```
background: var(--jg-card)
border: 1px solid var(--jg-border)
border-radius: 0px
padding: 20px
```

Section header inside: `font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--jg-text-faint)`.

---

## 8. Pipeline Timeline

### Markers (always circular)

```
width: 20px; height: 20px;
border-radius: 50%;            ← exception to the zero-radius rule
border: 1.5px solid var(--jg-border);
background: transparent;
```

| State | Background | Border | Color |
|---|---|---|---|
| `pending` | transparent | `--jg-border` | `--jg-text-faint` |
| `completed` | `var(--jg-green)` | `var(--jg-green)` | `oklch(0.12 0.04 145)` |
| `in_progress` | transparent | `var(--jg-orange)` | `var(--jg-orange)` |
| `skipped` | transparent | `--jg-border` | `--jg-text-faint`, `opacity: 0.3` |

Icons: `pi-check` (completed), `pi-spin pi-spinner` (in_progress), `pi-minus` (skipped), `pi-circle` (pending).

### Connector line
```
width: 1px
background: var(--jg-border)
```

---

## 9. Kanban Board

### Column
```
border-radius: 0px
overflow: hidden
```

Column accent colors applied via top border on header:

| Status | Token |
|---|---|
| Default / To Do | `--jg-text-faint` (muted) |
| In Progress | `--jg-orange` |
| Blocked | `--jg-red` |
| Done | `--jg-green` |

### Task card
```
background: var(--jg-bg)
border: 1px solid var(--jg-border)
border-radius: 0px
```

Status border on left side:
- `in_progress`: `color-mix(in oklch, var(--jg-orange) 40%, transparent)`
- `completed`: `color-mix(in oklch, var(--jg-green) 35%, transparent)`

Status dot: `width: 7px; height: 7px; border-radius: 50%` (intentionally circular).

---

## 10. Dark / Light Mode

Switching is done by toggling `html.dark` class via `useTheme.js`.

- **Night** = `html.dark` class present
- **Light** = `html.dark` class absent

```js
// useTheme.js
function apply(mode) {
  if (mode === 'night') html.classList.add('dark');
  else if (mode === 'light') html.classList.remove('dark');
  else html.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches);
}
```

PrimeVue is configured with `darkModeSelector: 'html.dark'` so component tokens switch automatically.

**Do not** use `html.dark :root {}` — Chrome treats `:root` as a descendant selector in that form, breaking CSS variable inheritance. Use `html.dark {}` directly.

---

## 11. Icons

Library: **PrimeIcons** (`pi` class prefix).

Common usage:

| Icon | Class | Context |
|---|---|---|
| Check | `pi pi-check` | Completed state |
| Spinner | `pi pi-spin pi-spinner` | Loading / in-progress |
| Minus | `pi pi-minus` | Skipped state |
| Circle | `pi pi-circle` | Pending state |
| Sparkles | `pi pi-sparkles` | AI / generate actions |
| Sitemap | `pi pi-sitemap` | Pipeline |
| List check | `pi pi-list-check` | Tasks |
| Desktop | `pi pi-desktop` | Logs |

Icons inside buttons: `font-size: 11px`.

---

## 12. Motion

Transitions are minimal and fast:

```css
transition: background 0.12s, border-color 0.12s, color 0.12s;
```

No animations on layout elements. The running-dot pulse animation (Kanban header) uses:
```css
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
```

---

## 13. PrimeVue Overrides

PrimeVue injects stylesheets at runtime, after static CSS. **Always use `!important`** when overriding PrimeVue component styles. All overrides live in `client/src/assets/main.css`.

Critical overrides documented:
- `.p-button` — border-radius, font, size
- `.p-togglebutton-content` — removes the default 6px rounded bubble in SelectButton
- `.p-inputtext`, `.p-textarea`, `.p-select` — flat inputs
- `.p-tag` — uppercase flat chips
- `.p-badge` — flat counter
- `.p-progressbar` — thin 2px track
- `.p-dialog`, `.p-drawer` — flat panels
- `.p-tab` — flat underline-style tabs

---

## 14. Rules Summary

| Rule | ✓ | ✗ |
|---|---|---|
| Border radius | `0px` everywhere | Any `px` value except for circles |
| Circle exceptions | Status dots, timeline markers | Buttons, cards, inputs, tags |
| Colors | `--jg-*` tokens, `oklch()`, `color-mix()` | Hex values, `rgb()`, Tailwind classes |
| Font | `var(--font-mono)` | Sans-serif, system-ui |
| Accent color | `--jg-green` for primary/active | Multiple accent colors in same context |
| PrimeVue overrides | `!important` in `main.css` | Scoped overrides in component `<style>` |
| Light mode accents | Darkened in `html:not(.dark)` | Same lightness as dark mode |
| Spacing | Raw pixel values | Tailwind `gap-*`, `p-*` classes |
