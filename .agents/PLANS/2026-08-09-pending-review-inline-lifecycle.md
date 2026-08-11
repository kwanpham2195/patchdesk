---
created_at: 2026-08-09
repos: [patchdesk]
status: done
spec: .agents/archive/inline-diff-conversations/spec.md
tech-spec: .agents/archive/inline-diff-conversations/tech-spec.md
---

# Pending-review inline lifecycle correction

> **Executor instructions:** Implement this as one vertical correction. Do not treat the GitHub pending review as a local draft or batch. GitHub remains the authoritative owner after Start; local state may present only transient write progress or explicit recovery. Do not make a GitHub write during automated verification. The current user-owned pending review is real remote state: never discard, submit, alter, or clean it up.

## Status

- **Priority:** P0
- **Effort:** L
- **Risk:** HIGH — this changes visible write feedback, freshness protection, and the boundary between authoritative remote state and transient local UI.
- **Planned at:** `aa7cfc8` on `fix/inline-conversation-freshness-repair`
- **Depends on:** reconcile the currently uncommitted desktop-bridge fix in `src/main/desktop-bridge.ts` and `tests/desktop-bridge.test.ts`; it is a prerequisite for all pending-review UI commands.
- **Live evidence:** Start succeeded on a real PR and produced a remote pending review. AddThread is currently blocked by a GraphQL query validation error. No automated follow-up GitHub write is authorized.

## Problem

The normal **Comment now** flow already gives immediate, coherent feedback: it clears the composer, shows a local publishing card, then replaces that card with confirmed GitHub state or a failed local card. The new pending-review flow bypasses that lifecycle.

Consequences observed in the live Electron app:

1. Start succeeds and the header changes to **Finish review · 1**, but the old composer remains open with its original text and no-pending actions.
2. The confirmed pending thread is not rendered inline from the pending-review projection.
3. The diff portal can retain stale composer actions because its version key omits pending-review state.
4. The detector sees the app's own Start/Add/Discard thread change as a remote update, displays **Updates available**, and can lock further writes.
5. AddThread cannot run anywhere because its GraphQL selection puts `pageInfo` on `PullRequestReviewThread`, where GitHub rejects it before mutation execution.

## Product and safety decisions

- `ViewerPendingReview` and its confirmed comment/thread data are the only source of truth for pending-review inline cards. Do not create a second durable editable review draft, persist a local content mirror, or revive `ReviewBatch` behavior.
- A temporary renderer-only card may show **Starting review…** or **Adding to pending review…** while a typed remote command is in flight. It is progress feedback, not a GitHub identity or source of truth.
- A confirmed pending thread must be visibly distinct from a published conversation thread. Use explicit text such as **Pending review** and a semantic badge/treatment; do not use color alone.
- Pending cards do not expose Reply, Resolve, Unresolve, edit, or delete controls. Those operations remain outside the approved pending-review scope.
- A timeout/lost response stays `OutcomeUnknown`; never show an unconfirmed thread as posted, automatically retry, or enable conflicting writes. The existing **Check GitHub again** path remains the recovery action.
- Freshness detection must ignore only the exact pending thread IDs confirmed by this app window since the last represented-snapshot replacement. It must continue to detect head changes and unrelated remote activity.
- Explicit Refresh remains the only normal replacement of the represented snapshot and clears the recent-write journal.

## Current evidence

- `src/main/desktop-bridge.ts` blocked the pending command/recover routes. A local uncommitted fix adds both routes and focused bridge tests.
- `src/adapters/github/github-adapter.ts` AddThread currently emits `comments(first:100){nodes{id body}} pageInfo{hasNextPage}`. GitHub rejects this because `pageInfo` belongs inside the `comments` connection.
- `src/renderer/src/components/review-diff-view.tsx` uses `saveAuthoring()` for direct comments; that function creates an optimistic card and calls `clearAuthoring()`. Pending Start/Add directly call `PendingReviewComposerActions` instead, so they do neither.
- `src/renderer/src/components/review-workbench.tsx` builds diff annotations from Findings, legacy draft annotations, and represented Conversation threads. It does not derive annotations from `model.pendingReview`.
- `src/renderer/src/flows/review-workbench-flow.tsx` journals only direct comment and thread-state writes. `src/services/review-refresh-service.ts` therefore cannot symmetrically exclude app-owned pending-thread additions/removals during detection.

## Scope

### In scope

