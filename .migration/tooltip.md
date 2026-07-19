# tooltip

2026-07-19, golden pair via CLI (`shadcn add tooltip --overwrite`, style `base-nova`). Migrated; typecheck, lint, and all 216 unit tests pass.

## Changed

- `src/renderer/src/components/ui/tooltip.tsx`: regenerated from base-nova, wrapping `@base-ui/react/tooltip`. Positioned content becomes `Portal > Positioner > Popup` with `side`/`sideOffset`/`align`/`alignOffset` forwarded to the Positioner; includes the nova Arrow; animations key off `data-open`/`data-closed`/`data-[state=delayed-open]`. No `--radix-*` CSS variables remain.
- `src/renderer/src/components/app-shell.tsx:200`: Navigate button tooltip converted from `<TooltipTrigger asChild><Button>` to `<TooltipTrigger render={<Button/>}>`.
- `src/renderer/src/components/ui/sidebar.tsx:131,537` (compat fixes only; full sidebar migration is Milestone 4): `TooltipProvider delayDuration={0}` -> `delay={0}` (Base UI prop rename); `SidebarMenuButton`'s `<TooltipTrigger asChild>{button}</TooltipTrigger>` -> `<TooltipTrigger render={button} />`.
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder|--radix' src/renderer/src/components/ui/tooltip.tsx` -> no matches.

## Left alone

- `app.tsx` `<TooltipProvider>` with no props (defaults fine, `delay` defaults to 0 in the wrapper).

## Behavior changes

- Tooltip delay prop renamed (`delayDuration` -> `delay`); values unchanged (0 in sidebar, default elsewhere).
- Popup styling follows nova (foreground/inverted scheme with arrow). Visual, intended.
- Base UI tooltip delays/grouping semantics differ slightly from Radix (provider-level delay groups tooltips); only one tooltip is ever visible in Patchdesk flows, so no product delta expected. Flag for the Milestone 5 walkthrough.

## Verify by hand

- Hover the Navigate button: tooltip appears immediately, arrow points at the trigger, and it disappears on mouse leave/Escape.
- Collapsed sidebar rail buttons show their label tooltips on hover with no delay (sidebar family verify, Milestone 4).
