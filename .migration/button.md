# button

2026-07-19, golden pair via CLI (`shadcn add button --overwrite`, style `base-nova`). Migrated; compiles and all 216 unit tests pass.

## Changed

- `components.json`: `style` flipped `new-york` -> `base-nova` (whole-project mode). `shadcn init --preset nova` refused to run ("could not detect a supported framework" in the electron-vite layout), so the flip was done by editing the style field; `shadcn add` resolves the base-nova registry from it. The nova theme tokens were NOT applied to `styles.css`; existing Patchdesk tokens stay.
- `package.json` / `pnpm-lock.yaml`: added `@base-ui/react@1.6.0`. `radix-ui` remains installed.
- `eslint.config.js`: disabled `react-refresh/only-export-components` for `src/renderer/src/components/ui/**` because base-nova wrappers export cva variant factories (e.g. `buttonVariants`) next to components and the repo lints with `--max-warnings=0`.
- `src/renderer/src/components/ui/button.tsx`: regenerated from base-nova. Now wraps the real `@base-ui/react/button` primitive (`ButtonPrimitive.Props`, `render` prop instead of `asChild`). Kept one product adapter: `data-variant`/`data-size` attributes, because `.review-density-compact` in `styles.css:191` selects `[data-slot="button"]:not([data-size="icon"]):not([data-size="icon-lg"])`. All legacy sizes (`xs`, `icon-xs`, `icon-sm`, `icon-lg`) exist in nova, so no consumer variant mapping was needed.
- `src/renderer/src/components/ui/alert-dialog.tsx:146-177`: compat fix only (full migration is Milestone 2). `AlertDialogAction`/`AlertDialogCancel` composed `Button` via `asChild`; they now apply `buttonVariants({ variant, size })` directly to the still-Radix `AlertDialogPrimitive.Action/Cancel`, matching current shadcn alert-dialog shape.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/button.tsx` -> no matches.

## Left alone

- No consumer files needed changes: no app code uses `<Button asChild>`; all `asChild` usage is on Trigger components owned by later families (dropdown-menu, sheet, tooltip, alert-dialog).
- `styles.css` untouched; the nova preset theme was not applied (see above) because the CLI cannot init in this layout and the plan's visual reset is at component-surface level, not token level.

## Behavior changes

- Base UI `ButtonPrimitive` adds `active:not-aria-[haspopup]:translate-y-px` press feedback and nova focus ring (`ring-3`) styling; visual only, intended by the reset.
- Buttons that are triggers for Radix popups no longer receive Radix's `asChild` slot merging from Button itself; Trigger `asChild` composition still works because that lives on the Radix Trigger side (unchanged until those families migrate).

## Verify by hand

- Inbox header buttons (Refresh, filters) render at sm/xs sizes; compact review density still shrinks non-icon buttons to 12px.
- Keyboard focus on any button shows the nova ring; activating with Enter/Space fires the action.
- Disabled buttons (e.g. pending submit) ignore pointer and keyboard activation.
