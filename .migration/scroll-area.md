# scroll-area

2026-07-19, golden pair via CLI (`shadcn add scroll-area --overwrite`, style `base-nova`). Migrated; typecheck, lint, full unit suite (216), and the two consumer suites (maintainer-inbox, review-workbench) pass.

## Changed

- `src/renderer/src/components/ui/scroll-area.tsx`: regenerated from base-nova, now wrapping `@base-ui/react/scroll-area`. Removed one unused `import * as React` line the registry source carried (repo lints with `--max-warnings=0` / `noUnusedLocals`).
- Leftover scan clean: `rg -n 'radix-ui|@radix-ui|IconPlaceholder' src/renderer/src/components/ui/scroll-area.tsx` -> no matches.

## Left alone

- Consumers (`review-workbench.tsx:532`, `maintainer-inbox.tsx:280,282`) use only `<ScrollArea className>`; no viewport/scrollbar refs or Radix-only props, so no call-site changes. `ScrollBar` is not imported anywhere outside the wrapper.

## Behavior changes

- Scrollbar appearance/interaction follows Base UI (thumb shows on hover/scroll per nova source) rather than Radix's always-mounted scrollbar. Visual only.

## Verify by hand

- Inbox queue rail and inspector columns scroll independently at 1280px min width; the review file list keeps its own scroll region and the scroll thumb appears while scrolling.
