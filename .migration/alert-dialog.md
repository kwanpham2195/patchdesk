# alert-dialog

2026-07-19, golden pair via CLI (`shadcn add alert-dialog --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/alert-dialog.tsx`: regenerated from base-nova, wrapping `@base-ui/react/alert-dialog` (Backdrop/Popup, `data-open`/`data-closed` animations). Key API change: `AlertDialogAction` is now a plain `Button` (no built-in close), and `AlertDialogCancel` is `AlertDialogPrimitive.Close` with `render={<Button variant="outline" />}`. Adds `AlertDialogMedia` and `size` variants (stock).
- `src/renderer/src/components/merge-confirmation-dialog.tsx:48`: `<AlertDialogTrigger asChild><Button>` -> `<AlertDialogTrigger render={<Button/>}>`. Removed the dead `event.preventDefault()` in the confirm onClick — it existed to suppress Radix Action's default close; Base UI Action has no default close, and this dialog already closes explicitly via `setOpen(false)` after `onMerge` resolves.
- `src/renderer/src/components/review-submission-dialog.tsx:146,234`: same Trigger `asChild` -> `render` conversion (both create and submit dialogs); removed dead `preventDefault()` in both Action onClicks (lines 215, 295).
- `src/renderer/src/app.tsx:2503`: removed dead `preventDefault()` in the remove-repository confirmation Action.
- `src/renderer/src/components/ui/button.tsx`: re-applied the `data-variant`/`data-size` adapter after the CLI overwrote button.tsx again (alert-dialog depends on button).
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/alert-dialog.tsx` -> no matches.

## Left alone

- All three write-confirmation flows (merge, create pending review, submit pending review) keep their pending guards: `onOpenChange` ignores close attempts while `pending`, Cancel is `disabled` while pending, and Action requires the acknowledgement checkbox. Unchanged and covered by unit tests.
- `maintainer-inbox.tsx:307` delete-view Action (`onClick={removeSavedView}`) never used `preventDefault`; works as-is.

## Behavior changes

- Base UI `AlertDialogAction` does NOT close the dialog on click (Radix did by default). All Patchdesk Actions manage `open` state explicitly, so this is a semantic match, not a regression — but any future Action must close the dialog itself.
- Backdrop/animation follow nova (lighter backdrop, 100ms zoom-fade). Visual, intended.

## Verify by hand

- Merge confirmation: open via "Prepare merge confirmation", confirm stays disabled until the warning acknowledgement, Cancel/Escape close while idle and do nothing while "Merging…" is pending, and the dialog closes only after GitHub returns.
- Submit-review confirmation: same pending guard; the "Confirm pending review"/"Submit review" buttons keep the dialog open during the write.
- Remove-repository and delete-view confirmations cancel cleanly.
