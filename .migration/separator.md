# separator

2026-07-19, golden pair via CLI (`shadcn add separator --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/separator.tsx`: regenerated from base-nova. Now wraps `@base-ui/react/separator`. Radix's `decorative` prop is gone (Base UI separators are always presentational); no consumer passed it, so nothing was ported. Orientation styling uses Base UI's `data-horizontal`/`data-vertical` attributes instead of `data-[orientation=...]`.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/separator.tsx` -> no matches.

## Left alone

- Consumers (`review-workbench`, `app-shell`, `maintainer-inbox`, and ui wrappers `button-group`, `item`, `field`, `sidebar`) only pass `orientation`/`className`; unchanged.

## Behavior changes

- None expected. `role="separator"` semantics come from the Base UI primitive; visual orientation attributes renamed but the generated classes handle them.

## Verify by hand

- Horizontal separators in the inbox and review workbench render a 1px line; vertical separators in button groups keep full height.
