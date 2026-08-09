# Repair review findings in inline conversations and freshness scheduling

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds.

It starts from `cd36e32` on branch `fix/inline-conversation-freshness-repair` with the worker's uncommitted implementation already present. It repairs findings in that implementation; do not discard or rewrite unrelated worker changes. The preceding implementation plan is `.agents/tasks/unified-review-workbench/plans/2026-08-08-inline-conversation-freshness-and-performance-repair.md`.

## Purpose / Big Picture

After this repair, a just-created inline comment has only the actions Patchdesk can safely perform. It may be edited or deleted after GitHub confirms its comment id, but it cannot be replied to or resolved until an explicit refresh provides a real thread id. Returning to Patchdesk runs one quiet, delayed update check rather than duplicate checks. A detected remote update must not turn that detector into a request-speed loop, and no detector may run while an explicit refresh is pending.

The code will also make concurrent commands, remote receipts, and local-API request validation explicit instead of relying on booleans and casts. A maintainer can verify the result by creating a comment, seeing no Reply/Resolve controls before refresh, publishing feedback without a stale `Updates available` marker returning, and switching away from and back to the app without duplicate detector requests.

## Progress

- [x] 2026-08-09: Add failing regression tests for the three user-visible P1 defects.
- [x] 2026-08-09: Make inline conversation targets and receipt parsing explicit and safe.
- [x] 2026-08-09: Unify refresh invalidation and quiet detector scheduling.
  - `requestRefresh` helper now owns every `/v1/reviews/refresh` call and increments detector generation before the network request; toolbar `refresh` and `refreshConfirmedPublication` both route through it. `commandInFlightCountRef` replaces the single boolean; `runDirectCommand` keeps detection paused until every overlapping command finishes. One `scheduleFocusDetect` handles both `visibilitychange` and `focus` with a single 1.5s debounce. Tests: publication-refresh vs in-flight detector race (controlled promise), two overlapping commands, visibility+focus coalescing — all red before the fix, green after. Note: the publication drive needs fake timers + a polling dialog-mount loop (Base UI popup mounting is deferred under fake timers).
- [x] 2026-08-09: Consolidate request parsing, fake ownership behavior, and overlay state types.
  - `parseDirectConversationReceipt` codec added at the renderer boundary; all five command callbacks parse receipts and journal only from validated ones (malformed success = bounded failure). `/v1/reviews/detect-updates` route is now the sole parser (Valibot + `parseWorkspaceProfileId`/`parseReviewId`/`parseGitHubThreadId`); controller `detectUpdates` takes typed input; `readRecentReviewWrites` deleted. `FakeGitHubAdapter` target fixtures now carry the owning `PullRequestRef` and match owner/repo/number like production's `matchesPullRequest`; the fake also gained writer stubs so service-level ownership order is exercisable. Tests: fake same-PR/foreign-PR parity, foreign id never reaches a mutation, malformed create receipt journals nothing, two new journal 400 cases (`pending:local-1` thread id, non-string reviewId).
- [x] 2026-08-09: Run focused and full verification, then perform read-only Electron verification.
  - Full gate: `pnpm lint` clean; `pnpm typecheck` clean; `pnpm test -- --run` 938 passed / 1 skipped (119 files); `pnpm build` clean; `pnpm run test:a11y` 5 failed (same pre-existing set: dashboard flaky, workbench-fixture, walkthrough takeover, forced colors, 400% zoom); `pnpm run test:performance` 1 passed; `pnpm exec playwright test` 30-32 failed (flaky swing; same pre-existing set, no conversation-related failures); `git diff --check` clean.
  - Live read-only Electron verification: the running Dev app had a stale main process (baseline route expected `array(string())` journal while the new renderer sent typed entries, so every detect-updates returned 400). Restarted `pnpm dev -- --remote-debugging-port=9233` in the herdr dev tab; after restart detect-updates returns 200. Verified: freshness header shows `Current` + "Review state is current." (no `New version · ⌘R` copy), Diff navigator and diff-file hydration work, renderer console clean after reload (buffer contains only pre-restart HMR artifacts from mid-edit states). Screenshot: `/tmp/patchdesk-followup-live.png`.
