# dropdown-menu

2026-07-19, golden pair via CLI (`shadcn add dropdown-menu --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/dropdown-menu.tsx`: regenerated from base-nova, wrapping `@base-ui/react/menu` (`Portal > Positioner > Popup`, `data-open`/`data-closed`, no `--radix-*` variables; checkbox items use Base UI `Menu.CheckboxItem` with right-side indicator).
- `src/renderer/src/components/review-diff-view.tsx`: Trigger converted `<DropdownMenuTrigger asChild><Button>` -> `render={<Button/>}`. Menu body restructured into `<DropdownMenuGroup>`s around the label and each checkbox-item section: Base UI `Menu.GroupLabel` throws "MenuGroupContext is missing" when a label renders outside `Menu.Group` (Radix allowed free-floating labels). Separators kept between groups.
- `tests/setup.ts`: added an `Element.prototype.getAnimations = () => []` stub — Base UI scroll-area calls `viewport.getAnimations()` (jsdom lacks it), producing unhandled errors that could flake tests.
- `tests/renderer/review-workbench.ui.test.tsx:135`: `getByRole("menuitemcheckbox", ...)` -> `await findByRole(...)`. Base UI menu opens asynchronously (floating-ui applies open state a tick after the click finishes, unlike Radix's synchronous open); the assertion target is unchanged.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder|--radix' src/renderer/src/components/ui/dropdown-menu.tsx` -> no matches.

## Left alone

- `DropdownMenuCheckboxItem` callbacks: Base UI `onCheckedChange(checked: boolean, eventDetails)` is boolean-only; existing `checked === true` guards compile and behave the same.

## Behavior changes

- Menu open is async relative to the trigger click (a frame, not user-visible).
- Base UI menu item activation: clicking a checkbox item toggles AND closes the menu by default (Radix checkbox items also closed unless `onSelect` was prevented — same default here, no consumer used `preventDefault` on select).
- Keyboard/typeahead semantics come from Base UI Menu (roving focus, typeahead on items). Flagged for the Milestone 5 walkthrough of the diff Options menu.

## Verify by hand

- Diff view Options menu: opens below-right of the trigger, all four toggles work (compact density, unchanged lines, wrap, accessible view), separators render between groups, Escape closes and returns focus to the Options button, arrow keys + typeahead move between items.
