# item

2026-07-19, golden pair via CLI (`shadcn add item --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/item.tsx`: regenerated from base-nova. `Item` now uses Base UI `useRender` with a `render` prop instead of Radix `Slot`/`asChild`.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/item.tsx` -> no matches.

## Left alone

- Sole consumer `safe-run-panel.tsx:94-107` composes `Item`, `ItemContent`, `ItemTitle`, `ItemActions` with plain classNames; no `asChild`, so no call-site changes.

## Behavior changes

- None expected. Visual density follows nova source. Intended.

## Verify by hand

- The run-status panel in the review workbench renders title, description, and actions in the same row layout.
