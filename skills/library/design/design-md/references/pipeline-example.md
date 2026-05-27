# DESIGN.md Pipeline Case Study: BukuCepat PO

## Objective
Generate a landing page for `po.bukucepat.id` (PO module) using design system extracted from `bukucepat.id` (main product landing page).

## Target Audience
- Pebisnis PO yang kewalahan handle order di WA
- Pekerja dengan side income jastip/PO
- Bisnis PO yang mau scale up dari catatan manual

## Extracted Design System (Shadcn UI-based)
- **Primary:** `#0f172a` (slate-900) — button backgrounds, CTA sections
- **On-primary:** `#047857` (emerald-700) — text on primary buttons
- **Surface:** `#ffffff` — page background
- **On-surface:** `#111827` (gray-900) — headings, body text
- **Muted:** `#f3f4f6` (gray-100) — alternating section backgrounds
- **Accent:** `#0d9488` (teal-600) — secondary buttons, chips, icon boxes
- **Accent-light:** `#ecfdf5` (teal-50) — chip backgrounds, icon box backgrounds
- **Typography:** System font stack (ui-sans-serif, system-ui)
- **H1:** 72px / 700 / line-height: 1 / tracking: -0.02em
- **H2:** 36px / 700
- **Buttons:** 12px border-radius, 48px height, full-rounded ghost variants
- **Cards:** 16px border-radius, light shadow, white background
- **Layout:** Max-width 1200px, alternating white/gray sections, 80px section padding

## Pipeline Iterations

### V1
- **Extract:** CSS custom properties from browser console, computed styles analysis
- **Issue:** Button colors rendered incorrectly — Tailwind CDN config didn't apply to custom CSS classes
- **Review finding:** Primary buttons not showing dark background

### V2
- **Fix:** Added explicit `background: #0f172a; color: #047857` in `<style>` block for all button variants
- **Improvement:** Better hero copy ("Orderan numpuk, piutang gak ke-track, untung gak jelas?")
- **Added:** Social proof section, card hover animations, icon box shadows
- **Review:** All tokens match reference — minor refinements only

### V3 (Final)
- **Polish:** Hero padding 120px top, scroll-behavior smooth, meta description, mobile responsive
- **Added:** "Baru! Modul Purchase Order" chip in hero
- **Result:** Single-file HTML (16KB), Tailwind CDN, all DESIGN.md tokens accurately rendered

## Key Lessons
1. Pre-extract CSS custom properties from `:root` before writing DESIGN.md
2. Tailwind CDN `extend.colors` unreliable for custom classes — use inline styles as fallback
3. WCAG warnings on brand colors are design decisions, not bugs
- Content adaptation matters as much as visual accuracy — match tone to target audience
- 3 iterations is the sweet spot: v1 gets structure right, v2 fixes styling, v3 polishes

## Landing Page Content Pattern (Indonesian SaaS Audience)
From this session, the user approved this content structure:
- **Hero:** Pain-point question, not feature statement ("Orderan numpuk, piutang gak ke-track?")
- **Problem section:** Before/After comparison with relatable scenarios
- **How it works:** 3-step numbered cards, one sentence per step
- **Features:** 6-card grid, icon + short description, no paragraphs
- **Who it's for:** 3 specific personas, NOT generic "small business owners"
- **Trust:** Social proof even if placeholder ("Dipercaya Ratusan...")
- **CTA:** Low-friction language ("Coba Gratis", not "Daftar Sekarang")
- **Tone:** Casual Indonesian, emoji in headings OK, empowering not corporate
