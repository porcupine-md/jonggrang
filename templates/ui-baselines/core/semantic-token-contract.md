# Semantic token contract

A baseline provides starting values, not permanent brand decisions. Projects copy
its token template to an approved source path and then own that file.

Use semantic roles rather than palette names:

- canvas, surface, surface-raised;
- text, text-muted, text-inverse;
- border, focus, action, action-hover;
- success, warning, danger;
- space-1 through space-8;
- radius-control, radius-panel;
- shadow-raised.

Components consume these roles. They must not introduce raw colour, spacing,
radius, or shadow values when an equivalent project token exists. Every
interactive token needs hover, focus, disabled, and error behavior. Projects
with more than one theme define the same roles in every theme.