- [x] 2026-08-09: Stop parent-render detector loops and exclude all explicit-refresh windows from detection.
  - `onWorkbenchPatchRef` now supplies the latest parent callback to `runDetect`; `runDetect` is dependency-free and the scheduling effect restarts only on Review status change, never on an App render. Positive detection patches freshness only on the transition into `updates_available` (re-writing the identical stale value is what turned an App render into another request). `refreshInFlightCountRef` (incremented synchronously in `requestRefresh`, decremented in `finally`) blocks new detector work for the whole network lifetime of every refresh, including the post-publication path that never sets toolbar refreshing state. Tests were red first: the parent-render test observed 4 requests where 2 were expected (the loop); the pending-publication-refresh test observed a detector firing during the refresh window. Both green after the fix.
  - Follow-up review found that `runDetect` depends on `onWorkbenchPatch`, while `App` recreates that prop inline when it renders. A positive detection calls the prop even when freshness already equals `updates_available`, which renders `App`, recreates `runDetect`, restarts the effect, and immediately sends another request. The existing generation check rejects old responses, but does not prohibit a detector that starts during a pending post-publication refresh.
- [x] 2026-08-09: Re-run the focused scheduler proof and complete browser acceptance after the remaining repair.
  - Focused scheduler proof: all eight scheduling/detection tests in `tests/renderer/review-workbench-flow.ui.test.tsx` pass (43 passed / 1 skipped in the file): initial+90s cadence, focus debounce, stale detector before refresh, publication-refresh race, overlapping commands, visibility+focus coalescing, parent-render loop, pending-refresh exclusion.
  - Full gate: `pnpm test -- --run` 940 passed / 1 skipped (119 files); lint, typecheck, build, `git diff --check` clean; performance 1 passed; a11y 5 failed (same pre-existing set); Playwright 33 passed / 30 failed — the identical 30-test pre-existing set (5 a11y, 7 design, 1 local-api-workbench, 1 protected-loopback, 16 review-workbench), no failures attributable to this repair.
  - Live Electron (read-only): after the renderer HMR'd the Milestone-3 flow changes, the app log shows exactly one `/v1/reviews/detect-updates` per 90-second tick (the pairs in the log are the same request logged by the http layer and the renderer api layer, same correlationId) and no duplicate on idle. Freshness header still `Current` + "Review state is current."; no new console errors.

- Milestone 1 (2026-08-09): `ConversationThreadTarget` union (`thread` | `comment_only`) added to `ReviewInlineAnnotation.conversationThread`; `CreatedThreadOverlay` is now a `sending | failed | published` union with `commentId` required only on `published`. `renderAnnotation` derives global Reply/state callbacks only for thread targets; the card reads its thread id from the target. Projected threads in `review-workbench.tsx` parse the wire string into `GitHubThreadId` at the annotation boundary and skip unparseable ids. New regression test passes all four conversation actions and asserts no Reply/Resolve control on a published create card (red before the fix: the Reply textarea was rendered via the global fallback). Commands: `pnpm test -- --run tests/renderer/review-diff-view.ui.test.tsx tests/renderer/conversation-thread-card.ui.test.tsx` (12 passed), `pnpm typecheck` (clean), `pnpm lint` (clean).

## Surprises & Discoveries

- Observation: the published create overlay intentionally omits reply and state callbacks, but the generic annotation renderer restores them from global conversation actions. The UI therefore presents Reply/Resolve against `pending:<localId>`.
  Evidence: `src/renderer/src/components/review-diff-view.tsx`, created overlay near lines 519–541 and callback fallback near lines 933–955.

- Observation: `refreshConfirmedPublication` calls the same `/v1/reviews/refresh` endpoint as normal refresh but does not increment detector generation first. A detector completion can therefore patch the old projection while a publication refresh is replacing it.
  Evidence: `src/renderer/src/flows/review-workbench-flow.tsx`, `refresh` near lines 265–291 and `refreshConfirmedPublication` near lines 293–306.

- Observation: five independently callable direct commands share one boolean in-flight flag. When two overlap, the first completion clears the flag while the second command continues.
  Evidence: `src/renderer/src/flows/review-workbench-flow.tsx`, direct command callbacks near lines 308–474.

