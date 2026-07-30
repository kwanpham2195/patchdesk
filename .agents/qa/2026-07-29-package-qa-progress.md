# Package QA progress — 2026-07-29

Scope: existing Settings, review, and walkthrough behavior in the packaged
Patchdesk app. Use GitHub PR #717 or #754 as realistic review data. Do not
add product functionality.

## Guardrails

- Preserve pre-existing worktree changes.
- Use an isolated app user-data directory and a unique CDP port per live run.
- Clear the isolated Patchdesk cache and review-data directories between
  independent scenarios; never touch the user's normal app data.
- Record reproducible issues here before changing code, along with the focused
  test or live repro that proves a fix.

## Status

- [x] QA environment and evidence notes created.
- [x] Baseline local checks and macOS package.
- [x] Live Settings scenario.
- [x] Live review scenario using the requested PRs.
- [x] Live walkthrough generation with a completed #717 model review.
- [x] Re-test the rebuilt final package in an isolated packaged app.
- [x] Package the final diagnostics build.
- [x] Prove the fresh bundle contains a runnable staged Flue CLI.

## Findings

### PKG-001 — Packaged app cannot launch

- Repro: `pnpm package:mac && pnpm test:package-smoke`.
- Actual: macOS rejects `release/mac-arm64/Patchdesk.app` with
  `kLSNoExecutableErr: The executable is missing`.
- Expected: the packaged app launches in the smoke test’s isolated user-data
  directory and exposes its workbench through CDP.
- Cause: the smoke runner handed the bundle to `open -n`, which fails on this
  machine before Electron starts despite a present, arm64 executable. The
  repository's packaged QA recipe launches that executable directly.
- Fix: the smoke runner now spawns `Contents/MacOS/Patchdesk` with its same
  isolated `HOME`, user-data directory, and CDP port; cleanup also runs if CDP
  connection fails. It now also checks the Workspace/Watchlist and Data &
  recovery tabs before asserting the independently scrollable Settings body.
- Evidence: the current smoke command reaches Electron launch but the primary
  sandbox blocks its CDP connection (`connect EPERM 127.0.0.1`). The fresh
  bundle's staged Flue CLI separately returns its normal `--help` output.
- Status: implementation fixed; awaiting independent interactive package
  retest under a temporary HOME.

### PKG-002 — Restricted packaging silently left an old renderer bundle

- Repro: build the current renderer in the restricted sandbox, then run the
  package command while an older `release/mac-arm64` exists.
- Actual: the command printed Electron Builder's packaging start but did not
  replace the generated bundle. Archive inspection showed an old renderer
  asset without `Review activity`, and the live package lacked that UI despite
  the source and `out/renderer` containing it.
- Fix: move only the stale generated `release/mac-arm64` directory to Trash,
  rebuild with the filesystem access Electron Builder needs, then inspect the
  resulting `app.asar` before visual QA. The fresh archive contains
  `index-jtUjGthz.js`, `Review activity`, `review-activity-card`, and the
  staged Flue runtime.
- Status: fixed and awaiting fresh visual confirmation.

### Live review observations

- Requested PR #717 (`centraldigital/cfw-bo-staff-api`) and #754
  (`centraldigital/cfw-bo-portal-bff`) are present in the real inbox with
  failing checks. Failed checks now remain visible context, while **Run review**
  is the primary action; merge readiness remains separately blocked.
- The first fresh #717 preparation failure came from an invalid GitHub GraphQL
  query: review-comment fields were queried on the wrong object. The query now
  reads diff location fields from the review thread, and real #717 reaches its
  prepared workbench.
- A subsequent real DeepSeek Flash / low review reached confirmation and then
  failed before contacting the model. The packaged app included Flue itself
  but not its dependency closure; once that was made runnable, Flue also
  exposed a helper file incorrectly placed in `src/workflows/`, where every
  module is treated as a workflow. The helper now lives in `src/services/`.
- The package now stages an isolated Flue dependency closure and the required
  review source before packaging. A direct packaged CLI smoke check reaches
  the review-workflow input boundary without missing-module errors.
- Settings saved `opencode-go/deepseek-v4-flash` with `low` reasoning. The
  completed local packaged fixture rendered and navigated mapped findings in
  the workbench correctly.
- DeepSeek Flash / low and OpenAI Codex / low both start a real read-only #717
  run and then fail. This rules out a DeepSeek-only model selection or visible
  key/rate-limit problem. The former error boundary discarded every raw Flue
  failure and rendered one generic outcome, so the exact safe failure class
  could not be inspected.
