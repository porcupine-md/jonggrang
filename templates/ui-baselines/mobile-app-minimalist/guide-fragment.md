# Mobile app minimalist baseline

## Product and UX rationale

Use this baseline for a mobile product organized around a small number of
frequent tasks. Minimize navigation depth and preserve progress when the user is
interrupted. Comfortable does not mean sparse: the current choice and next
useful action should remain obvious.

## Visual direction and baseline

Use system typography, calm solid surfaces, edge-to-edge sections, and one
accent. Rounded geometry belongs to controls and modal surfaces, not every
container. Let content grouping and dividers replace nested cards.

## Components and layout patterns

- **Screen:** one clear title, optional context action, and a content flow that
  starts at the top; avoid dashboard-style card mosaics.
- **Primary action:** place it after the decision it commits. A sticky bottom
  action is justified only when content length would otherwise hide it.
- **List row:** the whole row is a target when it opens one destination. Keep
  labels, values, and disclosure cues aligned across the list.
- **Form:** use persistent labels, useful input modes, inline validation, and
  explicit save state. Preserve entered values after recoverable failures.
- **Navigation:** use a bottom bar only for three to five peer destinations;
  use back navigation for hierarchy.

## Interaction, responsive, and accessibility rules

Interactive targets are at least 44px. Critical actions have visible controls
and do not depend on swipe or long press. Respect safe areas, large text, reduced
motion, keyboard occlusion, offline state, and interrupted submissions.

## Rules summary

- Optimize the primary one-handed task.
- Use edges, spacing, and dividers before adding containers.
- Preserve progress through interruption and recoverable errors.
- No nested card stacks or gesture-only critical actions.