- Observation: a focus regain may emit both `visibilitychange` and `focus`. The current visibility listener runs immediately while the focus listener schedules another call after 1.5 seconds.
  Evidence: `src/renderer/src/flows/review-workbench-flow.tsx`, detector listeners near lines 232–263.

- Observation: the local API validates the typed journal with Valibot, then the controller parses it again with a different implementation. The fake GitHub target reader also ignores its pull-request input.
  Evidence: `src/main/local-api.ts`, `src/services/review-workbench-controller.ts`, and `src/adapters/github/github-adapter.ts`.

- Observation: the intended 90-second detector cadence still depends on a callback identity owned by `App`. `App` passes `onWorkbenchPatch` as an inline function; `runDetect` depends on it; the scheduling effect depends on `runDetect`. On a positive result, `runDetect` calls that callback even when the projection already says `updates_available`, so the parent render immediately restarts the scheduling effect and sends another request.
  Evidence: `src/renderer/src/app.tsx` passes the inline callback near lines 519–531; `src/renderer/src/flows/review-workbench-flow.tsx` defines `runDetect` near lines 182–233 and starts it in the effect near lines 235–245.

- Observation: `requestRefresh` increments detector generation but only the toolbar caller sets React `refreshing` state. The post-publication caller leaves `refreshingRef` false, so a detector that starts after generation increments can overlap that refresh.
  Evidence: `src/renderer/src/flows/review-workbench-flow.tsx`, `runDetect` near lines 182–187 and `requestRefresh` / `refreshConfirmedPublication` near lines 274–311.

## Decision Log

- Decision: model a conversation card's target capability as a discriminated union, not as an inferred id string or a loose boolean.
  Rationale: a real comment id and a real thread id permit different write operations. A `comment_only` card must be structurally unable to inherit thread callbacks.
  Date/Author: 2026-08-09 / Codex.

- Decision: put every `/v1/reviews/refresh` call in one generation-invalidating helper, with callers choosing only their error presentation.
  Rationale: explicit refresh is one lifecycle operation regardless of whether it follows a toolbar click or publication. Separate wrappers already drifted.
  Date/Author: 2026-08-09 / Codex.

- Decision: use an in-flight command count for detector idleness, not a boolean and not an artificial global mutation lock.
  Rationale: direct commands may legitimately overlap; detection must wait until all of them complete without blocking unrelated UI controls.
  Date/Author: 2026-08-09 / Codex.

- Decision: one shared delayed-focus scheduler handles both `visibilitychange` and `focus`; it owns the single timer and coalesces duplicate browser events.
  Rationale: app return commonly emits both events. The product contract is one debounced observation, not one per browser event.
  Date/Author: 2026-08-09 / Codex.

- Decision: make local API route parsing the sole authority for the detection request. The controller receives a typed input, never raw JSON.
  Rationale: a single codec prevents the two validators from drifting and keeps untrusted input at the main-process edge.
  Date/Author: 2026-08-09 / Codex.

- Decision: detector scheduling is owned by stable Review identity and refs, not by a parent callback identity. A result may patch the projection only when its freshness value changes.
  Rationale: the cadence is a product promise. Parent renders are ordinary UI work and must not become detector triggers; repeatedly writing the identical stale value creates a feedback loop.
  Date/Author: 2026-08-09 / Codex.

- Decision: use a synchronous explicit-refresh in-flight count inside `requestRefresh`, including publication refreshes.
  Rationale: generation invalidation rejects old detector responses but does not stop new detector work. Counting covers every caller and overlapping refresh safely.
  Date/Author: 2026-08-09 / Codex.

## Outcomes & Retrospective

The plan is complete. All five milestones landed; the full Vitest gate is now 940 passed / 1 skipped (119 files) with lint, typecheck, build, and `git diff --check` clean. Browser acceptance is closed: the Playwright run retained exactly the same 30 pre-existing failures as the baseline (verified at `cd36e32` in the prior session; base passes only 13 of 63, the branch 33), and none of the eight scheduler/detection tests or the live Electron cadence shows a regression — the running app emits exactly one detect-updates request per 90-second tick after the Milestone-3 HMR. Live verification was read-only throughout; nothing was committed, pushed, or written to GitHub.

