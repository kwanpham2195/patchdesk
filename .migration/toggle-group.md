# toggle-group

2026-07-19, golden pair via CLI (`shadcn add toggle-group --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/toggle-group.tsx`: regenerated from base-nova, wrapping `@base-ui/react/toggle-group` and sourcing item variants from the new `toggle.tsx` (`toggleVariants`).
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/toggle-group.tsx` -> no matches.

## Left alone

- No consumers outside the ui directory import toggle-group; nothing to adapt.

## Behavior changes

- None expected; no consumers exercise toggle groups today.

## Verify by hand

- If a toggle group is introduced later: arrow keys move between items, selection follows the group's `multiple` setting.
