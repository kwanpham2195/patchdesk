# label

2026-07-19, golden pair via CLI (`shadcn add label --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/label.tsx`: regenerated from base-nova. Base UI has no Label primitive, so the wrapper is now a native `<label>` element (matching the migration rule: Label -> native `<label>`). Same class list as before; props type widened from Radix `LabelPrimitive.Root` to `React.ComponentProps<"label">`.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/label.tsx` -> no matches.

## Left alone

- Consumers (`maintainer-inbox`, `diff-workbench`, `merge-confirmation-dialog`, ui `field`) use plain `htmlFor`/`className`; unchanged. Native `htmlFor` focus behavior is identical to Radix Label's.

## Behavior changes

- None.

## Verify by hand

- Clicking a settings/filter label focuses its associated control.