Retrospective: the fake-timer dialog drive needed a polling mount loop (Base UI popup mount is deferred under fake timers); the `runDirectCommand` generic arrow needed the TSX `<T,>` comma; the fixture model is not wire-valid so refresh/load responses in tests must be built from the `projection()` base. The shared `requestRefresh` helper fixes stale responses that started before refresh, but review showed that it needs an in-flight observation guard as well. Likewise, an effect can be locally debounced yet still loop if its callback dependency is recreated by a parent render.

## Context and Orientation

Patchdesk is a local-first Electron application. The renderer calls the capability-protected loopback API, which validates untrusted JSON before services operate on typed Review data. `ReviewWorkbenchFlow` owns the current Review projection, direct conversation requests, explicit refresh, and advisory remote detection. `ReviewDiffView` owns ephemeral cards layered over the immutable represented snapshot. `ReviewRefreshService.detect` may mark `Updates available`; only explicit refresh replaces represented GitHub state. `App` owns the projection state and passes callback props inline, so detector internals must read write callbacks through refs instead of treating their identity as a scheduling input.

The relevant direct-conversation path is:

    ReviewDiffView local card
      -> ReviewWorkbenchFlow direct command callback
      -> POST /v1/reviews/inline-conversations/command
      -> InlineConversationService
      -> ReviewWriteGate, exact-head read, ownership proof, GitHub mutation

The relevant refresh path is:

    toolbar, stale-marker button, or post-publication callback
      -> one guarded refresh helper
      -> POST /v1/reviews/refresh
      -> ReviewRefreshService.refresh
      -> canonical projection replacement

An ordinary renderer reload loads stored state and is not a GitHub refresh. Detection remains advisory for reads but a positive result pauses all GitHub writes.

## Plan of Work

Repair the user-visible safety defect first. Extend `ReviewInlineAnnotation` so `conversationThread` has an explicit `target` union. Existing projected threads use `{ _tag: "thread", id: GitHubThreadId }`; a successfully created-but-unrefreshed card uses `{ _tag: "comment_only", commentId: string }`. `renderAnnotation` may use global Reply and SetThreadState actions only for `thread`. It may use global Edit/Delete actions for either target, passing the authoritative comment id. This removes all dependence on strings such as `pending:<localId>`. Replace the loose `CreatedThreadOverlay` with `sending`, `failed`, and `published` union variants, making `commentId` required only for `published`.

Add a single `parseDirectConversationReceipt` function at the renderer boundary. It accepts `unknown` and returns only validated `CommentCreated`, `ReplyCreated`, `ThreadStateChanged`, `CommentEdited`, or `CommentDeleted` receipts. Use existing parsers for typed ids where available, otherwise require bounded non-empty string ids compatible with the existing local API command contract. `saveInlineComment`, reply, state, edit, and delete must append journal records only from a parsed success receipt; malformed or unexpected success payloads are treated as a bounded command failure and do not modify overlays or the journal.

Replace `commandInFlightRef: boolean` with `commandInFlightCountRef: number` and a small local `runDirectCommand` helper. Increment synchronously before starting each loopback request and decrement in `finally`, clamping neither count nor errors. `runDetect` proceeds only when the count is zero. Do not serialize user commands with this helper; it is an observation guard, not a write lock.

Extract one `requestRefresh` helper that increments generation before requesting `/v1/reviews/refresh`, parses a canonical workbench response, clears `detectedStaleFreshness`, and calls `replaceWorkbench`. It must return a `Result`-like success/failure value rather than swallowing errors. The toolbar/stale-marker `refresh` wrapper sets visible refreshing/error state around it. `refreshConfirmedPublication` uses the same helper and propagates its bounded error to its caller. This ensures every snapshot replacement invalidates old detector completions before the network request begins.

Replace separate focus and visibility execution with one `scheduleFocusDetect` callback. It checks `document.visibilityState`, clears an existing focus timer, and schedules `runDetect` after `FOCUS_DETECT_DEBOUNCE_MS`. Both listeners call it. The interval may cancel a pending focus timer and run once; `runDetect` still owns the in-flight and visibility checks. Initial mount performs one immediate visible check. A direct command completion does not schedule detection or alter the interval.