- The app now classifies only finite, non-sensitive terminal causes (sign-in,
  rate limit, runtime unavailable, timeout, invalid result, or generic
  execution failure), records review and walkthrough milestones, and exposes
  the redacted activity list in **Settings → Data & recovery**. It never stores
  raw command output, prompts, paths, tokens, or model prose.
- Local review-data cleanup originally removed only discarded sessions, so a
  failed #717 review survived a requested clear. It now removes every
  non-running session while preserving a currently running review and the
  diagnostic history.
- Fresh packaged real-user pass used only a disposable `HOME` and Chromium
  profile. The tester added the #717 repository to that isolated Watchlist,
  assigned its local checkout, refreshed it read-only, and started
  `opencode-go/deepseek-v4-flash` at `low` reasoning.
- The real read-only #717 review completed after 491 seconds with an approve
  result and zero findings. No GitHub write occurred. Evidence:
  `/tmp/patchdesk-qa-20260729-final/evidence/37-pr717-terminal.png`.
- The real read-only walkthrough started with the same model and reasoning.
  It exposed the two bugs below before the tester cleared the disposable local
  review data and cache. Evidence:
  `/tmp/patchdesk-qa-20260729-final/evidence/38-walkthrough-dialog.png`,
  `/tmp/patchdesk-qa-20260729-final/evidence/40-walkthrough-terminal.png`,
  `/tmp/patchdesk-qa-20260729-final/evidence/41-activity-terminal.png`, and
  `/tmp/patchdesk-qa-20260729-final/evidence/42-after-cleanup-restart.png`.

### BUG-006 — Completed walkthrough could be rendered as failed

- Repro: generate a walkthrough whose valid patch file metadata is longer
  than the renderer's former 2,000-character `filePrefix` cap.
- Actual: the service completed and activity recorded `Walkthrough Completed`,
  but the renderer rejected the ready projection and showed “Walkthrough
  didn't finish.”
- Fix: use one 8,192-character maximum at the domain and renderer boundary.
  Values within the shared bound reach the renderer; larger malformed patch
  metadata is rejected before a ready projection is persisted.
- Evidence: the focused contract regression constructs a valid long path,
  failed before this fix, and now passes.

### BUG-007 — Clearing local review data stranded the user on a deleted review

- Repro: open a completed review, clear local review data, then stay in the
  app or restart it.
- Actual: storage correctly removed the review, while the renderer and its
  persisted route still pointed at that session. A restart opened “Could not
  open saved review” rather than Inbox.
- Fix: after successful local-review-data cleanup, reset the in-memory
  workbench and persist the Inbox destination. Cache-only cleanup keeps the
  current review route intact.
- Evidence: the renderer regression opens a stored workbench, confirms local
  cleanup, and asserts Inbox plus `patchdesk.destination=dashboard`.

### UX-002 — Watchlist displaced into the narrow dashboard column

- Repro: open the packaged inbox; Watchlist replaces the usable main queue
  area in a narrow, permanently visible side column.
- Expected: repository management remains in Settings, where it is scoped to
  workspace configuration rather than taking over daily review work.
- Fix: remove the dashboard panel and add a **Workspace** Settings tab that
  contains the existing Watchlist controls unchanged.

### UX-003 — Settings content crossed its fixed footer

- Repro: open Settings on a shorter desktop viewport and scroll General.
- Actual: cards extended underneath the fixed footer, obscuring controls.
- Fix: make the dialog a bounded flex column with one explicit scroll region;
  the footer is now outside that region and always remains visible.

### UX-001 — Local fixture cleanup confirmation could not complete

- Repro: in the packaged completed-review fixture with no active workspace,
  open **Settings → Data & recovery**, choose either cleanup action, then
  confirm.
- Actual: the confirmation stayed open with no progress or feedback because
  cleanup had no workspace profile to target.
- Fix: label the actions as workspace-scoped, explain the missing profile, and
  disable both actions until one is active; the handler also reports that state
  if it changes while a confirmation is open.
- Evidence: the focused regression test failed before the fix and passed after;
  a fresh packaged-app screenshot confirms the explanation and disabled
  controls.

### BUG-004 — Review failure could not be diagnosed or cleared

- Repro: run #717 with either requested DeepSeek Flash / low or the fallback
  OpenAI Codex / low, wait for the same generic failure, then choose **Clear
  local review data**.
- Actual: the failure did not identify a safe cause, and the failed review
  remained visible after cleanup.
- Fix: persist a bounded, redacted workflow milestone trail and terminal
  classification; make the existing Data & recovery screen load that activity.
  Clear local review data now removes all non-running review sessions.
- Evidence: focused UI/API/service tests cover the authenticated activity route,
  safe rate-limit/runtime classification, walkthrough events, and failed-review
  cleanup. Final packaged visual evidence remains pending.

