# Test case registry

This document lists the canonical test cases for the most important flows of Patchdesk.
It is the checklist to run when a related code path changes.
Read [architecture.md](./architecture.md) first for the terms and layers used here.

Each flow lists two kinds of coverage:

- `automated:` the canonical test or suite that must stay green.
- `manual:` the steps that require a human in the live app, plus the code paths that make the manual pass necessary.

A flow may also carry a `gap:` line naming behaviour nothing tests, or a `note:`
line correcting an expectation the flow no longer meets. Recording a gap is
right; naming a test that does not exist, or a behaviour a named test does not
assert, is not.

Manual passes always happen in the live app, never on a build or unit test alone.
Use the `patchdesk-electron-tester` skill (agent-browser over CDP 9233) for live checks.
Keep the dev log tails live in herdr (`~/.local/share/patchdesk/logs/patchdesk.jsonl` and the `pnpm dev` console).
After main-process changes, restart the dev app; a stale main process shows as repeated `400 invalid_input` on `/v1/reviews/detect-updates`.

The full automated gate before any handoff is:

```bash
pnpm check
pnpm lint
pnpm build
pnpm test:e2e
```

`pnpm check` is the one command that carries most of the gate. It runs
`pnpm typecheck`, `pnpm typecheck:scripts`, `pnpm test:all` (the root suite and
the separate `runtime/flue` suite), `pnpm lint:staged`,
`pnpm lint:changed -- origin/main`, and `pnpm knip:ratchet`, in that order, and
stops at the first failure. It does not run the repo-wide `pnpm lint`, the
bundle check, or the browser suite, and the pull request gates run all three —
so run `pnpm lint` beside it, add `pnpm build` and `pnpm test:e2e` for renderer
or desktop work, and `pnpm test:bundle` when the renderer bundles or the Pierre
theme catalog change. `CONTRIBUTING.md` ("Verifying before pushing") describes
each command; `AGENTS.md` ("Testing") sets which layer a new test belongs in.

There is no assistive-technology lane: no axe scan, no screen-reader narration
check, no forced-colors or reduced-motion check (ADR 0034). Keyboard operability
is kept and is tested in `tests/browser/keyboard-operability.spec.ts` and
`tests/browser/review-diff-keyboard-nav.spec.ts`.

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
- `run when:` anything changes in `src/main/local-api.ts`, `src/main/routes/`, `app-capability.ts`, `renderer-origin.ts`, or `ipc-contract.ts`.

## Pull requests screen

One Selected repository, remembered per profile. GitHub answers the filter, the order, and the count; Patchdesk answers only the two Review indicators (Updated since review, Ready to merge). Refresh happens only when asked.

- `automated:` `tests/services/maintainer-inbox-service.test.ts` (single-repository search scoped and page-token-validated, GitHub's `issueCount` used as the count rather than the loaded row count, merged scope returns only the terminal action), `tests/adapters/github-adapter.test.ts` (`searchMaintainerPullRequests` query shape, `rateLimit { remaining resetAt }` selection guarded on both listing queries, rate-limit and forbidden read mapping), `tests/domain/maintainer-inbox.test.ts` (`ready_to_merge`'s four conditions tested independently, merged rows projected outside active-work), `tests/domain/inbox-freshness-policy.test.ts` (degraded/stale thresholds, clock-skew and NaN handling), `tests/renderer/maintainer-inbox.ui.test.tsx` (repository picker, label filter sent to GitHub instead of filtering loaded rows, repository-wide `matchCount` rendered honestly, pagination that disables an unavailable direction with a real `disabled` button and ignores clicks on it), `tests/renderer/inbox-flow.ui.test.tsx` (merged rows routed to the terminal-only open endpoint, rate-limited and forbidden repository outcomes render no retry), `tests/renderer/inbox-view-preferences.test.ts` (selected repository and page size persisted per profile, reset to defaults on a version mismatch), `tests/renderer/inbox-freshness.test.ts` (freshness labels and elapsed-time copy; no scheduler remains), `tests/services/inbox-refresh-coordinator.test.ts` (concurrent reads to the same profile and repository coalesced, isolated across repository/page/size/filter), `tests/storage/maintainer-inbox-cache-store.test.ts` (schema-strict round-trip, credential-like data rejected), `tests/local-api-auth.test.ts` (`GET /v1/inbox` and `GET /v1/inbox/labels` reject a repository outside scope and an out-of-range page size; `GET /v1/dashboard` and `POST /v1/direct-entry/preview` return 404).
- `manual:`
  - Compare the header count against GitHub's own count for the same filter; they must agree, including on a repository with more matches than one page.
  - Leave the screen idle for three minutes: no `GET /v1/inbox` request may appear in the log.
  - View → Refresh and Cmd+R must both refresh.
  - Open a merged pull request: the workbench must open read-only.
  - Push a commit to a pull request with a saved Review, then refresh: Updated since review must appear, and clear once the review is reopened on the new head.
  - A repository with no open pull requests must read differently from a filter that excludes everything.