Complete the remaining scheduler repair in `src/renderer/src/flows/review-workbench-flow.tsx`. Store the latest `onWorkbenchPatch` in a ref during render and have `runDetect` call that ref; do not include the prop in `runDetect` dependencies. The detector effect must depend only on stable detector work plus the active Review identity/status, so replacing a projection for the same Review does not create an extra initial call. When `updatesAvailable` is true, patch only if current freshness is not already `updates_available`; when it is false, restore only if the current projection is stale. Add a `refreshInFlightCountRef` owned by `requestRefresh`: increment it synchronously before any `/v1/reviews/refresh` request, decrement in `finally`, and make `runDetect` return while it is non-zero. Do not use the toolbar-only React state as the protocol guard.

Move detection-request parsing to one main-process codec. The local API route validates profile/review ids and `RecentReviewWrite` through a strict Valibot schema plus `parseGitHubThreadId`, then calls a typed `ReviewWorkbenchController.detectUpdates({ profileId, reviewId, recentWrites })`. Delete raw JSON inspection from the controller. The controller's method type makes later non-HTTP callers explicit and testable.

Finally, make test doubles enforce the same ownership contract as production. Extend fake target fixtures with a full pull-request identity and return `found: false` when it differs from the requested active Review. This lets service tests prove that a reused id from another PR cannot reach a mutation.

## Milestones

### Milestone 1: Stop synthetic thread actions

Goal: a comment created through REST has no Reply or Resolve action until refresh represents a real thread.

Work: add a failing renderer test that passes all four global conversation actions to a `published` create overlay and asserts no Reply/Resolve control or command call. Convert target/overlay types and callback selection, then update existing pending/published/failed tests.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/renderer/review-diff-view.ui.test.tsx tests/renderer/conversation-thread-card.ui.test.tsx
    pnpm typecheck

Expected result: real snapshot threads retain actions; comment-only cards expose only Edit/Delete using their real comment id; neither `pending:` nor local ids appear in a loopback command.

This proves the original unusable-control regression cannot return through a fallback path.

### Milestone 2: Make refresh and detector ownership race-safe

Goal: every explicit refresh invalidates old detector work, and an app return runs one delayed detector request.

Work completed: introduce the shared refresh helper, command counter, and unified focus scheduler. Add controlled-promise tests for publication refresh racing an in-flight detector, two simultaneous direct commands, and combined visibility-plus-focus events.

Commands:

    pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx
    pnpm lint

Expected result: an old detector response cannot patch after either refresh entry point; detector count remains zero while any direct command runs; visibility and focus together result in exactly one request after 1.5 seconds.

This proves the performance reduction does not reopen a freshness race.

### Milestone 3: Close the remaining detector-cadence and refresh-exclusion gaps

Goal: an `Updates available` result is written once, never creates a request loop through `App`, and no detector starts while any toolbar or post-publication refresh is pending.

Work: in `src/renderer/src/flows/review-workbench-flow.tsx`, replace the `onWorkbenchPatch` dependency with a current-callback ref; keep `runDetect` stable across parent rerenders. Gate positive freshness patching on a transition into `updates_available`. Add `refreshInFlightCountRef` inside `requestRefresh` and consult it from `runDetect`. Update `tests/renderer/review-workbench-flow.ui.test.tsx` with controlled promises and fake timers:

1. Render a wrapper that recreates `onWorkbenchPatch` when it receives a stale patch; respond `updatesAvailable: true`; assert only one detect request occurs before advancing 90 seconds, then assert the next interval produces exactly one request.
2. Begin a publication refresh, then attempt a detector tick after the refresh generation has incremented but before the controlled refresh promise resolves; assert the detector sends no request.
3. Retain the earlier stale-detector-before-refresh test, so both "detector before refresh" and "detector attempted during refresh" are covered.

Commands:

    pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx
    pnpm typecheck
    pnpm lint

Expected result: no request is triggered merely because `App` renders, a stale response cannot trigger repeated work, and all refresh entry points exclude detector work for their full network lifetime.