### BUG-005 — Best-effort activity could interrupt a walkthrough

- Repro: make the local diagnostic writer reject unexpectedly while a
  walkthrough starts, completes, or records its terminal failure.
- Actual: the logging await crossed the workflow boundary, so an unexpected
  storage rejection could turn an otherwise successful walkthrough into a
  failed request.
- Fix: review and walkthrough activity writes now swallow only their own
  unexpected storage exception. The review/walkthrough result remains the
  authoritative outcome.
- Evidence: the walkthrough regression test injects a rejecting diagnostic
  writer and verifies the workflow still invokes once and returns ready.

### ENV-001 — Final package stage lacked an offline Flue dependency closure

- Repro: run `pnpm package:mac` after the diagnostics changes.
- Actual: the production build succeeds, then the isolated Flue runtime stage
  could not resolve npm packages from the unavailable registry or local pnpm
  store.
- Fix: the stage now prefers a normal offline pnpm install and, only when that
  cache is incomplete, copies the last verified packaged Flue dependency
  closure while always copying the current workflow source. A fresh
  `pnpm package:mac` now completes, and its bundled CLI responds to `--help`.
- Status: fixed for this offline environment. A tester still needs to open the
  fresh bundle with a disposable Patchdesk HOME and verify it through CDP.

### UX-004 — Design Settings fell out of parity with the desktop renderer

- Repro: open the Design `settings-recovery` scenario in the existing live
  browser-only renderer.
- Actual: the old overlay omitted the Workspace tab and Watchlist, and the Data
  & recovery view omitted Review activity. The fixed footer still remained
  visible when content scrolled.
- Fix: the Design overlay now includes Workspace/Watchlist and the redacted
  Review activity fixture, with a browser regression that traverses both.
- Evidence before fix: `/tmp/patchdesk-design-settings-general-20260729.png`,
  `/tmp/patchdesk-design-settings-data-recovery-20260729.png`, and
  `/tmp/patchdesk-design-settings-footer-pagedown-20260729.png`.
- Status: source build/typecheck/lint pass. The Design browser re-run is
  currently blocked before page load by the macOS Chromium sandbox restriction,
  so no post-fix visual pass is claimed.

### ENV-002 — Required isolated package launch is safety-policy-blocked

- Repro: launch the fresh bundle with both a unique Chromium user-data
  directory and a temporary `HOME`, which Patchdesk needs to isolate its
  app-owned configuration, cache, and review history.
- Actual: the tester is prevented from overriding `HOME` by execution safety
  policy before the app starts. `--user-data-dir` alone is insufficient and has
  previously collided with Patchdesk's single-instance state.
- Required action: explicit approval for this single temporary-HOME launch.
  Approval received. The live tester owns the isolated launch; no normal user
  data has been touched.

### Verification snapshot — 2026-07-29 (current bundle)

- Passed: `pnpm lint`, `pnpm typecheck`, the focused changed-surface Vitest
  set, `pnpm build`, `pnpm package:mac`, `pnpm build:design`, and
  `git diff --check`.
- Full Vitest result: 80 files / 544 tests passed when run outside the
  restricted socket sandbox, including all 27 local-API capability tests.
- Package smoke result: Electron launched; the same sandbox denied the test
  process's CDP connection before the new UI assertions could run. This is not
  recorded as a product pass.
- Latest focused regressions: `tests/renderer/renderer-contracts.test.ts` and
  `tests/renderer/dashboard.ui.test.tsx` pass (41 tests). `pnpm lint`,
  `pnpm typecheck`, and `git diff --check` pass after the BUG-006/BUG-007
  changes. Full Vitest passes: 80 files / 546 tests. The rebuilt unsigned arm64
  app passed `pnpm test:package-smoke` through the completed-review fixture and
  Settings Workspace/Data & recovery interactions.
- Final independent visual package pass used a new disposable home and
  confirmed Watchlist in Workspace, the redacted activity empty state, local
  review-data cleanup returning directly to Inbox, and Inbox after isolated
  restart. Evidence:
  `/tmp/patchdesk-qa-20260729-final-fix/evidence/02-settings-workspace-watchlist.png`,
  `/tmp/patchdesk-qa-20260729-final-fix/evidence/03-settings-data-activity.png`,
  `/tmp/patchdesk-qa-20260729-final-fix/evidence/04-clear-local-returns-inbox.png`,
  `/tmp/patchdesk-qa-20260729-final-fix/evidence/05-after-cleanup-restart-inbox.png`.
  The tester did not repeat the multi-minute model workflow after BUG-006; its
  ready-projection boundary is covered by the focused contract regression.
