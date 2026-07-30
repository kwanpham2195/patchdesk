# Package QA working memory — 2026-07-29

This is a narrow, disposable working record for the current QA loop. Durable
repository rules belong in `AGENTS.md` only when the user asks to make a note.

## Known setup

- Product: Patchdesk Electron app; renderer remains sandboxed and uses the
  authenticated local API through preload.
- Live testing: an assigned tester owns interactive browser/Electron QA using
  `agent-browser`; package runs must use isolated user data and CDP ports.
- Test data: use PR #717 or #754 without any GitHub write.
- Requested model preference: DeepSeek Flash with low reasoning. OpenAI Codex
  with low reasoning is an approved fallback diagnostic model.

## Evidence index

The live tester will return screenshot paths and steps. Add only confirmed,
reproducible findings to the progress file before investigating source.

## Learned during this loop

- `--user-data-dir` isolates Electron's Chromium profile but not necessarily
  Patchdesk's application-owned config and review directories. Live scenarios
  must also use a fresh `HOME` so their config, cache, and review data are
  separate from the user's real state.
- On this machine the macOS `open -n` handoff fails for the generated bundle
  before Electron starts, while direct execution of the packaged arm64 binary
  works. The package smoke runner now uses that repository-prescribed launch
  path and cleans its isolated state even if CDP never connects.
- Settings cleanup is workspace-scoped, not global. When no workspace is
  active, disable both cleanup actions with an explicit explanation rather than
  allowing a confirmation that cannot send a request.
- Failed CI is review context, not a review or walkthrough gate. Preserve the
  failure badge and inspection link, while offering **Run review**; only merge
  readiness remains blocked.
- Preparation cleanup must remove Patchdesk's own `worktree.json` marker before
  `git worktree remove`, because Git rejects worktrees with untracked files.
  If removal fails, restore the verified marker so recovery can safely retry.
- The generic review-open error is intentionally renderer-safe. Record only a
  bounded internal stage label in diagnostics to distinguish worktree, remote
  context, patch-write, and context-preparation failures.
- GitHub review-thread diff-side fields belong to `PullRequestReviewThread`,
  not `PullRequestReviewComment`; a schema error here prevented #717 from
  reaching the prepared workbench.
- Flue treats every module under `src/workflows/` as a runnable default-export
  workflow. Keep helpers in `src/services/` or another non-workflow directory.
- A packaged Flue CLI needs its complete dependency closure, not only the
  `@flue` packages. The package stage builds a dedicated runtime under
  `out/workflow-runtime`, which is copied as an unpacked extra resource. When
  the pnpm store is incomplete offline, it may seed that dependency closure
  from the last verified package, but must always copy the current source.
- Settings is a bounded flex dialog: only its tab body scrolls; Watchlist
  belongs under its Workspace tab, not in the main review queue.
- Never treat a generic workflow failure as a model-provider diagnosis. Both
  DeepSeek Flash / low and OpenAI Codex / low reproduced #717's failure. Keep
  raw workflow output inside the process boundary; record finite safe milestones
  and terminal categories only, then inspect them via Settings → Data & recovery.
- Clear local review data means every non-running local review session is
  removed. Preserve active runs and diagnostics so cleanup cannot erase a
  running workflow or its evidence.
- Keep the permanent Design overlay in parity with production Settings tabs.
  When Settings gains Workspace or Data & recovery content, update the Design
  overlay and its scenario test in the same change; it is a visual regression
  target, not a historical mock.
- A disposable Chromium `--user-data-dir` does not isolate Patchdesk's
  app-owned paths. Packaged interactive QA needs a temporary `HOME` as well;
  if execution policy blocks that override, record the block and request that
  narrow approval before launching rather than touching normal user state.
- A failed local CDP connection in this sandbox (`connect EPERM` to
  `127.0.0.1`) and an API-test listener denial are infrastructure evidence,
  not product failures. Keep the command output with the QA record, then use
  the assigned live tester for the visual proof once isolated launch is allowed.
- Diagnostics are observability, not workflow control. Every diagnostic write
  at a review or walkthrough execution boundary must be best-effort; unexpected
  storage rejection must not change a successful workflow result.
- Do not trust an Electron Builder start line as package proof in this sandbox.
  Inspect the fresh `app.asar` for the renderer asset and the relevant UI
  strings before asking a live tester to exercise a package; restricted writes
  can leave a stale generated bundle in place.
- A successful walkthrough service result can still fail at the renderer
  contract boundary. Keep `NarrativeWalkthrough` bounds shared with the
  renderer schema; a 2,000-character `filePrefix` limit rejected valid long
  diff metadata after activity had already recorded completion.
- Clearing local review data deletes the active completed session by design.
  Its success callback must reset both in-memory workbench state and the
  persisted route to Inbox; cache-only cleanup must not do that.
- The isolated #717 DeepSeek Flash / low review is confirmed end-to-end:
  read-only workflow completed in 491 seconds with approve / zero findings.
  The isolated walkthrough then reproduced the renderer contract mismatch.
- Package smoke fixtures may now carry a workspace profile. Assert their real
  outcome (load and render an empty redacted activity trail), not a disabled
  activity control. A settings scroll area remains correct when its content
  fits the available height; assert the dedicated scroll viewport rather than
  requiring overflow in every fixture.
- Final rebuilt-package visual proof confirms that local-review-data cleanup
  returns to Inbox immediately and persists that Inbox route across an
  isolated restart. Keep that real-Electron check paired with the renderer
  regression because the bug involved both in-memory state and local storage.
