# Patchdesk Design — fix design-parity defects

## Context

A live visual QA pass against the running Design dev server (`pnpm dev:design`,
`http://localhost:5173/`) found that the Design app diverges from the real
renderer in two visible ways and one functional way. They all show up the
moment a designer opens a scenario URL.

1. **Desktop grid is missing.** At 1440×900 the inbox/workbench/settings
   surfaces render a single 673-px column with the right ~660 px empty, and the
   watchlist appears to "overlap" the main column. Root cause: Tailwind v4 is
   not generating the `min-[1280px]:*` utility classes for the Design build.
   The production renderer CSS contains 28 `1280px` rules in 5 499 lines; the
   Design build CSS contains 0 in 1 line. The classes exist in the JSX (23
   occurrences across `maintainer-inbox.tsx` and
   `completed-review-workbench.tsx`) but the Design Vite config's
   `root: src/design/` prevents Tailwind from scanning
   `src/renderer/src/**/*.{ts,tsx}` for them.

2. **Dialog scenarios show only the trigger, not the body.**
   `?scenario=dialog-submit` and `?scenario=dialog-merge` open to a small
   button on a mostly-black viewport. The reviewer has to click the trigger
   to see the dialog content. Root cause: both `MergeConfirmationDialog`
   (`useState(false)`) and `ReviewSubmissionDialog` initialize their
   `AlertDialog` `open` state to `false`. The Design scenario renders them
   directly with no parent context, so the body never appears.

3. **Inbox-default shows 4 of 6 PRs.** The default "My inbox" filter matches
   rows whose categories include `needs_review`, `updated_since_review`,
   `saved_review`, or `running`. The mock data has six PRs but #31
   (`waiting_for_author`, `draft`) and #8 (`ready_to_merge`) do not match
   any of those categories, so the default scenario displays four rows
   while the "All open 6" counter advertises six. The Design
   `main.tsx` clears `patchdesk.*` localStorage on every load, so the
   default view always wins.

## Approach

Fix each defect at the smallest scope that closes the parity gap, keep the
production renderer untouched, and re-verify with the same agent-browser
recipe the tester just used.

### 1. Restore Tailwind utilities in the Design build

Add an explicit `@source` directive to `src/renderer/src/styles.css` that
covers the renderer source directory. Tailwind v4 picks up `@source` paths
even when the Vite root is elsewhere, so the Design build will start
generating the `min-[1280px]:*` classes alongside the production build.

```css
@import "tailwindcss";
@source "../renderer/src/**/*.{ts,tsx}";
```

Expected ripple: the 1-line Design build CSS grows back to ~5 000 lines and
includes the grid rules. No JSX changes, no production impact.

### 2. Make Design dialog scenarios default-open

Extend both dialog components with a `defaultOpen` prop that, when `true`,
initializes the inner `open` state to `true`. The prop is opt-in, so
existing call sites in the workbench keep their current collapsed-then-
opened behavior. Update `src/design/design-app.tsx` to pass
`defaultOpen` on the two scenario renders.

This is a small additive API: no behavior change in the production
renderer, and the Design scenarios render the dialog body on first paint.

### 3. Show all 6 PRs in inbox-default

In `src/design/main.tsx`, after the localStorage clear, seed the inbox view
preference key for the `cfw` profile with `view: "all_open"` when the
scenario is `inbox-default`. This widens the visible set from 4 to 6
without changing the production default of "my_inbox".

The seed is one `localStorage.setItem` call with a JSON object matching
`InboxViewPreferences` shape (version + view). Other inbox scenarios
(loading/empty/error/cached) keep the default filter so their assertions
remain meaningful.

## Files to modify

- `src/renderer/src/styles.css` — add `@source` directive for renderer source.
- `src/renderer/src/components/merge-confirmation-dialog.tsx` — add
  `defaultOpen?: boolean` prop, wire into `useState(false)` initializer.
- `src/renderer/src/components/review-submission-dialog.tsx` — same additive
  prop, applied to both `createOpen` and `submitOpen` initial states.
