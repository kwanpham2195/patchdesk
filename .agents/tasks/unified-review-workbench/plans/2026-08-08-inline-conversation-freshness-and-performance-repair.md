# Repair safe, responsive inline conversations and truthful Review freshness

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds.

It starts from commit `cd36e32` on `main`. It is a follow-up to the completed unified-workbench repair plan; do not reopen or overwrite that plan. The repository has no `PLANS.md`.

## Purpose / Big Picture

After this work, a maintainer can create, reply to, resolve, edit, and delete an inline GitHub conversation without Patchdesk accepting a target from another pull request. Controls react immediately and truthfully while the remote command is pending, without turning a failed create into a usable synthetic thread. A multi-line conversation appears after its final anchored line, and the maintainer's own replies have the same edit and delete controls as the opening comment.

The Review will also distinguish a real remote change from this window's own writes without hiding another reviewer's reply. `New version` will name and invoke the real explicit refresh action instead of implying that reloading the Electron renderer refreshes GitHub. Background update detection will remain an advisory, write-blocking signal but will not be restarted immediately after every conversation receipt or allowed to overwrite a newer explicit refresh result. The local Logs panel will resume exactly after the last returned entry.

The visible proof is: open a Review, use the explicit refresh control, and see the update marker clear only after the GitHub snapshot is replaced; then verify that direct-conversation controls remain guarded, responsive, correctly located, and that an external reply still causes `Updates available` before a subsequent write.

## Progress

- [x] 2026-08-08: Establish a failing-test and command-count baseline without sending a GitHub write.
- [x] 2026-08-08: Replace the untyped write journal and repair freshness comparison and detector scheduling.
- [x] 2026-08-08: Add narrow active-Review ownership proofs for every direct conversation target.
- [x] 2026-08-08: Repair the renderer's refresh affordance, optimistic states, card placement, and reply controls.
- [x] 2026-08-08: Repair the log-tail cursor and add operation timing that is safe to persist.
- [x] 2026-08-08: Run focused, full, browser, build, accessibility, performance, and live read-only verification; record any pre-existing browser failures separately.

## Surprises & Discoveries

- Observation: an inline create makes a REST write and then synchronously scans GraphQL `reviewThreads(first:100)` before returning its receipt. The GraphQL declaration includes `$id` but does not use it, so GitHub rejects the lookup and the returned card has no usable thread id.
  Evidence: `src/adapters/github/github-adapter.ts`, `GitHubAdapter.createInlineComment`.
  Resolution: the lookup was dead code that always failed (GitHub rejects unused variables); it cost an extra CLI spawn per create and has been removed with the thread-id path.

- Observation: a direct conversation command already performs a freshness gate and exact-head read. Edit and delete then read all pull-request threads to prove ownership; reply and state change do not prove target membership at all.
  Evidence: `src/services/inline-conversation-service.ts`, `InlineConversationService.execute` and `ownedComment`.
  Resolution: bounded single-node GraphQL ownership proofs (`getReviewThreadTarget` / `getReviewCommentTarget`); Reply/SetThreadState/Edit/Delete now prove PR membership (and authorship for edit/delete) before any mutation.

- Observation: the detector runs on initial render, every 30 seconds, and again whenever `recentWrites` changes. Its comment reader can page a large conversation, so it can contend with the next CLI-backed GitHub operation even though a button handler does not await it.
  Evidence: `src/renderer/src/flows/review-workbench-flow.tsx`, `detectUpdates` and its effect; `src/services/review-refresh-service.ts`, `detect`.
  Resolution: 90-second interval with visibility/focus/in-flight preconditions; direct receipts only append the typed journal.

- Observation: renderer reload loads the stored projection; it does not call `/v1/reviews/refresh`. The displayed update badge currently says `New version · ⌘R to reload`, while the actual snapshot replacement is only `PR overview → Refresh GitHub state`.
  Evidence: `src/renderer/src/components/review-workbench.tsx` and `src/renderer/src/components/pr-overview-sheet.tsx`; `src/services/review-workbench-controller.ts`.
  Resolution: the badge is now `Updates available` plus a `Refresh GitHub state` button wired to the real refresh action, with pending/disabled states.

- Observation: the current journal filters a whole thread when a thread id is present. This hides an external reply in that thread on both sides of the fingerprint, which can incorrectly clear the write block.
  Evidence: `src/services/review-refresh-service.ts`, `withoutRecentWrites`; regression gap in `tests/services/review-refresh-service.test.ts`.
  Resolution: typed journal with per-comment masking and asymmetric thread-state normalization; external replies and external state changes in a locally touched thread are detected.

- Observation: `AppLogService.tail` uses an exclusive `seq > after` filter but returns the next sequence to allocate. A consumer that reuses that value skips the first entry written after a poll.
  Evidence: `src/services/app-log-service.ts`, `tail`.
  Resolution: `nextAfter` cursor = last delivered sequence (or the supplied cursor when empty); panel, local API, and tests updated together.

- Discovery: `PullRequestReviewComment` exposes `pullRequest` and `viewerDidAuthor` (schema docs); `PullRequestReviewThread` does not expose PR identity directly, so the thread proof reads the thread's first comment (bounded `first: 1`).

