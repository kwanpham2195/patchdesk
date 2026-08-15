# Test case registry

This document lists the canonical test cases for the most important flows of Patchdesk.
It is the checklist to run when a related code path changes.
Read [architecture.md](./architecture.md) first for the terms and layers used here.

Each flow lists two kinds of coverage:

- `automated:` the canonical test or suite that must stay green.
- `manual:` the steps that require a human in the live app, plus the code paths that make the manual pass necessary.

Manual passes always happen in the live app, never on a build or unit test alone.
Use the `patchdesk-electron-tester` skill (agent-browser over CDP 9233) for live checks.
Keep the dev log tails live in herdr (`~/.local/share/patchdesk/logs/patchdesk.jsonl` and the `pnpm dev` console).
After main-process changes, restart the dev app; a stale main process shows as repeated `400 invalid_input` on `/v1/reviews/detect-updates`.

The full automated gate before any handoff is:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm test:e2e
```

## Startup and lifecycle

The app must never open a workbench over an unhealthy local API, and must never lose a write during shutdown.

- `automated:` `tests/main-lifecycle.test.ts` (health-check before workbench, fail closed, stop ordering), `tests/main-desktop-hardening.test.ts` (packaged one-shot runtime preference).
- `manual:`
  - Launch the dev app and confirm the window appears only after the log shows a healthy local API.
  - Quit while a GitHub write is in flight: the app must block close and show the wait dialog.
  - Quit while a draft is dirty: the confirm dialog must appear, and "discard" must lose only the latest edit.
  - Open the app a second time: the first instance must focus, not spawn a second window.
- `run when:` anything changes in `src/main/`, `app-lifecycle.ts`, `desktop-close-guard.ts`, `desktop-bridge.ts`, or window state.

## Local API security boundary

Every request needs the per-launch capability and the renderer origin. The bridge allows only listed routes.

- `automated:` `tests/local-api-auth.test.ts` (capability + origin required, every route protected), `tests/local-api-logs.test.ts` (capability boundary, request logging), `tests/desktop-bridge.test.ts` and `tests/main/desktop-bridge.test.ts` (route allowlist), `tests/main/renderer-origin.test.ts`.
- `manual:`
  - In the renderer DevTools console, fetch `http://127.0.0.1:<port>/v1/profiles` with no capability header: expect rejection.
  - Fetch the same route with the capability but a foreign `Origin`: expect rejection.
  - Confirm the log file records the rejected attempts without any command output or credentials.
- `run when:` anything changes in `src/main/local-api.ts`, `app-capability.ts`, `renderer-origin.ts`, or `ipc-contract.ts`.

## Open and prepare a Review

Opening a Review prepares one immutable session: PR fetch, canonical patch, context bundle, review input, debug ledger, and the represented-review worktree.

- `automated:` `tests/services/review-workbench-controller.test.ts` (load by reviewId only, fails closed on unreadable state, no re-preparation), `tests/services/review-session-preparation.test.ts` (complete immutable artifacts, head race rejection, quarantine of invalid session), `tests/services/review-worktree.test.ts` (dirty checkout detection, metadata-only fallback, prune and cleanup), `tests/services/review-context.test.ts` (rule bounds, sensitive-value rejection, truncation counters).
- `manual:`
  - Open a pull request with a clean local checkout: the workbench renders and the worktree exists under `~/.cache/patchdesk/profiles/<id>/review-worktrees/`.
  - Open the same PR with a dirty checkout: the review must be metadata-only or must clearly not touch the dirty checkout.
  - Open a PR with a very chatty conversation (threads over 256 KiB): inspect `prepared/context.json` and confirm the `truncated` counters and a file under 512 KiB.
  - Open a PR, then push a new commit to it on GitHub, and confirm opening does not silently use the stale head.
- `run when:` anything changes in `review-session-preparation.ts`, `review-context-service.ts`, `review-worktree-service.ts`, `review-workbench-controller.ts`, or `review-workbench-projection.ts`.

## Refresh, reconciliation, and terminal state

