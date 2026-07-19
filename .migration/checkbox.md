# checkbox

2026-07-19, golden pair via CLI (`shadcn add checkbox --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass after two test-environment adaptations described below.

## Changed

- `src/renderer/src/components/ui/checkbox.tsx`: regenerated from base-nova. Now wraps `@base-ui/react/checkbox` Root + Indicator. Checked styling uses Base UI's `data-checked`/`data-unchecked` attributes instead of Radix `data-[state=checked]`. Base UI `onCheckedChange(checked: boolean, eventDetails)` is boolean-only; all three consumers guarded with `checked === true`, which still typechecks and behaves identically since none use `indeterminate`.
- `tests/setup.ts`: added a `PointerEvent` polyfill (MouseEvent subclass). jsdom has no `PointerEvent` constructor, and Base UI Checkbox Root's span `onClick` re-dispatches the click to its hidden input as `new PointerEvent("click")` (`node_modules/@base-ui/react/checkbox/root/CheckboxRoot.js:313`). Without the polyfill the dispatch throws inside Base UI and clicks on the visible checkbox silently no-op in tests only. Chromium (the real Electron surface) has PointerEvent natively.
- `tests/renderer/merge-confirmation-dialog.ui.test.tsx:16` and `tests/renderer/review-submission-dialog.ui.test.tsx:32,42,58,77`: `getByLabelText(...)` -> `getByRole("checkbox", { name: ... })` for the acknowledgement checkboxes. Base UI renders BOTH a `role="checkbox"` span (named via `aria-labelledby`) and a hidden `<input type="checkbox">` (named via the consumer's `<Label htmlFor>`), so a label query matches two elements. The role query asserts the same named interactive control; no expectation was loosened.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/checkbox.tsx` -> no matches.

## Left alone

- Consumers (`review-draft-sheet`, `review-submission-dialog`, `merge-confirmation-dialog`): no source changes needed; the `id`/`htmlFor` label pairing still works (Base UI auto-links the external label to the span via `aria-labelledby`).

## Behavior changes

- The acknowledgement checkbox's accessible structure changed: the interactive element is now a `role="checkbox"` span backed by a hidden input, instead of Radix's single `<button role="checkbox">`. Screen-reader behavior is equivalent (span is labelled, input is `aria-hidden`).
- Base UI Root spans render an `after:` hit-area expansion (`after:-inset-x-3 after:-inset-y-2`), enlarging the click target around the 16px box. Intended by the nova source.

## Verify by hand

- In the submit-review and merge dialogs: the confirm action stays disabled until the acknowledgement checkbox is toggled, and toggling via click and via Space both work.
- Tab order: the checkbox is reachable once, focus ring visible (the hidden input is correctly skipped).