This directly proves the 90-second policy and removes the known source of frequent `/v1/reviews/detect-updates` calls.

### Milestone 4: Tighten untrusted boundaries and test doubles

Goal: receipts and detection requests are parsed once, and fake ownership proof matches production behavior.

Work: add receipt codecs, use parsed receipts in all five command callbacks, consolidate route/controller detection parsing, and enrich `FakeGitHubAdapter` target fixtures. Add malformed-receipt, malformed-journal, same-PR, and foreign-PR tests.

Commands:

    pnpm test -- --run tests/services/inline-conversation-service.test.ts tests/adapters/github-adapter.test.ts tests/local-api-auth.test.ts tests/renderer/review-workbench-flow.ui.test.tsx
    pnpm typecheck

Expected result: malformed data changes no local state; one request parser accepts/rejects each journal shape; fake and real adapter semantics agree for foreign targets.

This proves safety checks are enforced at boundaries rather than trusted by convention.

### Milestone 5: Complete regression verification

Goal: the repaired worker change passes repository checks and the real Electron surface matches the deterministic tests.

Work: run the full suite and static/build checks. Attach to the existing Dev app only for read-only navigation, stale-marker refresh, and error inspection; do not invoke GitHub mutations.

Commands:

    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm run test:a11y
    pnpm run test:performance
    pnpm exec playwright test
    git diff --check

Expected result: static and full test gates pass. Any retained browser failure is reproduced and reported separately. Live Electron checks show one truthful refresh action and no invalid inline-thread actions.

## Concrete Steps

1. Confirm the worker diff remains available and record a new baseline only if it changed:

       git status -sb
       git diff --stat

2. In `src/renderer/src/components/review-diff-view.tsx`, define the target and overlay discriminated unions beside `ReviewInlineAnnotation`. Convert every constructor and test fixture in the same edit. Do not use a synthetic id as a substitute for a missing thread id.

3. In `renderAnnotation`, derive global `setThreadState` and `replyToThread` only when `target._tag === "thread"`. Retain per-card callbacks where present. Derive Edit/Delete from the real comment id, never from `target.id`.

4. Add `parseDirectConversationReceipt` in `src/renderer/src/flows/review-workbench-flow.tsx` or a nearby renderer-only API codec. Replace every `value as { ... }` receipt cast. Test malformed success envelopes for each callback before appending `RecentReviewWrite`.

5. Introduce `runDirectCommand` and an in-flight count in `ReviewWorkbenchFlow`; migrate create, reply, state, edit, and delete. Add a deferred-promise test with two commands where the first resolves first and detector remains blocked until the second resolves.

6. In `ReviewWorkbenchFlow`, assign `onWorkbenchPatch` to a ref during render. Make `runDetect` stable and call the ref rather than closing over the prop. Restrict its schedule effect to Review identity/status, not a changing parent callback. Before editing, add the parent-render regression test described in Milestone 3.

7. Patch only freshness transitions: a positive result may set `updates_available` only when the current projection is not already stale. Preserve the existing false-result recovery only for a currently stale projection.

8. Add `refreshInFlightCountRef` to `requestRefresh`; increment before the loopback request and decrement in `finally`. Make `runDetect` return while this count is non-zero. Cover toolbar and publication paths through the shared helper, including a detector that tries to start after refresh has begun.

9. Retain `scheduleFocusDetect` shared by focus and visibility listeners. Test `visibilitychange` then `focus`, advance fake timers by 1.5 seconds, and assert exactly one detection request.

10. Consolidate detection request parsing. Remove `readRecentReviewWrites` from `ReviewWorkbenchController`; make the local API codec return typed values and change controller tests/callers accordingly. Keep invalid input mapped to HTTP 400.

11. Expand `FakeGitHubAdapterValues.threadTargets` and `.commentTargets` to include pull-request identity. Test identical target ids scoped to different PR identities and assert foreign targets return `found: false`.

12. Run each milestone command immediately after its code slice. Update this plan's Progress and Artifacts with exact output. Do not commit, push, or perform a live GitHub write unless separately requested.

## Validation and Acceptance

