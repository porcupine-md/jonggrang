# UI baseline packs

A baseline pack is an optional, versioned starting point for a project that has
no established UI direction. It supplies a guide fragment and semantic-token
template; it never overrides an existing project guide, a user reference, or
explicit consent.

The catalog is discovered from `templates/ui-baselines/`. Adding a valid pack
directory makes it available to the CLI and Plan Mode—there is no code registry
to edit.

## Add a pack

Create one directory:

```text
templates/ui-baselines/<pack-name>/
  manifest.yml
  guide-fragment.md
  tokens.css.template
```

Use a unique, immutable `id@version`. A material change to an existing pack
creates a new version (for example, `checkout-focused@2`), rather than editing
the template behind `checkout-focused@1`. Duplicate keys are invalid and are
not offered to users.

### `manifest.yml`

These fields are required:

```yaml
id: checkout-focused
version: 1
intent: Short, trustworthy purchase and confirmation flows.
product_shapes:
  - checkout
  - purchase-flow
guide_fragment: guide-fragment.md
token_template: tokens.css.template
```

Recommendation metadata is optional. It recommends a candidate only; it never
counts as user consent:

```yaml
recommend_keywords:
  - checkout
  - cart
  - payment
recommend_frameworks:
  - react-native
recommend_priority: 20
```

- `recommend_keywords` matches the plan description case-insensitively.
- `recommend_frameworks` matches a framework found by the repository audit.
- `recommend_priority` resolves multiple matches; higher wins, then pack key.

Every path must remain inside the pack directory. A malformed manifest, missing
file, invalid metadata value, or duplicate `id@version` is excluded from the
catalog.

## Pack content

`guide-fragment.md` must describe the product rationale, visual direction,
component/layout patterns, interaction/accessibility rules, and anti-patterns.
It is a starting point, not a full project guide.

`tokens.css.template` must follow the shared
[semantic token contract](../templates/ui-baselines/core/semantic-token-contract.md).
Projects copy an approved template to a project-owned token source and can then
change it as needed.

Use the shared [guide section contract](../templates/ui-baselines/core/guide-sections.md)
when writing the final project guide.

## Verify a baseline PR

Run:

```bash
node test/ui-context.test.js
bash scripts/qa-ui-context.sh
bash scripts/smoke-ui-starter-pack.sh
npm test
npm run check
```

A baseline must be useful as an explicit user selection even without
recommendation metadata. Keep recommendation terms specific enough that they do
not turn a weak keyword match into an assumed design decision.