A Review is Fresh, RevisionChanged, or Unavailable. GitHub wins; Patchdesk never merges drafts.

- `automated:` `tests/services/review-refresh-service.test.ts` (head race, merged vs closed, phantom detection), `tests/services/review-write-gate.test.ts`, `tests/storage/review-remote-store.test.ts` (content-addressed snapshot integrity).
- `manual:`
  - Open a Review, push a commit to the PR on GitHub, refresh: the workbench must show RevisionChanged and block writes until refresh succeeds.
  - Merge the PR on GitHub, refresh: the workbench must become Terminal with no review or merge actions.
  - Close the PR without merging, refresh: Terminal with closed state.
- `run when:` anything changes in `review-refresh-service.ts`, `review-write-gate.ts`, `review-remote-store.ts`, or the freshness transitions in `src/domain/review.ts`.

## Insight runs: Analysis and Walkthrough

The coordinator owns the run lifecycle; the child is a throwaway; results are validated twice; stale runs are superseded; model output is never authority.

- `automated:` `tests/services/insight-run-coordinator.test.ts` (startup recovery, supersession on patch change, cancellation persistence, malformed replacement), `tests/services/flue-insight-child-invoker.test.ts` (bounded stdin protocol, fail closed), `runtime/flue/tests/flue-2-insight-runtime.test.ts` (one strict data value, duplicate submission rejection, abort), `tests/services/model-review-runner.test.ts` (immutable snapshots, prompt bound), `tests/workflows/generate-walkthrough.test.ts` (schema bounds, alias validation).
- `manual:`
  - Run an Analysis on a real PR: the run card must move queued to running to completed, and findings must map to the diff.
  - Run a Walkthrough: the narrative must render with its chapter rail, sections must mark reviewed, and the progress must survive reopening the review.
  - Cancel a run mid-flight: the run must settle as cancelled and retain nothing.
  - Run Analysis, push a commit, run again: the earlier result must be superseded, not merged with the new one.
  - Run a Walkthrough on a large patch (over 2 MiB): the run must fail with a clear diagnostic, not a crash. This case changes when chunked passes land.
- `run when:` anything changes in `insight-run-coordinator.ts`, the Flue child (`runtime/flue/src/`), `model-review-runner.ts`, `walkthrough-operation.ts`, or the insight record state machine in `src/domain/insight-record.ts`.

## GitHub write flows

Writes require a Fresh Review, explicit action, durable intent, and a read-only post-write reconciliation. Uncertainty locks, never replays.

- `automated:` `tests/services/pending-review-service.test.ts` (intent before write, no replay, ownership, submit only once), `tests/services/direct-summary-review-service.test.ts` (author approval blocked, uncertainty retained), `tests/services/published-feedback-service.test.ts` (confirmation + head recheck), `tests/services/inline-conversation-service.test.ts` (target ownership proofs, no full-conversation reads).
- `manual:`
  - Run Analysis, then use a Finding review command: the GitHub pending review must appear with exactly that finding, and the Analysis screen must expose the summary action.
  - Submit the pending review from the Finish review modal: one GitHub review must be published with the edited body.
  - Comment now from the diff: the comment must publish immediately while no pending review exists.
  - Resolve and unresolve a mapped conversation thread: the GitHub thread state must change.
  - Edit and delete an own published comment: must work with confirmation.
  - Delete or dismiss a comment you did not author: must be rejected.
- `run when:` anything changes in `pending-review-service.ts`, `direct-summary-review-service.ts`, `published-feedback-service.ts`, `inline-conversation-service.ts`, `review-write-gate.ts`, or the GitHub adapter write methods.

## Merge

Merge binds the acknowledgement to the exact represented base, head, and patch; stale or uncertain outcomes never auto-retry.

- `automated:` `tests/services/merge-write-controller.test.ts` (ack bound to exact revision, stale rejection, uncertain outcomes durable, concurrent merge rejected), `tests/services/review-recovery-service.test.ts` (uncertain merge stays locked while the PR is open), `tests/domain/merge-operation.test.ts`.
- `manual:`
  - Merge a PR with current warnings: the acknowledgement dialog must appear and the merge must use the selected method.
  - Merge a PR whose head changed on GitHub since refresh: must be rejected as stale.
  - Simulate an uncertain outcome (for example, kill the network after the write): the merge must stay locked with a recover action, and recovery must reconcile without a second write.
