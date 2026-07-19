# command

2026-07-19, golden pair via CLI (`shadcn add command --overwrite`, style `base-nova`). cmdk stays cmdk — only the local composition changed. Typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/command.tsx`: regenerated from base-nova. `CommandInput` is now the stock inset composition (`InputGroup` + search addon, no close control inside the field), `CommandList` carries the stock bounded `max-h-72` scroll, and `CommandDialog` renders children directly (no hard-coded cmdk className hack; `showCloseButton` defaults to false).
- `src/renderer/src/components/app-shell.tsx:295`: palette rebuilt on the stock composition: `<CommandDialog>` (no custom surface classes, no `showCloseButton`) wrapping `<Command>` + `CommandInput` + `CommandList` + groups. Kept only product behavior: route filtering, protected-navigation guard (`commandOpen && !navigationBlocked`), keyboard selection, the bounded scroll list, and the keyboard-hint footer (kept outside the scroll list with `shrink-0` so it never obscures options). Removed: the custom close icon inside the input and the legacy surface classes, per the plan — note this intentionally undoes the in-input close button added in `384a237`, which the plan explicitly calls out (`Do not retain a custom close icon inside the input`).
- Registry dependency drift accepted with the batch: `input-group.tsx` and `textarea.tsx` regenerated to nova source (visual classes only; no API change, consumers unaffected).
- Leftover scan: command.tsx is cmdk, not Radix; `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/command.tsx` -> no matches.

## Left alone

- cmdk filtering/keyboard internals — untouched by design.
- Palette routes, inbox commands, and the protected-navigation guard logic in `app-shell.tsx`.

## Behavior changes

- Dialog now sits at `top-1/3` (nova default) instead of centered; palette width follows the stock `sm:max-w-sm` content sizing instead of `max-w-md`.
- No close button anywhere in the palette now: dismissal is Escape, backdrop click, or selecting an item. Flagging explicitly since the removed in-input X was deliberate pre-migration work.

## Verify by hand

- ⌘K opens with the input focused; typing filters routes; ↑↓ moves; ↵ opens; Escape and backdrop click dismiss; focus returns to the Navigate button.
- With a short viewport, the list scrolls and the hint footer never overlaps options (covered by `tests/browser/accessibility.spec.ts` quick-navigation test, deferred to Milestone 5).
