---
created_at: 2026-08-08
repos: [patchdesk]
status: completed
---

# Reload restores the current screen (renderer position persistence)

User need: after ⌘R / renderer reload, the app should land back on the same
screen the user was on — not just the same top-level destination, but the
same workbench tab/file and an open Settings overlay.

## Current behavior

- Destination (dashboard | workbench:<reviewId>) IS persisted in localStorage
  (`patchdesk.destination`) and restored on boot; inbox-flow reopens the stored
  review via `/v1/reviews/load`. Verified working (QA 2026-08-08: workbench
  reopened after full relaunch).
- NOT restored: workbench internal position (activeTab conversation/diff/
  insights, navigator section, selected diff path) and the Settings overlay
  (open state + active section). The plumbing for workbench restore already
  exists (`ReviewWorkbenchInitialState` + `initialUiState` prop, forwarded to
  `ReviewWorkbench`) but nothing ever supplies or persists it.

## Design

- New `src/renderer/src/lib/screen-restore.ts`:
  - Workbench UI position -> localStorage `patchdesk.workbench-ui.v1.<reviewId>`
    (consistent with destination: survives relaunch too). Subset:
    `{ activeTab, section, selectedPath }`; validated on load, corrupt -> ignored.
  - Settings overlay -> sessionStorage `patchdesk.settings.v1` = `{ section }`
    (reload-only restore; a fresh launch must not pop Settings open).
- `review-workbench.tsx`: add `activeTab` to `ReviewWorkbenchInitialState`;
  add optional `onStateChange({ activeTab, section, selectedPath })` callback
  - effect; call on position changes.
- `review-workbench-flow.tsx`: accept + forward `onUiStateChange` to
  `ReviewWorkbench`. (`initialUiState` forwarding already exists.)
- `app.tsx`:
  - At boot with destination=workbench: load persisted UI state for
    destination.reviewId into a ref; pass as `initialUiState` on the first
    workbench render (matching reviewId), then clear.
  - `onUiStateChange` -> save for `workbench.review.id`.
  - Boot: if `loadSettingsRestore()` present (and not fixture mode) open
    Settings with `initialSection`; close -> clear restore.
- `settings-modal.tsx`: `initialSection` prop (first open only, then general)
  - `onSectionChange` callback.

## Tests

- screen-restore lib: roundtrip, review-key scoping, corrupt/malformed values,
  settings restore clear-on-close semantics.
- settings-modal: initialSection renders the requested tab on first open and
  resets to general after close/reopen.
- Existing renderer suites must stay green (props are additive/optional).

## Verification

pnpm lint / typecheck / test -- --run; pnpm build. Live QA (tester agent):
workbench -> Diff tab + select file -> reload -> same tab/file; Settings ->
Logs -> reload -> Settings reopened on Logs.

## Out of scope

- Inbox filter/sort/scroll restoration (separate follow-up if wanted).
- `initialSection`/`onNavigate` dead props in review-workbench-flow (legacy
  seam superseded by the new persistence).