- `src/design/main.tsx` — seed the inbox view preference for the
  `inbox-default` scenario.
- `src/design/design-app.tsx` — pass `defaultOpen` to the two dialog
  scenarios.

No new files, no dependency changes.

## Reuse

- `InboxViewPreferences` and `DEFAULT_INBOX_VIEW_PREFERENCES` in
  `src/renderer/src/inbox-view-preferences.ts` — already defines the
  serialization shape; the seed in `main.tsx` mirrors the same JSON the
  renderer writes.
- `loadInboxViewPreferences` — the seed is read by the existing loader on
  first mount, no loader change needed.
- `AlertDialog` `open`/`onOpenChange` — both dialogs already use the
  primitive; the `defaultOpen` prop only changes the initial value.

## Steps

- [ ] Add `@source "../renderer/src/**/*.{ts,tsx}";` to
      `src/renderer/src/styles.css` immediately after the
      `@import "tailwindcss";` line.
- [ ] In `merge-confirmation-dialog.tsx`, accept
      `readonly defaultOpen?: boolean` and seed `useState(defaultOpen === true)`.
- [ ] In `review-submission-dialog.tsx`, accept the same prop and seed both
      `createOpen` and `submitOpen` initial values.
- [ ] In `src/design/main.tsx`, after the `localStorage` clear loop, add
      a branch for `scenario?.id === "inbox-default"` that writes the
      seeded `InboxViewPreferences` JSON to the `patchdesk.cfw.inbox` key.
- [ ] In `src/design/design-app.tsx`, pass `defaultOpen` to the
      `<ReviewSubmissionDialog>` and `<MergeConfirmationDialog>` instances
      in `DesignSubmissionScenario` and `DesignMergeScenario`.
- [ ] Run `pnpm build:design` and confirm the output CSS contains
      `min-width: 1280px` rules and is at least 3 000 lines.
- [ ] Restart `pnpm dev:design` (if not already running) and re-run the
      agent-browser recipe: open `?scenario=inbox-default` at 1440×900
      and verify the grid renders three columns with the watchlist in
      the sidebar.
- [ ] Capture the six PR rows in `inbox-default`, the opened `dialog-submit`
      body, and the opened `dialog-merge` body as fresh screenshots.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test --run`, and
      `pnpm test:design` to confirm the renderer and design test suites
      still pass.

## Verification

End-to-end proof that the three defects are closed, captured live by the
tester:

- **Grid restored.** The `main` element's `display` reads `grid` and its
  `gridTemplateColumns` reads
  `13rem minmax(0, 1fr) 21rem` at 1440×900 with the watchlist sidebar
  visible to the left. Total CSS rules in the loaded stylesheets should
  rise from 54 to several thousand, and the inbox screenshot should show
  the queue rail, the PR list, and the inspector side by side.
- **Dialogs open on load.** `?scenario=dialog-submit` shows
  "Create pending review" with the P0/P1 findings alert, ack checkbox,
  and Cancel/Confirm buttons visible without any click. `?scenario=dialog-merge`
  shows the "Confirm merge" body with the PR identity, head SHA, merge
  warnings, ack checkbox, and Cancel/Confirm buttons.
- **All 6 PRs visible.** `?scenario=inbox-default` shows the six
  expected rows (#19, #31, #42, #77, #8, #118) and the queue counter
  reads "All open 6" with the active "All open" tab highlighted.
- **No regressions.** `pnpm lint`, `pnpm typecheck`, `pnpm test --run`,
  and `pnpm test:design` all pass. The production renderer still
  ships its full CSS (verify by `grep -c 1280px out/renderer/assets/*.css`
  returning a non-zero count).

## Out of scope

- Reworking the design bridge, scenario registry, or any production code.
- Adjusting the production default inbox view from "my_inbox".
- Resolving the existing Settings scrolling correction — already noted as
  the visual baseline in the spec.
- Adding new scenarios beyond the eleven already registered.
