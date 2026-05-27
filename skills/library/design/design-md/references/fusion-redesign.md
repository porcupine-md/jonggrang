# Fusion Redesign Technique

When a single reference is too generic or produces "AI-looking" output, fuse 2-3 references:

## The Method

1. **Pick 2-3 references with contrasting strengths.** One for mood/color (e.g., WhatsApp warm cream + green), one for structure/confidence (e.g., GitBook bold graphite + tight hero), optionally one for domain/audience.

2. **Extract CSS via DevTools from each.** `getComputedStyle` + root vars + button analysis. Don't screenshot-analyze — CSS is more accurate.

3. **Build a fusion palette.** Don't copy hex values 1:1. Instead:
   - Take the *mood color* from reference A (WhatsApp green `#25d366`)
   - Take the *structural color* from reference B (GitBook graphite `#111b21`)
   - Bridge them with a *neutral base* (WhatsApp cream `#fcf5eb`)
   - Add light/dark variants for section alternating

4. **Apply modern patterns regardless of reference:**
   - Flat design (no heavy shadows) — use color contrast for hierarchy
   - Pill shapes (9999px radius) for buttons and chips
   - 16-24px radius for cards
   - 80-120px vertical section padding
   - System font stack (no custom font hosting needed)
   - One CTA per viewport
   - Generous whitespace everywhere

5. **Write DESIGN.md with YAML tokens + prose rationale.** Lint, verify 0 errors.

6. **Generate HTML with inline CSS (not Tailwind CDN for production feel).** The CSS should be a 1:1 translation of DESIGN.md tokens — no utility classes that mask the design system.

7. **Deploy and review.** If it feels "AI," the palette or spacing is wrong. Adjust and redeploy.

## V4 Example: An App

- **WhatsApp:** `#fcf5eb` cream bg, `#25d366` green CTA, `#dcf8c6` green-pale, flat design, pill shapes
- **GitBook:** `#111b21` graphite dark, `#fe551b` orange accent, `General Sans` bold, tight hero spacing, confidence tone
- **Fusion:** WhatsApp palette + GitBook structure + App casual tone

Result: warm, human, professional — not a template.
