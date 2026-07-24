# sidebar

2026-07-19, current Base Nova wrapper shape applied manually after reviewing `shadcn add sidebar --dry-run` and its component diff. Migrated; typecheck passes.

## Changed

- `src/renderer/src/components/ui/sidebar.tsx`: replaced `radix-ui` `Slot` polymorphism with Base UI `useRender` and `mergeProps` for `SidebarGroupLabel`, `SidebarGroupAction`, `SidebarMenuButton`, `SidebarMenuAction`, and `SidebarMenuSubButton`.
- `src/renderer/src/components/ui/sidebar.tsx`: moved the generated Base data-state contract onto the rendering state (`data-active`, `data-open`, `data-size`) and removed the empty local `TooltipProvider`; tooltips continue to use the already-migrated local tooltip wrapper.
- Kept Patchdesk's fixed rail layout and mobile Sheet integration unchanged. `rg -n 'radix-ui|@radix-ui|Slot|asChild' src/renderer/src/components/ui/sidebar.tsx` has no matches.

## Left alone

- `cmdk`, Pierre, Sonner, Vaul, input-otp, react-day-picker, and Recharts remain outside the Radix primitive migration.
- App-shell rail widths, routing state, and the mobile Sheet behavior remain product-level layout behavior rather than Sidebar primitive styling.

## Behavior changes

- `render` replaces the public `asChild` prop for Sidebar's polymorphic exports. No renderer consumer used Sidebar's former `asChild` contract.
- Base UI data attributes replace Radix-shaped `data-[active=true]` and `data-[state=open]` hooks. Collapse, active-route, and tooltip behavior require packaged-app verification.

## Verify by hand

- On desktop, collapse and restore the application rail and confirm the 232px / 48px widths remain intact.
- Navigate through Inbox, Drafts, History, and Settings by pointer and keyboard; active state and collapsed-rail tooltips should remain visible.
- At a narrow desktop/mobile width, open and close the application sidebar Sheet and verify focus returns to its trigger.
