# Project migration report — Radix to Base UI

Whole-project migration tracker for `PLAN-radix-to-base-migration.md`. Per-component
reports live beside this file as `.migration/<component>.md`.

## Baseline (Milestone 0, fast gates only)

- Branch: `refactor/base-ui-primitives`, created from `384a237`
  (`fix(renderer): keep quick navigation results scrollable above its footer`) on
  `feat/patchdesk-phase-1`.
- Date: 2026-07-19.
- Slow gates deferred to Milestone 5 per Matthew: `pnpm exec playwright test`,
  `pnpm package:mac`, `pnpm test:package-smoke`, packaged-app CDP screenshots.

| Command | Result |
| --- | --- |
| `pnpm lint` | pass (eslint, `--max-warnings=0`) |
| `pnpm typecheck` | pass (`tsc --noEmit`) |
| `pnpm test -- --run` | pass (42 files, 216 tests, ~4.4s) |
| `pnpm build` | pass (electron-vite, ~2.2s renderer) |

No pre-existing failures in the fast gates.

## Dependency transition

Done (Milestone 1): `@base-ui/react@1.6.0` added alongside `radix-ui@^1.6.2`;
`components.json` style flipped to `base-nova` (CLI `init` cannot detect the
electron-vite framework, so the flip was a manual edit; `shadcn add` resolves
the base-nova registry from it). `radix-ui` removal is scheduled for Milestone 5.

## Wrapper/consumer sweep summary

Milestone 1 complete (2026-07-19). Migrated: button, badge, separator, label,
checkbox, scroll-area, tabs, toggle, toggle-group, button-group, item.
Deleted `toggle-variants.ts` (superseded by base-nova toggle's own export).
Test adaptations: PointerEvent polyfill in `tests/setup.ts` (Base UI checkbox
re-dispatches clicks as PointerEvent, which jsdom lacks), and role-based
checkbox queries in the two write-confirmation dialog suites.

## Final Radix count

8 wrappers remain on Radix as of Milestone 1 close (dialog, alert-dialog,
sheet, dropdown-menu, select, popover, tooltip, sidebar). Source of truth:
`rg -l 'radix-ui' src/renderer/src/components/ui`.

## Outstanding behavior deltas

None recorded yet.

## Full validation evidence (Milestone 5)

Pending — deferred slow gates, packaged CDP walkthrough, screenshots.