- `run when:` anything changes in `maintainer-inbox-service.ts`, `inbox-refresh-coordinator.ts`, the search queries in `github-graphql-queries.ts`, `use-inbox-view.ts`, `inbox-view-preferences.ts`, `maintainer-inbox.tsx`, `inbox-flow.tsx`, or `desktop-menu.ts`.

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

- `automated:` `tests/services/review-refresh-service.test.ts` (head race, base race, merged vs closed, terminal-only refresh), `tests/services/review-write-gate.test.ts` (represented and undetected state required, revision agreement), `tests/renderer/use-review-observation.test.ts` (the renderer's detect-updates state machine: trigger coalescing, generation discipline, direct commands pausing detection, Reconciled and Terminal outcomes, the recent-write journal), `tests/storage/review-remote-store.test.ts` (content-addressed snapshot integrity).
- `manual:`
  - Open a Review, push a commit to the PR on GitHub, refresh: the workbench must show RevisionChanged and block writes until refresh succeeds.
  - Merge the PR on GitHub, refresh: the workbench must become Terminal with no review or merge actions.
  - Close the PR without merging, refresh: Terminal with closed state.
- `run when:` anything changes in `review-refresh-service.ts`, `review-write-gate.ts`, `review-remote-store.ts`, `use-review-observation.ts`, or the freshness transitions in `src/domain/review.ts`.

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

## Insight runs: Brief

The Brief is a third Insight type with one extra rule: every model sentence cites a manifest alias, and every number comes from a tool. An uncited sentence is demoted to an Assumption, an all-uncited Brief is rejected, and the Reach counts come from `git grep` in the main process, never from the model.

- `automated:` `tests/domain/brief.test.ts` (the three alias namespaces, a verified Brief, an uncited sentence demoted to an Assumption with partial verification, an all-uncited Brief rejected, a manifest that survives an unindexable patch, the drift block's kind requirement and its absence with no description, the Start here order cut to changed paths, the stored round-trip and a Brief retained before a later block existed), `tests/domain/brief-ownership.test.ts` (one status per changed file, ordered skeleton, generated files left out, a note on a path outside the diff dropped and counted, the contract hunk cut from the patch), `tests/domain/brief-reach.test.ts` (a proposed name kept only when the patch carries it as a whole word, the exported-declaration fallback, removed declarations, surfaces reported lit and unlit, untested reach, the block labelled a one-hop text match), `tests/services/brief-reach-service.test.ts` (caller files outside the pull request counted, a silent nonzero `git grep` exit read as no match, unavailable on search error and on timeout, a worktree outside the profile's own directory refused, a worktree no longer at the run's revision refused), `tests/services/insight-run-coordinator.test.ts` (a Brief run retained with its citations resolved, and with the Reach block the service counted), `tests/main/local-api-insight-brief-route.test.ts` (the `brief/run` and `brief/cancel` routes), `runtime/flue/tests/flue-2-insight-runtime.test.ts` (one Brief prompt built from a real production invocation, a result the Brief schema rejects, no model prompt text accepted on a production Brief invocation, and no sandbox, MCP connection, subagent, or inspector tool on the Brief child), `tests/renderer/brief-reader.ui.test.tsx` (the five blocks and their absent forms, the Reach rows and their unavailable line, the Start here card opening or generating the Walkthrough, the citation chip labels and counts), `tests/services/maintainer-inbox-brief-tag.test.ts` and `tests/renderer/inbox-row-item.ui.test.tsx` (the row tag present only for a Brief bound to the row's current head).
- `manual:`
  - Run a Brief on a real PR: the five blocks must appear in order — Goal with its Assumptions, Description vs diff, Shape, Reach — with Start here, Scope, and Provenance in the side column, and every Goal sentence must carry at least one citation chip.
  - Open a citation chip's evidence: an `h*` chip must name a hunk of this patch, a `d*` chip a paragraph of the description, a `c*` chip a commit of this revision.
  - Run a Brief on a PR with no description: the Description vs diff block must be absent, not empty.
  - Confirm the Provenance card names the provider and model chosen in the run dialog.
  - Delete or move the session worktree and run again: the Reach block must be replaced by one line saying why it was not counted, and the Brief must still be retained.
  - Push a commit, then reopen the Pull requests screen: the Brief tag must disappear from the row, because the retained Brief is no longer bound to the current head.
- `run when:` anything changes in `src/domain/brief.ts`, `stored-brief.ts`, `brief-ownership.ts`, `brief-reach.ts`, `brief-start-here.ts`, `brief-operation.ts`, `brief-reach-service.ts`, `insight-result-validation.ts`, the Brief branch of `insight-output-guidance.ts`, `codex-brief-prompt.ts`, the Brief arm of `runtime/flue/src/`, `brief-contracts.ts`, `brief-reader.tsx`, or `brief-reach-block.tsx`.

## Scope gauge

The gauge is deterministic: the same patch always gives the same buckets. Colours are categorical, never the status hues, and an unreadable patch means no gauge rather than an all-zero one.

- `automated:` `tests/domain/change-scope.test.ts` (one bucket per path over the rule table, generated preferred over every later rule, the banner read from the first three lines only, `linguist-generated` honoured, per-bucket sums with empty buckets omitted, the segment floor that never drops a bucket or overruns the bar, a unified patch counted per bucket, a deleted file attributed to the path it had), `tests/renderer/scope-gauge.ui.test.tsx` (every bucket named in the bar's accessible label at both sizes, one segment per bucket and none for an empty scope).
- `gap:` nothing tests the gauge on a Pull requests row. `maintainer-inbox-cache-store.test.ts` round-trips a row carrying `briefReady` but never one carrying `scope`, and no service test asserts that `readCurrentHeadScope` fills the field only for a session at the current head. Until it does, the last manual case below is the only cover.
- `manual:`
  - Open a review whose patch mixes source, tests, and a lockfile: the workbench header chip and the Scope card must show the same buckets and totals, and the generated share must be a hatch rather than a status colour.
  - Switch the app between light and dark: no bucket may take on the failure or warning hue in either theme.
  - On the Pull requests screen, confirm the gauge appears only on a row whose review is at the current head, and disappears once a new commit is pushed to that pull request.
- `run when:` anything changes in `src/domain/change-scope.ts`, `scope-gauge.tsx`, the `--scope-*` tokens in `styles.css`, the scope branch of `review-workbench-projection.ts`, or `readCurrentHeadScope` in `maintainer-inbox-service.ts`.

## GitHub write flows

Writes require a Fresh Review, explicit action, durable intent, and a read-only post-write reconciliation. Uncertainty locks, never replays.

- `automated:` `tests/services/pending-review-service.test.ts` (intent before write, no replay, ownership, submit only once), `tests/services/direct-summary-review-service.test.ts` (author approval blocked, uncertainty retained), `tests/services/published-feedback-service.test.ts` (confirmation + head recheck), `tests/services/inline-conversation-service.test.ts` (target ownership proofs, no full-conversation reads), `tests/services/write-invariants.test.ts` (the table-driven rule that every GitHub write persists intent before the remote boundary, and that every metadata write is an idempotent set operation), `tests/services/review-lock-invariants.test.ts` (every Review entry point waits for the coordinator lock, and no write re-enters the lock it already holds), `tests/renderer/use-pending-review-actions.test.ts` (the renderer's pending-review commands, journalling, busy state, and the recovery lock), `tests/renderer/use-direct-summary-actions.test.ts` (direct-summary submit, receipt override, and the outcome-unknown lock).
- `manual:`
  - Run Analysis, then use a Finding review command: the GitHub pending review must appear with exactly that finding, and the Analysis screen must expose the summary action.
  - Submit the pending review from the Finish review modal: one GitHub review must be published with the edited body.
  - Comment now from the diff: the comment must publish immediately while no pending review exists.
  - Resolve and unresolve a mapped conversation thread: the GitHub thread state must change.
  - Edit and delete an own published comment: must work with confirmation.
  - Delete or dismiss a comment you did not author: must be rejected.
- `run when:` anything changes in `pending-review-service.ts`, `direct-summary-review-service.ts`, `published-feedback-service.ts`, `inline-conversation-service.ts`, `review-write-gate.ts`, `use-pending-review-actions.ts`, `use-direct-summary-actions.ts`, or the GitHub adapter write methods.

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
  - Open a PR with review-attached comments (inline threads): the workbench must open, not stay silently on the Pull requests screen.
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

## Pull request metadata rail

The Conversation screen's rail owns the pull request's Reviewers, Assignees, and Labels. Every write gates on the current session (not diff freshness), resolves permission per write type, fails closed, and journals so a maintainer's own change never reads back as remote activity.

- `automated:` `tests/browser/conversation-rail.spec.ts` (the three pickers opening and toggling, the Assignees empty state and its self-assign shortcut, narrow-window stacking, the rail staying in view while the timeline scrolls, cached-avatar rendering with no remote `src`), `tests/browser/keyboard-operability.spec.ts` (the same three pickers and the self-assign shortcut reached and operated by keyboard alone), `tests/renderer/use-github-item-picker.test.ts` (the shared picker state machine: permission failing closed to `unknown`, optimistic attach and revert, stale-response ordering, debounced search, and a picker with no actions issuing neither read nor write), `tests/renderer/github-item-picker.rendering.test.tsx` (write-failure and read-failure alerts, the unconfirmed-account caveat, the truncation note), `tests/services/label-service.test.ts`, `tests/services/assignee-service.test.ts` (ten-assignee cap, self-assign), `tests/services/reviewer-service.test.ts` (subtractive removal, additive request), `tests/domain/review-verdicts.test.ts` (the verdict union, dropped drafts, outdated marking).
- `gap:` nothing tests the rail component itself. The browser tests that asserted its section composition (Reviewers above Assignees above Labels, absent outside the Conversation tab) and its Terminal read-only rendering were deleted as duplicates and have no replacement: `use-github-item-picker.test.ts` proves an actions-less picker is inert, but nothing proves the rail withholds those actions when the Review is Terminal. Permission rendering is not part of this gap — the two picker suites above own it. Until the rail gets its own test, the manual cases below are the only cover for section composition and Terminal read-only.
- `manual:`
  - Apply and remove a label from the rail against a real PR: GitHub must show the change, and the next refresh must not report it as remote activity.
  - Assign and unassign a person, and use the empty state's self-assign shortcut: GitHub must show the change.
  - Request a review, then toggle the same person off: the request must appear and disappear on GitHub, and a reviewer requested by someone else must survive the removal.
  - On a PR with an approval given before the latest push, confirm the verdict renders as outdated.
  - With an unfinished GitHub pending review open, confirm the Reviewers section shows it as a draft with its comment count and still shows every submitted verdict.
  - Sign in as a triage-only account: labels must stay editable while the reviewer and assignee controls report that the account cannot make the change.
- `run when:` anything changes in `label-service.ts`, `assignee-service.ts`, `reviewer-service.ts`, `review-verdicts.ts`, `pull-request-metadata-rail.tsx`, `use-github-item-picker.ts`, the three picker components, or the rail's routes in `src/main/routes/`.

## Browser, performance, and package

The built app is the outermost boundary.

- `automated:` `tests/browser/review-workbench.spec.ts` (workbench surfaces, Pierre CodeView scrolling and virtualisation, scroll-follow of the active file, navigator resize and persistence, diff theme switching, PR overview and header refresh), `tests/browser/review-diff-keyboard-nav.spec.ts` (`.`/`,` file jumps, `]`/`[` hunk jumps, `}` with no unresolved comments, and each of those keys typed into the comment composer instead), `tests/browser/keyboard-operability.spec.ts` (quick navigation, the Settings modal's trapped surface, Mermaid controls, the header refresh control), `tests/browser/protected-loopback-workflow.spec.ts` (loopback API through the bridge), `tests/browser/performance.spec.ts` (1,000 files, ~10 MB patch), package smoke (`pnpm test:package-smoke`), bundle check (`pnpm test:bundle`).
- `note:` there is no progressive diff-stream test because there is no diff stream. CodeView receives the whole file list at mount and virtualises it itself; the batching prefix and its test were deleted.
- `manual:`
  - Package a build (`pnpm package:mac`) and run the packaged app against a real PR: open, refresh, analysis, walkthrough, and one write flow.
  - In the packaged app, open the performance fixture and confirm the diff stays responsive.
- `run when:` anything changes in `src/renderer/src/`, `electron.vite.config.ts`, packaging, or the staged Flue runtime.

## Keeping the registry honest

- The automated column points at canonical tests, not the full suite. New flows get their canonical test here when they land.
- Every path and parenthetical here names a file that exists and a behaviour that file asserts. A change that deletes or moves a test updates this file in the same commit. When coverage is lost and not replaced, write a `gap:` line saying so — a registry that names a test which does not exist is worse than one that admits the hole.
- `AGENTS.md` ("Testing") decides which layer a new test belongs in. Add the test there first, then name it here.
- A manual case stays only while a human can run it in the dev app or the packaged app. If a code path removes the case, remove the manual entry.
- When a manual pass finds a bug, add a regression test first, then keep the manual case only if it still covers something the test cannot (visual, timing, or real-GitHub behavior).
