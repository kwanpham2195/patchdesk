# dialog

2026-07-19, golden pair via CLI (`shadcn add dialog --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/dialog.tsx`: regenerated from base-nova, wrapping `@base-ui/react/dialog`. Radix Overlay/Content become Base `Backdrop`/`Popup`; open/closed animation uses `data-open`/`data-closed` instead of `data-[state=...]`. The nova source keeps Patchdesk's existing `showCloseButton` props on both `DialogContent` and `DialogFooter`, and the close controls now compose Button via Base UI's `render` prop instead of Radix `asChild`.
- `src/renderer/src/components/ui/button.tsx`: re-applied the `data-variant`/`data-size` adapter after the dialog regeneration overwrote button.tsx with registry source (the CLI updates shared deps of a component). Same justification as `.migration/button.md` (`.review-density-compact` rule in `styles.css:191`).
- `src/renderer/src/app.tsx:1181`: the workspace-profile dialog's Radix `onOpenAutoFocus`/`onCloseAutoFocus` manual-focus workaround is replaced with Base UI's declarative `initialFocus={keepProfileButton}` / `finalFocus={previewTrigger}` on `DialogContent` (Base UI Popup accepts `RefObject<HTMLElement | null>`; see `node_modules/@base-ui/react/dialog/popup/DialogPopup.d.ts:24,34`).
- `src/renderer/src/components/ui/command.tsx`: `CommandDialog`'s close control converted from `<DialogClose asChild><Button>` to `<DialogClose render={<Button/>}>`; `CommandDialog` props now Omit the Base UI Root `children` union (which includes a payload render function) and re-declare `children?: React.ReactNode`.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/dialog.tsx` -> no matches.

## Left alone

- `maintainer-inbox.tsx` dialogs (rename view, scope preview) use plain `Dialog`/`DialogContent`/`DialogFooter`; no changes needed.
- Command palette surface classes in `app-shell.tsx` untouched; palette simplification is planned after the overlay families stabilize (the stock composition it targets now exists).

## Behavior changes

- Backdrop is now `bg-black/10` with backdrop blur (nova default) instead of `bg-black/50`; popup is `bg-popover` with `ring-1` and faster (100ms) transitions. Visual, intended by the reset.
- Focus management: the profile dialog now relies on Base UI's focus-trap `initialFocus`/`finalFocus` instead of imperative `event.preventDefault()` + `.focus()`. Behavior should be identical (focus lands on "Keep current profile", returns to the invoking control); flagged for the Milestone 5 CDP walkthrough of the profile-switch flow.

## Verify by hand

- Open the workspace-profile dialog (dashboard PR preview with a different suggested profile): "Keep current profile" is focused on open; Escape and both buttons close it; focus returns to the control that opened it.
- Command palette: ⌘K opens, the input is focused, the close control in the input row dismisses, Escape/backdrop dismiss, focus returns to the Navigate button.
- Rename-view and scope-preview dialogs in the inbox open/close normally.