- Discovery: live Electron QA against the existing Dev app (CDP 9233) showed the new badge/refresh button immediately (HMR); a read-only explicit refresh replaced the projection (`refreshed` timestamp advanced) and cleared the marker. Console history contains transient HMR errors from mid-edit states (`useRef is not defined`) that the error boundary recovered from; current source has no such issue.

- The repository has no user-facing changelog file; per plan, recorded instead of editing one.

## Decision Log

- Decision: retain explicit refresh as the only operation that replaces represented GitHub state; do not make Electron reload an implicit remote refresh.
  Rationale: the approved lifecycle requires a stable review surface and says detection may only set `Updates available`.
  Date/Author: 2026-08-08 / Codex.

- Decision: replace `recentWrites: string[]` with typed, operation-specific journal entries at the local API and service boundary.
  Rationale: an untyped id cannot distinguish a comment, submitted review, or thread-state mutation, which caused the whole-thread masking regression. The journal must preserve external content while masking only the app's expected difference.
  Date/Author: 2026-08-08 / Codex.

- Decision: require a narrow, PR-scoped target proof for reply, state, edit, and delete before the GitHub mutation. The proof must also establish viewer authorship for edit/delete.
  Rationale: parser-valid GitHub node ids are not proof that the target belongs to the active Review. The existing full-conversation scan is both overbroad and slow.
  Date/Author: 2026-08-08 / Codex.

- Decision: do not expose reply or resolve on an optimistic create until a canonical thread id has been observed. Show the create as pending immediately, then reconcile it from a real receipt or the next represented snapshot.
  Rationale: a temporary `optimistic:<commentId>` value is not a GitHub thread id and must never reach a write command.
  Date/Author: 2026-08-08 / Codex.

- Decision: remove the post-create `reviewThreads(first:100)` lookup from `GitHubAdapter.createInlineComment`; do not replace it with another background scan. A successfully created comment without a canonical thread id remains editable/deletable by its real comment id, while Reply and Resolve become available only after explicit refresh has represented the real thread.
  Rationale: GitHub's REST create receipt has no thread id. A partial thread scan is both slow and incomplete; it does not provide a sound capability for the next mutation.
  Date/Author: 2026-08-08 / Codex.

- Decision: coalesce detector work after local conversation receipts instead of coupling a receipt to an immediate full detection pass. Detect once when an open Review becomes visible, then at most every 90 seconds while it remains visible and idle; request one debounced check when the app regains focus. Invalidate stale detector responses when a refresh replaces the projection.
  Rationale: this is quieter and reduces GitHub/CLI contention. Explicit refresh and the exact-head write gate remain the safety boundary; a positive detection still blocks later writes.
  Date/Author: 2026-08-08 / Codex.

## Outcomes & Retrospective

Milestone results, run from `/Users/kwanpham/Work/cfw/patchdesk` on `fix/inline-conversation-freshness-repair` (baseline `cd36e32`):

- Milestone 1 (failing tests): 16 failing tests across 7 files captured the reported defects (ownership proofs, journal masking, cursor, scheduler, reply controls, single-command create). Browser baseline at base commit: `playwright` 13 passed / 50 failed; a11y 5 failed (pre-existing).
- Milestone 2 (ownership + create state machine): `pnpm test -- --run tests/adapters/github-adapter.test.ts tests/services/inline-conversation-service.test.ts tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx` — green. `pnpm typecheck` — clean.
- Milestone 3 (journal + scheduler + refresh UI): `pnpm test -- --run tests/services/review-refresh-service.test.ts tests/local-api-auth.test.ts tests/desktop-bridge.test.ts tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx` — green. `pnpm run test:a11y` — same 5 pre-existing failures as base.
- Milestone 4 (full gates): `pnpm lint` clean; `pnpm typecheck` clean; `pnpm test -- --run` 929 passed / 1 skipped (119 files); `pnpm build` clean; `pnpm run test:a11y` 5 failed / 5 passed (identical failure set to base commit, verified via git worktree at `cd36e32`); `pnpm run test:performance` 1 passed; `pnpm exec playwright test` 33 passed / 30 failed on this branch vs 13 passed / 50 failed at base (strictly fewer failures; spot-checked `local-api-workbench.spec.ts` failure reproduces identically at base — pre-existing); `git diff --check` clean.
- Live read-only Electron verification (existing Dev app, CDP 9233, normal profile): the header badge showed `Updates available` + `Refresh GitHub state` (no ⌘R wording). Clicking it showed `Refreshing…` (disabled), then the marker cleared and `refreshed` advanced from `2026-08-08T05:21:32.485Z` to `2026-08-08T20:21:48.526Z` with freshness `Current`. No write, reply, resolve, edit, or delete was performed. Screenshot: `/tmp/patchdesk-refresh-proof.png`. Console history contains only transient HMR errors from mid-edit states, recovered by the error boundary.
- Remaining GitHub API limitation: the REST create receipt carries no thread id, so Reply/Resolve on a freshly created card stay disabled until an explicit refresh represents the real thread. This is now the intended, tested behavior.
- No user-facing changelog exists in the repository; none was added.

