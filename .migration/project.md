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

Done: `@base-ui/react@1.6.0` is the primitive runtime and `components.json`
uses `base-nova` (the CLI cannot detect the electron-vite framework, so the
initial style flip was manual; `shadcn add` resolved the Base Nova registry
from it). `radix-ui` was removed at Milestone 5 and the frozen lockfile
installed cleanly.

## Wrapper/consumer sweep summary

Complete (2026-07-19). Migrated: button, badge, separator, label, checkbox,
scroll-area, tabs, toggle, toggle-group, button-group, item, dialog,
alert-dialog, sheet, command composition, tooltip, popover, dropdown-menu,
select, and sidebar. Deleted `toggle-variants.ts` (superseded by Base Nova
toggle exports). Test adaptations: PointerEvent polyfill in `tests/setup.ts`
(Base UI checkbox re-dispatches clicks as PointerEvent), role-based checkbox
queries for stock Base controls, Base Select `items` for selected-label
rendering, and direct command-trigger opening for the scroll-layout test while
the independent keyboard command test remains in place.

## Final Radix count

Zero Radix wrappers remain and the direct `radix-ui` package is absent from
`package.json`. Verified owned source with:

```bash
rg -n 'radix-ui|@radix-ui|--radix-' src/renderer/src package.json
```

The command produced no matches after `pnpm remove radix-ui` and
`pnpm install --frozen-lockfile`. `pnpm why @radix-ui/react-dialog` identifies
`cmdk@1.1.1` as the intentional transitive source of remaining lockfile
`@radix-ui/*` packages; cmdk was explicitly left outside this migration.

## Outstanding behavior deltas

The review-diff screenshot region is one pixel shorter after the Base UI shell
conversion. Pierre unified and split visual-language assertions passed after
the approved screenshot baseline refresh; Pierre colors, code font, and line
spacing remain unchanged.

## Full validation evidence (Milestone 5)

Passed on 2026-07-19:

| Command | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test -- --run` | pass (42 files, 216 tests) |
| `pnpm build` | pass |
| `pnpm exec playwright test` | pass (30 tests, 5 workers) |
| `pnpm package:mac` | pass |
| `pnpm test:package-smoke` | pass (packaged fixture workbench loaded) |

Packaged Electron CDP validation used `release/mac-arm64/Patchdesk.app` on
port 9234 with a separate temporary user-data directory. Inbox, Settings,
command palette, application-rail collapse, and queue-rail collapse/restore
were exercised. `agent-browser errors` and `console` returned no entries, and
the 1280×800 app viewport reported zero horizontal overflow. No GitHub write
confirmation was opened. Evidence screenshots:

- `/tmp/patchdesk-base-ui-1920x1080.png`
- `/tmp/patchdesk-base-ui-1280x800.png`
