# badge

2026-07-19, golden pair via CLI (`shadcn add badge --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/badge.tsx`: regenerated from base-nova. Now uses Base UI `useRender` + `mergeProps` with `render` prop instead of Radix `Slot`/`asChild`. `useRender` `state: { slot: "badge", variant }` keeps emitting `data-slot="badge"` and `data-variant`, so the forced-colors rules in `styles.css:295-305` and the `.review-density-compact` badge rule keep working with no adapter. Variants unchanged in name (`default`, `secondary`, `destructive`, `outline`, `ghost`, `link`).
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/badge.tsx` -> no matches.

## Left alone

- All Badge consumers (`review-workbench`, `review-draft-sheet`, `merge-confirmation-dialog`, `safe-run-panel`, `review-submission-dialog`, `maintainer-inbox`, `sidebar`) use plain `<Badge variant=...>`; none use `asChild`, so no call-site changes.
- `styles.css` badge rules untouched.

## Behavior changes

- Visual only, intended by the reset: fixed `h-5` height, `rounded-4xl`, muted/destructive color treatment differs from new-york.

## Verify by hand

- Badges in the inbox PR rows and review workbench read at their intended size and do not wrap.
- With forced colors enabled, badges keep the High Contrast treatment (border/background rules in `styles.css`).
