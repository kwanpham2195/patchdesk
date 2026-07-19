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

Pending. Target: add `@base-ui/react` alongside `radix-ui@^1.6.2`, apply the
`base-nova` preset via the shadcn CLI, remove `radix-ui` only after the final
sweep (Milestone 5).

## Wrapper/consumer sweep summary

Not started. 19 Radix wrappers under `src/renderer/src/components/ui` plus
`toggle-variants.ts`; consumer sweep pending per the plan.

## Final Radix count

Not yet measured. Source of truth at any point:
`rg -l 'radix-ui' src/renderer/src/components/ui`.

## Outstanding behavior deltas

None recorded yet.

## Full validation evidence (Milestone 5)

Pending — deferred slow gates, packaged CDP walkthrough, screenshots.
