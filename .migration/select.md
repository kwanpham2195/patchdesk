# select

2026-07-19, golden pair via CLI (`shadcn add select --overwrite`, style `base-nova`). Migrated; typecheck, lint, and 3 consecutive full unit runs (216 tests each) pass.

## Changed

- `src/renderer/src/components/ui/select.tsx`: regenerated from base-nova, wrapping `@base-ui/react/select` (`Portal > Positioner > Popup`, Base UI item/value parts, no `--radix-*` variables).
- `src/renderer/src/app.tsx:2186`: profile picker `onValueChange={onSelectProfile}` -> guarded callback. Base UI Select's change handler passes `string | null` (null when the value clears); the wrapper's `(id: string) => void` now only fires for non-null values. Other select consumers already used inline arrow callbacks and compiled unchanged.
- `src/renderer/src/components/ui/input.tsx`: registry dependency drift pulled in with the batch — the wrapper now composes `@base-ui/react/input` with nova classes (was a plain `<input>`). No Radix involvement; no consumer changes needed.
- `src/renderer/src/components/ui/button.tsx`: re-applied the `data-variant`/`data-size` adapter after the CLI overwrote button.tsx again (select depends on button). This is the third clobber; the adapter is re-applied after every CLI run that touches button.tsx.
- `tests/renderer/review-submission-dialog.ui.test.tsx:40`: `getByRole("option", ...)` -> `await findByRole("option", ...)`. Base UI Select mounts its listbox asynchronously after the trigger click (same floating-ui tick as dropdown-menu); the sync query flaked ~50% of full-suite runs while passing solo. Three consecutive full runs now green. Assertion target unchanged.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder|--radix' src/renderer/src/components/ui/select.tsx` -> no matches.

## Left alone

- Consumers `maintainer-inbox.tsx:250` (sort select), `merge-confirmation-dialog.tsx:46` (merge method), `review-submission-dialog.tsx:250` (review event): controlled `value`/`onValueChange` shapes are compatible; no source changes.
- Unstaged working-tree changes to `.gitignore` and `AGENTS.md` observed during this family (not mine, assumed another agent/tool); intentionally excluded from the commit.

## Behavior changes

- Select popup opens async relative to trigger click (a frame, not user-visible) — same behavior note as dropdown-menu.
- Trigger sizing: nova keeps the `size="sm"` prop on the trigger; inbox sort select keeps its compact sizing classes.
- Base UI select closes on item selection and supports typeahead; keyboard semantics flagged for the Milestone 5 walkthrough.

## Verify by hand

- Inbox sort select: opens below the trigger, typeahead jumps to "Last updated", selection applies, focus returns to the trigger on Escape.
- Merge dialog method select and submit-dialog event select: selection updates the confirm action's payload (merge test covers squash default).
