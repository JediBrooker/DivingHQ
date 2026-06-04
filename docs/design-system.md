# DivingHQ Design System

DivingHQ uses a compact token-first design system in `src/styles/app.css`.
The app is operational software for poolside use, so the default pattern is
dense, scannable, and quiet rather than decorative.

## Source Of Truth

- Primitive color ramps, semantic tokens, type scale, spacing, radii,
  elevation, and motion live in `src/styles/app.css`.
- Components and view styles should reference semantic tokens (`--surface`,
  `--fg-2`, `--accent`, `--danger-bg`) instead of raw primitive colors.
- Legacy aliases (`--cyan`, `--text-3`, `--bg-2`, `--radius-md`, `--panel`)
  are compatibility bridges only. New work should use semantic tokens unless
  it is touching old CSS that already uses the legacy names.
- `test/syntax.test.js` fails if a Vue/CSS file uses an undefined custom
  property, so add any new shared token to `app.css` in the same commit.

## UI Primitives

- Buttons: use `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, and
  `.btn-sm` before adding local button CSS.
- Cards: use `.card`, `.card-sm`, or `.card-inset` for repeated framed
  items. Avoid nested cards and avoid making full page sections look like
  floating cards.
- Inputs: use `.input`, `.select`, `.textarea`, and `.label` unless a control
  has a genuinely custom interaction.
- Status: use `StatusPill.vue` or the semantic status tokens. Avoid one-off
  red/amber/green styling.
- Empty screens: use `EmptyState.vue` where a page needs a standard "nothing
  here yet" state with a next action.
- Tooltips: use `v-tip`, never native `title=`, except for documented
  accessibility-only cases.

## Layout Guidance

- Keep primary work surfaces full-width with constrained inner content.
- Prefer stable dimensions for toolbars, grids, boards, icon buttons, and
  score tiles so live data does not shift the layout.
- Use lucide icons for familiar controls when the dependency already has the
  icon. Pair icon-only buttons with `v-tip`.
- Use responsive constraints and wrapping instead of viewport-scaled type.
  The global type scale is fixed by token.

## When Adding UI

1. Check whether an existing component already covers the pattern.
2. Use semantic tokens from `app.css`.
3. Add a shared class/component only when the same pattern appears in more
   than one place or the pattern is likely to recur.
4. Run `npm run lint`, `npm run build`, and `npm run test:safe`.
