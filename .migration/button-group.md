# button-group

2026-07-19, golden pair via CLI (`shadcn add button-group --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/button-group.tsx`: regenerated from base-nova. `ButtonGroupText` now uses Base UI `useRender` with a `render` prop instead of Radix `Slot`/`asChild`; `ButtonGroupSeparator` composes the migrated Base UI `Separator`.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/button-group.tsx` -> no matches. The CLI also verified `separator.tsx` is already identical to registry source and skipped it.

## Left alone

- Sole consumer `review-diff-view.tsx:414-453` uses only `<ButtonGroup className>` with orientation defaults; no `ButtonGroupText`/`asChild` usage, so no call-site changes.

## Behavior changes

- None expected; the wrapper is a layout group. Visual radius/gap treatment follows nova source. Intended.

## Verify by hand

- In the diff view toolbar, grouped controls render as one joined unit with correct outer rounding and no double borders.