- `run when:` anything changes in `merge-write-controller.ts`, `merge-service.ts`, `merge-operation-store.ts`, or `review-recovery-service.ts`.

## Storage integrity

Stores are atomic JSON with a sensitive-value guard. Corrupt files are quarantined; snapshots are content-addressed.

- `automated:` `tests/storage/review-store.test.ts` (atomic round-trip, profile path boundaries), `tests/storage/review-artifact-storage.test.ts` (quarantine), `tests/storage/insight-store.test.ts` (schema rejection), `tests/storage/review-remote-store.test.ts` (hash mismatch rejection), `tests/storage/patchdesk-storage.test.ts`.
- `manual:`
  - Corrupt a `review.json` in `~/.local/share/patchdesk/profiles/<id>/workbenches/`: the app must quarantine it and refuse to load it, and the quarantine entry must appear under `.quarantine/`.
  - Delete a session's `session.json`: reopening must quarantine the session directory.
- `run when:` anything changes in `src/adapters/storage/`, `json-file.ts`, or the storage-management service.

## Renderer contract and workbench projection

The renderer re-validates every projection. A 200 response does not mean the workbench will open.

- `automated:` `tests/renderer/renderer-contracts.test.ts` (strict projections, forbidden fields), `tests/browser/local-api-workbench.spec.ts` (bridge opens the canonical workbench, denies removed routes).
- `manual:`
  - Open a PR with review-attached comments (inline threads): the workbench must open, not stay silently on the inbox.
  - After any renderer contract change, open three PRs with different shapes (clean, threaded, walkthrough-carrying) and watch for the `[contracts] parseWorkbenchResponse FAILED` console line.
- `run when:` anything changes in `renderer-contracts.ts`, `review-workbench-projection.ts`, or any domain type that the projection serializes.

## Codex provider

Codex runs against the immutable represented worktree only, through a read-only sandbox, with the maintainer's own CLI account.

- `automated:` `tests/services/codex-insight-invoker.test.ts` (app-owned worktree and head only), `tests/adapters/codex-app-server-client.test.ts` (approval scoped to the worktree, repository-controlled executables denied, silent turn timeout).
- `manual:`
  - Run an Analysis with the Codex CLI account provider on a real PR: the result must complete and the worktree must remain unchanged.
  - During the run, inspect the Codex turn: only read-only commands inside the worktree may be approved.
  - Confirm no new login or credential store entry appeared: Patchdesk must not read or persist Codex credentials.
- `run when:` anything changes in `codex-insight-invoker.ts`, `codex-app-server-client.ts`, or the provider catalog.

## Browser, accessibility, performance, and package

The built app is the outermost boundary.

- `automated:` `tests/browser/review-workbench.spec.ts` (workbench surfaces, diff stream), `tests/browser/protected-loopback-workflow.spec.ts` (loopback API through the bridge), `tests/browser/accessibility.spec.ts`, `tests/browser/performance.spec.ts` (1,000 files, ~10 MB patch), package smoke (`pnpm test:package-smoke`), bundle check (`pnpm test:bundle`).
- `manual:`
  - Package a build (`pnpm package:mac`) and run the packaged app against a real PR: open, refresh, analysis, walkthrough, and one write flow.
  - In the packaged app, open the performance fixture and confirm the diff stays responsive.
- `run when:` anything changes in `src/renderer/src/`, `electron.vite.config.ts`, packaging, or the staged Flue runtime.

## Keeping the registry honest

- The automated column points at canonical tests, not the full suite. New flows get their canonical test here when they land.
- A manual case stays only while a human can run it in the dev app or the packaged app. If a code path removes the case, remove the manual entry.
- When a manual pass finds a bug, add a regression test first, then keep the manual case only if it still covers something the test cannot (visual, timing, or real-GitHub behavior).
