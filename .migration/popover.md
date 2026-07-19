# popover

2026-07-19, golden pair via CLI (`shadcn add popover --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/popover.tsx`: regenerated from base-nova, wrapping `@base-ui/react/popover` (`Portal > Positioner > Popup`, `data-open`/`data-closed` animations, no `--radix-*` variables).
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder|--radix' src/renderer/src/components/ui/popover.tsx` -> no matches.

## Left alone

- Nothing imports this wrapper outside the ui directory today; no consumers to adapt.

## Behavior changes

- None observable (no consumers).

## Verify by hand

- If a popover is introduced later: trigger toggles, Escape/outside-click dismisses, arrow keys stay out of the popup unless it contains focusable content.