- `src/main/desktop-bridge.ts`
- `tests/desktop-bridge.test.ts`
- `src/adapters/github/github-adapter.ts`
- the existing GitHub adapter test file covering AddThread query construction
- `src/renderer/src/components/review-diff-view.tsx`
- `src/renderer/src/components/review-workbench.tsx`
- `src/renderer/src/flows/review-workbench-flow.tsx`
- `src/services/review-refresh-service.ts`
- `src/main/local-api.ts` and its route-schema tests if `RecentReviewWrite` gains a pending-thread variant
- focused renderer, flow, refresh-service, adapter, and browser tests that exercise these seams
- `.agents/PLANS/README.md`

### Out of scope

- New GitHub writes for automated/live verification.
- Empty pending reviews; Reply, Resolve, Unresolve, or editing/deleting a pending comment; head-change behavior; cross-account isolation.
- Any local pending-review draft, batch fallback, offline queue, compatibility shim, or migration.
- Changing direct **Comment now** semantics, GitHub API credentials, main-process capability rules other than the two already-required pending routes, or the Finish modal's submit/discard contract.
- Broad detector redesign or suppressing all update detection after a write.

## Implementation steps

### Step 1: Characterize and repair the command boundaries

1. Preserve and stage the existing bridge allowlist change only after confirming its diff is limited to:
   - `POST /v1/reviews/pending-review/command`
   - `POST /v1/reviews/pending-review/recover`
2. Keep route tests positive for those exact canonical paths and negative for method variants, trailing-slash variants, child paths, and unrelated pending-review paths.
3. Correct the AddThread GraphQL selection so the mutation requests:

   ```graphql
   thread {
     id
     path
     line
     startLine
     diffSide
     comments(first:100) {
       nodes { id body }
       pageInfo { hasNextPage }
     }
   }
   ```

   `pageInfo` must not be a sibling of `comments`.
4. Add an adapter regression test that captures the `gh api graphql` query from the existing fake process executor. Assert the corrected nesting and explicitly reject the old `nodes{id body}} pageInfo` shape. Keep the test at the adapter command seam; do not use a brittle full-query snapshot.

**Verify:** focused desktop-bridge and GitHub-adapter tests pass. The AddThread query test must fail with the old brace placement before the production query changes.

### Step 2: Give pending writes the same authoring lifecycle as direct comments

Refactor the renderer so an inline composer has one explicit lifecycle for all comment modes:

1. When an authoring selection is submitted as Start or AddThread, capture the selection/body in a renderer-only pending-write card, then immediately clear the authoring selection. Do this before awaiting the remote command, as `saveAuthoring()` already does for direct comments.
2. The card states are:
   - `sending`: **Starting review…** or **Adding to pending review…**;
   - `failed`: a confirmed failure message without an automatic retry;
   - no optimistic `confirmed` state. Confirmed content comes only from the returned `ViewerPendingReview` projection.
3. On a successful Start/Add result, remove the transient card after the parent applies the returned pending projection. The confirmed pending-thread annotation from Step 3 must replace it at the same anchor.
4. On confirmed rejection, keep a transient failed card as feedback. It must not become an editable Review draft or advertise a thread ID.
5. On `OutcomeUnknown`, do not leave a card that claims the comment exists. Let the existing unavailable/recovery state and **Check GitHub again** own recovery.
6. Do not call the user-facing `Cancel` handler to clear a successful composer: it may prompt about discarding text. Extract or pass an unconditional internal `clearAuthoring` callback instead.

**Verify:** renderer tests prove that successful Start/Add unmounts the composer immediately, a sending card is visible while the promise is unresolved, a confirmed projection replaces it, a rejection becomes failed feedback, and unknown outcomes do not claim confirmation.

### Step 3: Render authoritative pending threads inline and distinguish them

1. Add a renderer-local `ReviewInlineAnnotation` variant for a confirmed pending-review thread. It must contain only data already in the parsed pending projection: thread ID, comment ID/body, path/range/side, and pending status.
2. In `ReviewWorkbench`, derive these annotations only when `model.pendingReview.state === "pending"`. Merge them with Findings and represented Conversation annotations without duplicating thread IDs.
3. Render a dedicated pending thread card in `ReviewDiffView`:
   - explicit accessible label and visible **Pending review** status;
   - comment text and location context;
   - no published-thread actions or state controls;
   - no assumption that the thread is published or visible to other reviewers.
4. Include the effective pending composer state and pending review node ID in the annotation portal version key. A controlled Pierre annotation must re-render when none becomes pending, pending becomes unavailable/recovery, or the owner node changes.
5. Keep the header count, Finish modal ledger, pending composer choice, and inline cards sourced from the same pending projection. A response with count 1 must show one confirmed pending card at its anchor.

