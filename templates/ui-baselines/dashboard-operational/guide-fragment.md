# Dashboard operational baseline

## Product and UX rationale

Use this baseline for software people operate repeatedly, not a presentation of
metrics. Optimize scan time, comparison, exception handling, and safe action.
Default density is compact because users build familiarity with the interface.

## Visual direction and baseline

Use calm neutral surfaces, crisp boundaries, tabular alignment, and restrained
status colour. Typography distinguishes labels, values, and metadata without
turning every number into a hero statistic.

## Components and layout patterns

- **Workspace shell:** stable navigation and controls frame a scrollable work
  area. Avoid placing each region in an unrelated floating card.
- **Data table/list:** align comparable values, keep identifiers visible, and
  expose sort/filter state. Rows own hover, selected, loading, empty, and error
  behavior.
- **Status:** pair colour with a word or icon. Reserve saturated colour for
  exceptions and active decisions.
- **Action bar:** one primary action for the current scope; common secondary
  actions stay visible instead of hiding in a catch-all menu.
- **Detail panel:** preserve list context while showing evidence and actions for
  the selected record.

## Interaction, responsive, and accessibility rules

Keyboard focus is always visible. Loading preserves column geometry. Errors
appear beside the failed operation and retain user input. On narrow screens,
stack controls before permitting horizontal table scroll; never silently drop
columns that carry decision-critical data.

## Rules summary

- Optimize repeated operations, not screenshots.
- Reuse table, filter, status, and action patterns.
- Make state explicit in text as well as colour.
- No dashboard wallpaper made from oversized rounded cards.
