# tabs

2026-07-19, golden pair via CLI (`shadcn add tabs --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/tabs.tsx`: regenerated from base-nova, wrapping `@base-ui/react/tabs`. State classes use Base UI `data-selected`/`data-horizontal`/`data-vertical`; orientation data attribute kept as `data-orientation` on Root by the wrapper itself. Adds the nova `line` list variant via `tabsListVariants`.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/tabs.tsx` -> no matches.

## Left alone

- Consumers (`review-workbench.tsx:338-487`, `diff-workbench.tsx:78+`) use only `defaultValue`, controlled `value`/`onValueChange`, `disabled` triggers, and classNames — all compatible with Base UI's `onValueChange(value, eventDetails)` signature (extra arg ignored by existing callbacks).

## Behavior changes

- Arrow-key navigation between tabs now follows Base UI defaults (activation on focus is on, matching Radix's `activationMode="automatic"`, so no product delta expected). Flagged for manual verification per plan.
- Visual: nova list treatment (muted pill container, `rounded-lg`) replaces new-york styling. Intended.

## Verify by hand

- In the review workbench: Files/Findings tabs switch on click and on Left/Right arrows; the disabled "Updates" tab cannot be activated; the controlled Full PR/Updates switch still tracks `diffSurface` state.