**Verify:** renderer tests prove a pending projection produces an inline **Pending review** card, does not expose unsupported controls, matches header count, and replaces stale Start/Comment-now composer actions after the pending-state transition.

### Step 4: Journal exact pending-thread mutations for update detection

1. Extend `RecentReviewWrite` with a typed pending-thread entry keyed by parsed GitHub thread ID. Update the local API DTO schema/parser so only valid IDs cross into the refresh service.
2. Extend `withoutRecentWrites()` to remove journaled pending thread IDs from **both** candidate and represented `GitHubComments` snapshots before hashing. This symmetric removal handles both:
   - Start/Add: the app-owned thread appears only in the candidate snapshot;
   - Discard: the app-owned thread disappears only from the candidate snapshot.
3. In `ReviewWorkbenchFlow`, compare the prior and confirmed pending projections after Start/Add to journal only the newly confirmed thread IDs. For Discard, capture the prior projection's thread IDs before the command and journal those IDs after confirmed absence.
4. Keep a journal entry through Submit until an explicit refresh/reload replaces the represented snapshot. Do not clear it merely because a command succeeded.
5. Do not journal unrelated pending threads, all comments from a PR, or arbitrary metadata. An external thread addition, external reply, check change, or head change must still produce `updates_available`.

**Verify:** refresh-service tests prove an app-owned pending-thread addition and removal do not mark updates available; an unrelated thread change and a head change still do. Flow/local-API tests prove pending thread IDs are serialized, parsed, and included in the detector request only after confirmed Start/Add/Discard results.

### Step 5: Complete regression and live verification

Run in this order:

1. focused desktop-bridge, adapter, renderer, flow, and refresh-service tests;
2. `pnpm typecheck`;
3. `pnpm lint`;
4. `pnpm test -- --run`;
5. `pnpm build`;
6. relevant browser workbench tests;
7. `git diff --check`.

Restart the Electron main process after main-process changes. Then use the dedicated Patchdesk Electron tester for a read-only check of no-pending and already-pending states. It may inspect existing user-created remote state but must not click Start/Add/Submit/Discard.

If the user separately chooses to manually add a comment after the build, record the expected observable result:

- composer closes immediately;
- a transient pending-write card appears during the request;
- one authoritative inline **Pending review** card replaces it;
- header count increments;
- no false **Updates available** banner appears;
- console and JSONL contain no error.

## Done criteria

- [ ] Pending command/recover routes pass the desktop bridge and malformed variants remain blocked.
- [ ] AddThread's GraphQL query is schema-valid and has a regression test for `comments.pageInfo` nesting.
- [ ] Start/Add clears the composer and never leaves stale no-pending actions on screen.
- [ ] A pending review comment renders inline immediately from the authoritative pending projection with explicit pending status and no unsupported controls.
- [ ] The temporary card is renderer-only, never pretends to be a confirmed GitHub thread, and never creates a local Review draft.
- [ ] Known Start/Add/Discard thread changes do not create a false update warning; unrelated changes and head changes still do.
- [ ] Unknown outcomes remain fail-closed with no automatic retry.
- [ ] Focused tests, typecheck, lint, full tests, build, browser checks, and diff check pass.
- [ ] Electron QA confirms the no-write surface; any live remote mutation is performed only by the user under separate approval.

## Stop conditions

Stop and report instead of improvising if:

- the pending projection does not contain sufficient parsed anchor/thread information to render an inline card without an additional GitHub read;
- hiding an app-owned thread from detection would also hide an unrelated remote thread or a head change;
- the current pending review cannot be inspected without altering it;
- a renderer-only failure card would need durable storage to preserve user content;
- the controlled Pierre portal cannot observe a versioned annotation change without breaking existing direct-comment or conversation-thread rendering;
- a test requires a live GitHub mutation or real credentials to establish normal behavior.

## Maintenance notes

- Keep remote pending-review ownership explicit in names and comments. Do not call pending cards “drafts.”
- Any future pending-review operation that creates or removes a thread must add a typed journal entry and prove detector symmetry before shipping.
- The direct-comment optimistic-card pattern is the presentation precedent; it is not permission to reuse local `ReviewBatch` persistence for pending reviews.
- Keep GraphQL selection tests focused on structurally risky nested connections. Fake executors verify command construction; live mutation behavior remains covered by separately authorized spikes.