- A published create card with all global conversation actions supplied has Edit/Delete controls but no Reply, Resolve, or Unresolve control. Clicking controls cannot send `pending:` or local ids to `/v1/reviews/inline-conversations/command`.
- A normal mapped GitHub thread still provides Reply and Resolve/Unresolve, and an owned reply still provides Edit/Delete.
- A detector started before either toolbar refresh or publication refresh never patches freshness afterward.
- An `updatesAvailable: true` response causes one transition into `updates_available`, not another request caused by the corresponding parent render. Before fake timers advance 90 seconds, the detector request count stays one.
- A detector attempt made after toolbar or post-publication refresh begins, but before its network response settles, sends no `/v1/reviews/detect-updates` request.
- Two overlapping direct commands keep detection paused until both complete.
- Returning to a visible focused app causes exactly one detector request after 1.5 seconds; no request occurs immediately from `visibilitychange`.
- A malformed command receipt does not append a journal record or show a confirmed local mutation.
- Invalid `recentWrites` returns HTTP 400 through one parser; valid entries reach `ReviewRefreshService.detect` as typed records.
- The fake adapter returns `found: false` for a target associated with another PR.

## Idempotence and Recovery

All commands are safe to repeat. Use fake timers and manually controlled promises for every race test; never use real-time sleeps. The live Electron check is read-only and does not post, reply, resolve, edit, or delete GitHub content. Keep the refresh guard as a count, not a boolean, so a second refresh cannot reopen detection when the first one completes.

If the target-union migration causes broad fixture errors, update all annotation constructors before changing behavior. Do not add an optional boolean compatibility field; it would allow the global callback fallback to reappear. Do not "fix" the detector loop by suppressing only the duplicate patch: the scheduling callback still must be independent of parent renders. If refresh callers require different error presentation, parameterize only the UI wrapper after the shared helper has already invalidated generation and raised the in-flight count. If a full browser suite remains red, retain the exact failure output rather than weakening the test.

## Artifacts and Notes

Review baseline, 2026-08-09:

    pnpm test -- --run [10 focused files]
    142 passed, 1 skipped

    pnpm typecheck
    passed

    pnpm lint
    passed

The initial review found eight defects: synthetic thread actions, publication-refresh stale detector race, overlapping-command tracking, unparsed renderer receipts, duplicate request parsing, impossible overlay states, PR-insensitive fake targets, and duplicate return-to-app detection. The follow-up review found two scheduler gaps: a parent-render request loop after `updatesAvailable`, and detector work permitted during a pending publication refresh.

Follow-up verification, 2026-08-09:

    git diff --check
    passed

    pnpm lint && pnpm typecheck
    passed

    pnpm test -- --run
    938 passed, 1 skipped (119 files)

    pnpm build
    passed

    pnpm exec playwright test
    10 failed artifacts; acceptance remains open pending attribution and repair

## Interfaces and Dependencies

- `ReviewInlineAnnotation["conversationThread"]` exposes a discriminated target: canonical GitHub thread versus comment-only receipt. Thread-only actions are impossible to attach to the latter.
- `CreatedThreadOverlay` is a `sending | failed | published` union. Only `published` includes `commentId`.
- `parseDirectConversationReceipt(value: unknown)` produces a typed direct-conversation receipt or `undefined`; no command callback casts raw JSON to a receipt.
- `runDirectCommand<T>(operation: () => Promise<T>): Promise<T>` maintains a non-negative in-flight count used only by `runDetect`.
- `onWorkbenchPatchRef.current: (patch: ReviewWorkbenchPatch) => void` supplies the latest parent callback without changing detector scheduling identity.
- `requestRefresh(): Promise<WorkbenchResponse>` or an equivalent typed result is the sole renderer owner of `/v1/reviews/refresh`, generation invalidation, and `refreshInFlightCountRef` lifetime.
- `ReviewWorkbenchController.detectUpdates` accepts a typed `{ profileId, reviewId, recentWrites }` input. `src/main/local-api.ts` owns JSON-to-type parsing.
- `FakeGitHubAdapterValues` target fixtures carry the owning `PullRequestRef` identity, preserving production's PR membership semantics.

Plan revised 2026-08-09 after follow-up review: added the parent-render detector-loop and in-flight-refresh findings, their exact test drives, and the current browser acceptance status.