Retrospective: the fix order (tests → typed journal → ownership proofs → renderer → scheduler → cursor) worked well; the only friction was jsdom testing (RTL `waitFor` hangs under Vitest fake timers without a global `jest`; Pierre's FileDiff gutter needs seeded `dataset.lineNumber`/`lineSide` because jsdom cannot produce hover state; `act` wrappers needed around timer advances for panel polling).

## Context and Orientation

Patchdesk is a local-first Electron application. The renderer calls a capability-protected loopback API. `src/main/local-api.ts` parses those requests and composes services. `src/services/` owns Review state, freshness, and write gates. `src/adapters/github/github-adapter.ts` invokes `gh api`; it is the only layer that should know GraphQL and REST command details. `src/domain/` contains validated ids and pure Review invariants.

A Review has an immutable session pinned to a pull-request head. `ReviewRefreshService.detect` compares a fresh, lightweight-enough remote observation against the stored represented snapshot. Detection is advisory for reading but write-blocking. `ReviewRefreshService.refresh` is the explicit operation that replaces that snapshot and clears a detected-update marker through `moveReviewToSession`. `ReviewWriteGate.requireFresh` plus an exact-head read are required immediately before every GitHub write.

The direct conversation path is:

    ReviewDiffView / ConversationThreadCard
      -> ReviewWorkbenchFlow requestJson("/v1/reviews/inline-conversations/command")
      -> local-api route
      -> InlineConversationService.execute
      -> ReviewWriteGate + GitHubAdapter
      -> gh api REST or GraphQL

The important current files are:

- `src/services/inline-conversation-service.ts`: command validation, freshness, ownership, and receipts.
- `src/adapters/github/github-adapter.ts`: GitHub reads and direct conversation mutations.
- `src/services/review-refresh-service.ts`: refresh, detection, and fingerprint normalization.
- `src/services/review-workbench-controller.ts` and `src/main/local-api.ts`: request schemas and projection routes.
- `src/renderer/src/flows/review-workbench-flow.tsx`: requests, local optimistic state, and detector scheduling.
- `src/renderer/src/components/review-workbench.tsx`, `pr-overview-sheet.tsx`, and `review-diff-view.tsx`: user-visible refresh and thread UI.
- `src/services/app-log-service.ts` and the Logs-panel consumer: in-memory polling cursor.

The active constraints are non-negotiable: preserve a single Review, do not replace remote state from detection, keep known updates write-blocking, do not weaken the renderer sandbox, and do not send live GitHub writes during verification. `docs/adr/0001-manual-github-refresh.md` and `.agents/skills/patchdesk-review-lifecycle/SKILL.md` are the governing behavior.

## Plan of Work

First, turn every reported failure into a deterministic test. Start with a no-write trace using a fake `CommandRunner` or GitHub gateway and renderer request spies. Count gateway calls and record elapsed operation spans without recording command arguments, bodies, tokens, repository paths, or raw output. Run the existing Playwright suite once before implementation and retain its exact nine failures as baseline evidence; do not hide them by loosening assertions.

Next, make direct conversation writes both safe and narrow. Add PR-scoped read operations to the GitHub reader interface that accept an already parsed target id and return only the information `InlineConversationService` needs: target found, target's active-pull-request membership, and for comment mutation viewer authorship. Implement them with a bounded GraphQL node/connection query only after a read-only schema/fixture proof shows how GitHub relates the node to its pull request. The query must use every declared variable, have a small explicit page bound, and return `not_found` or `permission_denied` rather than accepting an unproven target. Do not fall back to loading all threads. Keep `ReviewWriteGate.requireFresh` and exact-head verification before this target proof and mutation.

For create, remove the invalid `$id` query and the entire post-create `reviewThreads` scan immediately. The implementation must not block the first visible optimistic state on a thread scan or start a replacement background scan. Leave reply and resolve action-disabled until the next explicit authoritative refresh maps the real thread. The direct-write response must never contain a synthetic id in a field parsed as a GitHub thread id.

Replace the string journal with a discriminated union such as `RecentReviewWrite`: comment create/reply/edit/delete identifies a comment and optional submitted review; thread-state change identifies a thread and requested state. Pass validated entries through the local API, workbench controller, flow, and refresh service. Normalize both compared snapshots operation by operation: omit only the known app-authored comment/review records; for an app thread-state change, normalize the state of that one thread while retaining all of its comments. Remove an empty thread only after its individual journaled comments are gone. Therefore an external reply, edit, or different review record in that thread remains a fingerprint difference and keeps writes blocked.

Repair detector scheduling and response ownership at the renderer boundary. Give each Review projection a monotonically increasing observation generation. Capture the generation when a detector begins and ignore its response unless the same Review/session/projection is still current. Explicit refresh increments the generation, clears the journal, replaces the canonical projection, and only then permits the regular scheduler to observe again. Detect once when an open Review becomes visible, then at most once every 90 seconds while the document remains visible and idle. A direct receipt appends a typed journal entry but does not trigger a check; app focus regaining requests one debounced check, coalesced with the next scheduled check. Do not turn detector failure into a stale marker or a snapshot replacement.

Repair the renderer in the same slice. Replace the misleading `⌘R` wording with an accessible `Refresh GitHub state` action wired to the existing explicit refresh callback, either in the status marker itself or alongside it. It must show pending and bounded failure copy, preserve focus, and retain the terminal/freshness disabled states. Model each inline mutation as pending, succeeded/reconciled, or failed/rolled back. Create a reusable authored-comment row so opening comments and replies receive the same Edit/Delete behavior. Map cards for ranges to their `end` line in both code-view paths. Build file-to-annotation indexes and stable card keys where measurements show the existing repeated filtering or broad JSON key is on the post-receipt critical path; do not optimize speculatively before the trace proves it.

Finally, make logs reliable and make the proof visible. Replace the ambiguous `nextSeq` response with a cursor whose value is the sequence of the last returned entry (or preserves the supplied cursor when no entry was returned); update the local API contract, Logs panel, and tests together. Add safe command-operation duration fields to the app log only if the baseline cannot otherwise identify latency. The log event names may identify a logical operation such as `github.inline_reply`; they must never contain raw `gh` arguments, text bodies, ids, tokens, URLs, prompts, or diagnostics.

## Detailed Implementation Blueprint

### 1. Typed write journal and exact fingerprint rules

Define and export `RecentReviewWrite` beside `ReviewRefreshService` (or in a small domain module if more than that service and the controller import it). Do not put the union in a renderer component. The exact initial shape is:

    type RecentReviewWrite =
      | {
          readonly _tag: "Comment";
          readonly commentId: string;
          readonly reviewId?: string;
        }
      | {
          readonly _tag: "ThreadState";
          readonly threadId: GitHubThreadId;
          readonly state: "open" | "resolved";
        };

Use exactly one `Comment` entry per create or reply receipt, including `reviewId` when GitHub returned it. Use one `Comment` entry for edit and delete with no review id. Use one `ThreadState` entry for resolve or unresolve. Preserve entry order and deduplicate only exact equivalent entries so a later state command for the same thread does not accidentally mask a different state.

`/v1/reviews/detect-updates` remains renderer-callable only through the existing per-launch capability, but its body is still untrusted. Replace `reviewUpdateSchema` and `readOptionalStringArrayField` with a strict Valibot discriminated-union array. Validate a thread id with `parseGitHubThreadId`; reject malformed entry fields with the route's existing `invalid_input` response. Comment and submitted-review ids remain bounded non-empty strings because GitHub currently returns both node ids and numeric REST ids. Do not preserve the old `recentWrites: string[]` wire format or add a compatibility parser.

Implement one pure helper that receives the represented and candidate `GitHubComments` together, plus the journal, and returns the two normalized collections. It must follow these rules in this order:

1. Build `commentIds`, `reviewIds`, and `latestThreadStateById` from the journal. `reviewIds` applies only to published-feedback normalization.
2. For comments, remove a comment whose id is in `commentIds` from both snapshots. Only remove a thread after its filtered comment list is empty. This preserves a second, external comment in the same thread.
3. For a journaled state mutation, force the represented thread's state to the requested state. Leave the candidate thread state unchanged. Thus the successful local change no longer differs, but a later external state change differs and blocks writes. This deliberately prefers a false stale signal during GitHub propagation over a false fresh signal.
4. For published feedback, remove only the journaled submitted review and journaled comment records from both sides. Keep any other review or comment, even if it shares a thread with the app's comment.
5. Apply the existing viewer-metadata and volatile-timestamp omission only after these transformations. Continue to hash only fields that the detection pass actually loaded.

Add a short code comment above the state-pair rule explaining why it is intentionally asymmetric. This is previously buggy, safety-sensitive behavior.

### 2. Target ownership proof and GitHub adapter boundary

Add two required `GitHubReader` methods, implemented by both `GitHubAdapter` and `FakeGitHubAdapter`. Use explicit result unions so an absent or foreign target is a completed read, not an adapter error:

    type GitHubThreadTarget =
      | { readonly found: true }
      | { readonly found: false };

    type GitHubCommentTarget =
      | { readonly found: true; readonly viewerDidAuthor: boolean }
      | { readonly found: false };

    getReviewThreadTarget(input: {
      readonly profile: WorkspaceProfileConfig;
      readonly pr: PullRequestRef;
      readonly threadId: GitHubThreadId;
    }): Promise<Result<GitHubThreadTarget, GitHubReadFailure>>;

    getReviewCommentTarget(input: {
      readonly profile: WorkspaceProfileConfig;
      readonly pr: PullRequestRef;
      readonly commentId: string;
    }): Promise<Result<GitHubCommentTarget, GitHubReadFailure>>;

The adapter must treat a missing node, an unexpected node type, no first comment on a thread, or a target associated with another repository/PR as a successful read whose `found` result is false. If the existing `Result` shape cannot represent that without abusing an error category, define a small target-result union instead. Do not disclose whether a foreign target exists to the renderer; `InlineConversationService` maps every non-member target to its existing `not_found` failure.

Use a single-node GraphQL query for each proof. The thread query reads only the first thread comment and the comment's pull-request identity. The comment query reads the comment's pull-request identity and `viewerDidAuthor`. Compare the returned owner, repository, and number with `PullRequestRef` inside the adapter, not in the renderer or service. The query must have only an `$id: ID!` variable and must return no body, URL, author, or other conversation content. Before coding the parser, add adapter fixtures for node absent, wrong node type, same PR, other PR, and a non-author comment. If the GitHub schema selection used by the fixture is rejected in a read-only real-schema check, record the exact error and use the smallest equivalent node selection; never revert to `getPullRequestComments`.

`InlineConversationService.execute` must use this fixed order:

    validate command fields
    -> ReviewWriteGate.requireFresh
    -> getPullRequest and exact head comparison
    -> target proof for Reply / SetThreadState / EditComment / DeleteComment
    -> viewer authorship check for EditComment / DeleteComment
    -> the one matching mutation

Create has no target proof because its coordinates are bound to the gated active Review. The service must perform exactly one mutation or none. A target proof failure invokes no mutation; a proof read failure maps to `github_read_failed`; a non-author maps to `permission_denied`; and a non-member target maps to `not_found`.

Remove the second command from `GitHubAdapter.createInlineComment` entirely. Its only remote call is the REST create. Return `commentId` and optional `reviewId`, never `threadId`. Delete the old test that expects `reviewThreads(first:100)` and replace it with a test asserting exactly one command, no GraphQL `$id` declaration, and graceful UI behavior when the receipt lacks `threadId`.

### 3. Direct-conversation renderer state machine

Keep transient display state in `ReviewDiffView`; it is closest to the composer and existing `createdThreads`, `resolvedThreads`, `editedBodies`, and `deletedCommentIds` overlays. Do not claim that transient state is authoritative remote data.

Replace the current created-thread entry with a local-only state machine:

    type CreatedThreadOverlay = {
      readonly localId: string;
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly side: "new" | "old";
      readonly body: string;
      readonly status: "sending" | "published" | "failed";
      readonly commentId?: string;
    };

When the user submits the inline composer, allocate `localId` before awaiting `LocalCommentAuthoring.onSave`, add a `sending` overlay, then clear the composer. On a `CommentCreated` receipt, replace the same local entry with `published` and its real `commentId`. On rejection, replace it with `failed`; it has no GitHub controls and offers only dismiss plus bounded text directing the maintainer to refresh GitHub before deliberately composing a new comment. Do not add direct retry: a timeout or transport failure may have created the comment, and retry could duplicate it.

The `sending` and `failed` card must not pass `onReply`, `onSetState`, `onEditComment`, or `onDeleteComment` to `ConversationThreadCard`. A `published` create without a thread id may pass only Edit/Delete for its real viewer-authored `commentId`; it may not pass Reply/Resolve. Existing snapshot threads retain all applicable callbacks because their `thread.id` is canonical. This is the enforcement point that prevents any `optimistic:*` value reaching `parseInlineConversationCommand`.

For reply, retain the existing pending button state, but extend the local reply overlay to store the real returned `commentId`. Render replies through one reusable `ConversationComment` row shared by opening comments, represented replies, and optimistic published replies. The row accepts `viewerDidAuthor`, `onEdit`, and `onDelete`; this makes Edit/Delete reachable for every authored reply. A successful edit updates the appropriate local overlay/body map. A successful delete removes the appropriate local overlay/comment map. A failure leaves the previous display state unchanged and shows the existing bounded error. Do not make an optimistic mutation look confirmed before its receipt.

Move range-card anchoring in every `DiffLineAnnotation` construction from `annotation.start` to `annotation.end`; preserve `start` in metadata for title/context. Add an explicit test that verifies the virtualized item data and the non-virtualized rendering path separately.

### 4. Detector scheduler and explicit refresh

Keep the journal in `ReviewWorkbenchFlow`, but hold its latest value in a ref so a scheduled request uses the current entries without recreating the interval. Implement these constants in the flow module:

    const DETECT_INTERVAL_MS = 90_000;
    const FOCUS_DETECT_DEBOUNCE_MS = 1_500;

Maintain refs for the latest workbench projection, a snapshot key, generation, in-flight request, and pending focus timer. The snapshot key is `${review.id}:${session.id}:${revision.reviewedHeadSha}:${revision.refreshedAt}`. Increment generation whenever that key changes. Before beginning a detector request, require all of: Review open, `document.visibilityState === "visible"`, no refresh in progress, no direct conversation command in progress, and no detector request already in flight.

On mount and on an invisible-to-visible transition, schedule the initial/focus path. While visible, use a 90-second interval that skips rather than queues when the preconditions are not met. On `window.focus`, schedule exactly one request after 1.5 seconds; if the interval fires first, clear the pending focus timer and make only one request. A direct command only appends its typed journal receipt and does not schedule or reset a detector. Clear the interval and focus listener/timer on unmount.

Capture `{generation, snapshotKey}` before calling `/v1/reviews/detect-updates`. On completion, patch freshness only if both still equal the latest refs. Build the patch from the latest projection ref, not the closure captured by the request. Explicit refresh increments the generation before its request, then on success clears the journal and replaces the projection. Therefore an older detector completion cannot write `updates_available` into the newly refreshed Review. Detection exceptions remain silent/advisory; refresh exceptions remain visible bounded errors.

Replace `New version · ⌘R to reload` with a button named `Refresh GitHub state`. It calls the existing `refresh` callback, uses the existing refreshing/error state, and is disabled while refresh is in progress or when the Review is terminal. Do not bind or advertise ⌘R as GitHub refresh. Ensure the compact status text still explains that direct GitHub writes are paused until refresh.

### 5. Log cursor contract

Rename the tail response field from `nextSeq` to `nextAfter`. Define it as `slice.at(-1)?.seq ?? after`. Omit it when both the request has no `after` and the returned slice is empty. The client stores this field as `afterSeq` and sends it unchanged as the next query parameter. The endpoint's filter remains exclusive: `entry.seq > after`.

This means an initial response containing entries 2, 3, and 4 returns `nextAfter: 4`; if entry 5 arrives before the next poll, `?after=4` returns entry 5. When a poll has no entries, the client retains its prior cursor. If the ring buffer discarded older entries, the first retained entry still resumes normally, and the UI may display a bounded gap rather than silently inventing missing logs.

## File-by-File Edit and Test Map

- `src/adapters/github/github-adapter.ts`: add the two target-proof reader methods, query constants, bounded parsers, and Fake adapter behavior; remove create's post-write thread scan and unused GraphQL variable.
- `src/services/inline-conversation-service.ts`: change `Gateway`, add proof checks in the fixed order, and remove `ownedComment`'s full-conversation read.
- `src/services/review-refresh-service.ts`: export the journal union; replace string-set filtering with pair normalization and documented asymmetric thread-state handling.
- `src/services/review-workbench-controller.ts` and `src/main/local-api.ts`: parse and forward the strict journal union; retain capability checks and existing safe error mapping.
- `src/renderer/src/flows/review-workbench-flow.tsx`: send typed receipts, own the 90-second/focus-aware generation scheduler, and expose the existing explicit refresh callback to the status UI.
- `src/renderer/src/components/review-workbench.tsx` and `src/renderer/src/components/pr-overview-sheet.tsx`: make the existing refresh action discoverable from the stale marker without duplicating refresh logic.
- `src/renderer/src/components/review-diff-view.tsx`: implement the local create overlay state machine, callback gating, reusable reply rows, and end-line anchoring.
- `src/services/app-log-service.ts`, `src/main/local-api.ts`, and `src/renderer/src/components/logs-panel.tsx`: change `nextSeq` to the exclusive-resume `nextAfter` / `afterSeq` contract.

- `tests/adapters/github-adapter.test.ts`: assert target-proof query shape, same/foreign PR parsing, viewer authorship, and exactly one REST command for create.
- `tests/services/inline-conversation-service.test.ts` (new): assert the fixed call order, zero mutation calls for foreign targets/non-authors/read failures, and no `getPullRequestComments` dependency.
- `tests/services/review-refresh-service.test.ts`: cover each journal variant plus the external reply and external state-change cases within a locally changed thread.
- `tests/renderer/review-workbench-flow.ui.test.tsx`: use fake timers and controlled promises to cover initial, 90-second, focus, direct-receipt, refresh-generation, and stale-marker action behavior.
- `tests/renderer/review-diff-view.ui.test.tsx` and `tests/renderer/inline-conversation-mapping.test.ts`: cover sending/published/failed cards, synthetic-id callback omission, authored reply controls, reply edit/delete overlays, and both range placement paths.
- `tests/services/app-log-service.test.ts`, `tests/local-api-logs.test.ts`, and a new `tests/renderer/logs-panel.ui.test.tsx`: cover initial tail, empty tail, one entry between polls, cursor rename, and no duplicate append.

## Milestones

### Milestone 1: Make the failures observable before changing behavior

Goal: prove the reported bugs and establish the direct-command call shape without writing to GitHub.

Work: add failing service and renderer tests for the unused GraphQL variable, cross-PR reply/state rejection, external reply within a journaled thread, end-line placement, reply ownership controls, exclusive log cursor, 90-second/focus-aware detector scheduling with no direct-receipt detection, and stale detector result after explicit refresh. Instrument fake adapters with operation names and counters. Run the browser suite once to capture the current failures.

Commands, from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/services/inline-conversation-service.test.ts tests/services/review-refresh-service.test.ts tests/services/app-log-service.test.ts tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx
    pnpm exec playwright test

Expected result: new tests fail only for the reported defects; the Playwright output records the starting failures rather than being treated as a pass. The fake trace documents the current full-comment read and post-create lookup.

This reduces risk because later performance claims have a repeatable, no-network comparison and safety regressions are locked in before refactoring interfaces.

### Milestone 2: Prove ownership narrowly and make local writes visible safely

Goal: every target-based command has active-Review ownership proof, without full-thread reads, and a create never enables actions on an invented id.

Work: add typed target-proof results and narrow GitHub reader methods; implement bounded GraphQL parsing; remove the unused variable; update `InlineConversationService`; add typed receipts and pending states in `ReviewWorkbenchFlow` and `ReviewDiffView`. Ensure a negative proof returns a safe service failure before mutation. Ensure a new create card is visible immediately but has reply/state disabled until it has a canonical id.

Commands:

    pnpm test -- --run tests/adapters/github-adapter.test.ts tests/services/inline-conversation-service.test.ts tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx
    pnpm typecheck

Expected result: tests prove foreign thread ids never reach `createThreadReply` or `setReviewThreadState`; foreign/non-authored comment ids never reach edit/delete; every GraphQL query has matching declared and supplied variables; fake command counts show no full `getPullRequestComments` read for a direct target operation.

This reduces risk because a performance improvement cannot accidentally create a cross-pull-request write capability.

### Milestone 3: Preserve remote truth and make freshness action understandable

Goal: Patchdesk ignores only its own expected changes, preserves external activity, and makes explicit refresh the only visible way to apply remote state.

Work: migrate the detection request schema and all typed consumers from string ids to journal entries; normalize comments, review feedback, and thread state as described above; add generation/cancellation guards and coalesced scheduling; replace the status-marker copy/action; add the range-card and reply-control fixes.

Commands:

    pnpm test -- --run tests/services/review-refresh-service.test.ts tests/local-api-auth.test.ts tests/desktop-bridge.test.ts tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx
    pnpm run test:a11y

Expected result: a local resolve followed by an external reply yields `updatesAvailable: true`; the same resolve without external change does not self-flag; an old detector response cannot reapply `New version` after refresh; the status action performs `/v1/reviews/refresh`, not a renderer reload; a range ending at line 12 renders after line 12; authored replies expose Edit and Delete.

This reduces risk because the write-block invariant is proven across the exact race that previously reported a false fresh Review.

### Milestone 4: Eliminate log loss and verify the complete surface

Goal: polling logs lose no entries, and the repairs pass repository and live read-only checks.

Work: change the tail cursor contract and panel state together; add safe duration logging only if Milestone 1 traces leave the latency source uncertain; update the user-visible changelog if the repository adds one before implementation, otherwise record that none exists. Run all gates and inspect the active Electron Dev app without performing a remote write.

Commands:

    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm run test:a11y
    pnpm run test:performance
    pnpm exec playwright test
    git diff --check

Expected result: every non-browser gate passes. Browser results either pass or list each remaining failure as an independently reproduced pre-existing issue. The live app shows the truthful refresh wording/action and does not expose an invalid thread action. The Logs panel receives the first entry written after each poll.

This reduces risk because unit tests prove contracts while the actual Electron surface proves that the renderer wiring did not diverge.

## Concrete Steps

1. From the repository root, confirm the baseline is still the planned one before editing:

       git status -sb
       git rev-parse --short HEAD

   Expected: no unrelated changes; `cd36e32` unless the implementer records a new baseline in this document.

2. Read the current definitions and all callers before changing public types:

       rg -n "recentWrites|DirectConversationReceipt|GitHubReader|tail\(|nextSeq|detectUpdates" src tests
       sed -n '1,280p' src/services/inline-conversation-service.ts
       sed -n '1,390p' src/services/review-refresh-service.ts

   Expected: all boundary changes are enumerated before code is touched.

3. Add the Milestone 1 tests. Use in-memory fake gateways and controlled promises for races; do not use a real GitHub profile or invoke mutation endpoints. Use a helper that asserts a mutation fake has zero calls when target proof fails.

4. Define the journal union close to the direct conversation receipt/domain boundary. Parse it in `src/main/local-api.ts` with the existing validated id parsers; remove the string-array request schema rather than preserving a compatibility alias. Update `ReviewWorkbenchController.detectUpdates`, `ReviewWorkbenchFlow`, and tests in the same change.

5. Add the two `GitHubReader` target-proof methods and implementations defined in Detailed Implementation Blueprint section 2. First use adapter tests with recorded `CommandRunner` input to prove the query has one node-id variable, no content/body fields, and bounded scope. If GitHub's node schema cannot express the required pull-request membership in one bounded query, stop this step, record the schema evidence under Surprises, and choose the smallest equivalent node selection; do not restore an unbounded all-thread scan.

6. Update `InlineConversationService.execute` so it runs: input validation, `ReviewWriteGate.requireFresh`, exact-head read, target proof where applicable, then mutation. Keep confirmation requirements for delete. Update service tests for active-Review ownership and viewer authorship.

7. Update `GitHubAdapter.createInlineComment`. Remove the unused `$id` variable and the entire optional thread-id reconciliation. Preserve the returned comment id and review id. Test exactly one REST command and a successful create with disabled thread-only actions; never create a synthetic thread id or a direct retry invitation.

8. Implement symmetric typed journal normalization in `ReviewRefreshService`. Write tests for create, reply, edit, delete, state changes, matching submitted review, and the critical external reply inside a locally resolved thread. Assert a remote difference persists in the normalized snapshots.

9. Refactor `ReviewWorkbenchFlow` into the projection-aware detector scheduler specified in Detailed Implementation Blueprint section 4. Use the defined snapshot key, one in-flight request guard, a 90-second interval, and a 1.5-second focus debounce. A direct receipt only updates the typed journal; it neither triggers an immediate detector call nor resets the interval. Clear all timers/listeners on unmount and increment generation before explicit refresh.

10. Update workbench, overview, and diff components. Use the existing `refresh` action, provide pending/error semantics, map multiline annotations to `end`, and render each comment through a shared authored-control component. Add UI tests that use keyboard-accessible controls and assert focus restoration after refresh.

11. Change `AppLogService.tail` and its local API/renderer consumers to return an exclusive-resume cursor based on the last delivered entry. Add an empty-tail and one-entry-between-polls regression test.

12. Run Milestone 4 commands. For live verification, follow `.agents/skills/patchdesk-electron-tester/SKILL.md`: attach to the existing Dev app, take a screenshot, inspect errors, exercise only read-only navigation and explicit refresh, and do not post, reply, resolve, edit, or delete GitHub content.

13. Update this document's Progress, Decision Log, Surprises, Outcomes, and Artifacts sections with exact results. Do not commit, push, or modify release tags unless separately requested.

## Validation and Acceptance

Safety acceptance:

- A parser-valid thread id from a different pull request produces `not_found` or `permission_denied`; neither Reply nor SetThreadState invokes its GitHub mutation.
- A comment from the active pull request but not authored by the viewer cannot be edited or deleted; no mutation is invoked.
- Every direct GitHub write still runs the shared freshness gate and exact-head check. A detected update blocks the write even while local draft editing remains available.

Freshness acceptance:

- A local create/reply/edit/delete or thread-state action does not by itself show `Updates available`.
- After a local resolve, an external reply in that same thread is detected and blocks a subsequent write until explicit refresh.
- Explicit `Refresh GitHub state` atomically replaces the projection and clears the marker when the remote observation is unchanged. A renderer reload alone does not claim to refresh GitHub.
- A detector result that began before explicit refresh cannot reapply stale state afterward.
- An open visible Review detects once initially, no more often than every 90 seconds while idle, and once after a debounced focus regain. Direct conversation receipts do not create an immediate detection request.

UI and responsiveness acceptance:

- Clicking Create immediately shows a clearly pending card. It does not offer reply/resolve until it has a real thread id. Failure removes or marks the pending card with bounded retry copy and does not present a fake id.
- Reply, state, edit, and delete show per-action pending feedback and reconcile or roll back correctly.
- A thread mapped to lines 10–12 is shown after line 12 in both virtualized and non-virtualized rendering paths.
- A viewer-authored reply, including one loaded after refresh, has reachable Edit and Delete controls.
- Traces show a target mutation no longer requires `getPullRequestComments` for all threads. A direct receipt does not schedule a detector; the next eligible initial, 90-second, or focus check carries the current typed journal.

Logs acceptance:

- If a response ends at sequence 4 and sequence 5 arrives before the next poll, resuming with the returned cursor includes sequence 5 exactly once.

## Idempotence and Recovery

All test and build commands are safe to repeat. The plan's test doubles never send GitHub writes. The live verification explicitly avoids mutation controls.

If a focused test fails after a partial type migration, complete the typed boundary in one change before diagnosing renderer behavior; mixed string and typed journals are unsafe because they can reintroduce whole-thread masking. If the bounded GitHub target-proof query is unsupported, do not merge a performance shortcut that loses ownership proof. Record the failed schema shape and implement the smallest PR-scoped query that returns the proof, then rerun the foreign-target tests.

If a refresh or detector test flakes, use controlled deferred promises and generation assertions rather than time-based sleeps. If a command-duration log is added, verify its payload with log-redaction tests before using it in live runs. If browser failures remain, preserve their output and isolate them from regressions caused by this work; do not relax browser assertions or skip the suite.

## Artifacts and Notes

Initial evidence, 2026-08-08:

    git status -sb
    ## main

    git rev-parse --short HEAD
    cd36e32

The previous review found six concrete defects: invalid GraphQL variable, whole-thread journal masking, missing reply/state ownership checks, start-line range placement, missing reply controls, and an exclusive-tail cursor mismatch. The architecture trace additionally found full-thread target reads, synchronous post-create lookup, CLI process startup, and post-receipt detector contention. Live read-only Electron inspection did not reproduce a currently visible stuck badge, but source inspection confirmed the misleading renderer-reload wording.

Append before/after fake gateway call counts, command duration summaries, focused-test output, full-gate output, and a redacted live screenshot path here as implementation proceeds. Do not place real pull-request titles, URLs, bodies, ids, tokens, command arguments, or raw GitHub output in this document.

## Interfaces and Dependencies

At completion the relevant contracts should be explicit and typed:

- `RecentReviewWrite` replaces `ReadonlyArray<string>` across the loopback request and detection call. It is a discriminated union covering a comment mutation with `commentId` and optional review identity, or a thread-state mutation with `threadId` and requested state. It uses the existing parsers in `src/domain/ids.ts`; no `as never` conversion of user input is allowed.

- `GitHubReader` gains the two bounded target-proof operations defined in Detailed Implementation Blueprint section 2. The adapter compares ownership internally and does not reveal a foreign target; `InlineConversationService` maps a non-member to `not_found` and a non-author to `permission_denied` before Reply, SetThreadState, EditComment, or DeleteComment. The service does not inspect GraphQL JSON or page every thread.

- `DirectConversationReceipt` and the renderer's local mutation model distinguish pending visual state from confirmed GitHub identity. An optimistic thread id is never accepted by `parseGitHubThreadId` or forwarded to the local API.

- `ReviewRefreshService.detect` accepts typed journal records and uses pure symmetric normalization helpers. Those helpers preserve an externally added comment in a locally modified thread.

- `ReviewWorkbenchFlow` owns a detector generation/scheduler whose only outward effects are advisory freshness patches. `refresh` remains the only path that calls `onWorkbenchReplace` with a new canonical remote projection.

- `AppLogService.tail` returns `entries` plus an exclusive-resume cursor derived from the last returned entry. `src/main/local-api.ts` and the Logs panel use the same name and semantics; the obsolete next-allocation `nextSeq` is removed rather than retained as an alias.

- No new package dependency is expected. Continue to use React, Vitest, Playwright, Electron, the existing `gh` executable, and current local API capability checks.
