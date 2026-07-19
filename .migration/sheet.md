# sheet

2026-07-19, golden pair via CLI (`shadcn add sheet --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/sheet.tsx`: regenerated from base-nova. Base UI has no Sheet, so the registry composes `@base-ui/react/dialog` with side-specific classes (`data-[side=left|right|top|bottom]`, `data-starting-style`/`data-ending-style` transitions instead of Radix `data-[state]` keyframes). Keeps the `side` prop and adds stock `showCloseButton`.
- `src/renderer/src/components/review-draft-sheet.tsx:119`, `diff-workbench.tsx:135,208`, `review-workbench.tsx:453`: `<SheetTrigger asChild><Button>` -> `<SheetTrigger render={<Button/>}>` (4 call sites).
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/sheet.tsx` -> no matches.

## Left alone

- `sidebar.tsx`'s internal Sheet usage migrates with the sidebar family (Milestone 4); it compiles against the new wrapper unchanged.
- Sheet content className overrides (`w-full sm:max-w-xl` on the draft sheet, `side="left"` navigation sheets) are product layout classes and stay.

## Behavior changes

- IMPORTANT transient finding (now resolved): while sheet was still Radix, the dashboard guarded-navigation test failed because Radix's scroll lock sets `body { pointer-events: none }` and only Radix portals opt back in — a Base UI dialog opened above an open Radix sheet was unclickable. Migrating sheet removed the mixed-state; full suite green. This is the class of issue the plan's per-family ordering could not avoid; it is documented so similar mixed overlay stacks during Milestones 3-4 get the same scrutiny.
- Base UI sheet traps focus and closes on Escape/backdrop like Radix; transition feel differs (200ms translate + opacity). Visual, intended.

## Verify by hand

- Review draft sheet: opens from "Edit review draft", traps focus, closes via the X, Escape, and backdrop; dirty-state guard still fires if you try to navigate with unsaved edits (the dashboard flow above).
- Narrow viewport (<1100px): "Files and findings" (left) and "Review context" (right) sheets slide from the correct side and return focus to their triggers.
