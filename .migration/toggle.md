# toggle

2026-07-19, golden pair via CLI (`shadcn add toggle --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/toggle.tsx`: regenerated from base-nova, wrapping `@base-ui/react/toggle`. Pressed styling keys off Base UI's `aria-pressed` (the registry's leftover `data-[state=on]` selector is stock source, kept verbatim).
- `src/renderer/src/components/ui/toggle-variants.ts`: deleted. The base-nova toggle exports its own `toggleVariants` and nothing else imported the old file.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/toggle.tsx` -> no matches.

## Left alone

- No product consumers: only `toggle-group.tsx` referenced toggle internals, and it was regenerated in the same batch.

## Behavior changes

- None expected; no consumers exercise toggles today.

## Verify by hand

- If a toggle is introduced later: Space/Enter toggles pressed state, `aria-pressed` styling shows, disabled state blocks interaction.
