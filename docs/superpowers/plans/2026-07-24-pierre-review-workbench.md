# Pierre review workbench implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one direct Pierre review workbench with a Saved reviews inbox queue, automatic diff streaming, inline local drafts and GitHub threads, separate PR details, and explicit safe GitHub writes.

**Architecture:** One current `ReviewBatch` is persisted in the existing `ReviewSession`. It owns every local inline comment, reply, resolve or reopen action, pending-review ID, and completed-write receipt. The main process parses all commands, owns refresh and remote writes, and projects safe data to the renderer. Pierre only renders the file tree, diff, and annotations.

**Tech Stack:** Electron, React, TypeScript, Valibot, Hono, `@pierre/diffs` 1.2.12, `@pierre/trees` 1.0.0-beta.5, GitHub CLI GraphQL and REST, Vitest, Playwright.

## Global constraints

- Keep `nodeIntegration: false`, `contextIsolation: true`, and shell, filesystem, and GitHub work in the main process.
- Parse renderer commands, stored records, and GitHub responses. Expected failures are typed values.
- Keep one current review result for the current PR head. Rerun requires explicit discard of active local work.
- Preserve existing local drafts during the v2-to-v3 session migration; reject malformed records and every unsupported schema version.
- The `ReviewDraft` module may remain as a temporary internal type bridge only while Tasks 2, 4, 5, 8, and 9 migrate its consumers. New v3 storage never writes draft fields; delete the bridge and module once its last consumer is removed.
- Refresh upstream PR and thread data only when the user asks. Refresh never replaces local batch items.
- Every GitHub write requires confirmation, expected revision, and a head check immediately before the first write.
- Persist an operation state before each remote call and a receipt after each success. Never retry an ambiguous write.
- Create a pending review only when the confirmed batch has new inline comments. Reply-only or thread-state-only batches skip it.
- Preserve Pierre native scrolling. Do not add wheel or touch `preventDefault`, scroll nudges, or global Pierre style overrides.
- Keep desktop rails at 232px application, 208px file tree, and 336px inspector at 1280px and above.
- Remove prepared review, Drafts, History, findings filters, Fix queue, local findings rail, review-details sidebar, and Load more files.
- Keep the 1,000-file selection ceiling below 200ms.

---

## File map

- Create `src/domain/review-batch.ts`: typed batch, item, operation, receipt, parser, and pure transitions.
- Delete `src/domain/review-draft.ts`; replace all draft terminology in session and services with batch terminology.
- Modify `src/domain/review-session.ts` and `src/adapters/storage/review-session-store.ts`: current batch ownership and strict persistence.
- Create `src/services/review-batch-controller.ts`; delete `src/services/review-draft-controller.ts`.
- Modify `src/services/review-workbench.ts`, `src/services/review-completion-service.ts`, `src/services/review-submission-service.ts`, and `src/services/review-write-controller.ts`.
- Modify `src/adapters/github/github-adapter.ts` and `src/domain/github-context.ts` for anchored read threads and explicit thread writers.
- Modify workbench projection, controller, and `src/main/local-api.ts` for local load and manual refresh.
- Modify inbox domain/service and routes for overlapping `saved_review`.
- Create `src/renderer/src/components/pierre-file-tree.tsx`, `inline-review-thread.tsx`, and `pr-details-view.tsx`.
- Modify `completed-review-workbench.tsx`, `review-diff-view.tsx`, `completed-review-flow.tsx`, `inbox-flow.tsx`, `app.tsx`, and `routes.ts`.
- Delete `changed-file-tree.tsx`, `review-draft-sheet.tsx`, and `prepared-review-flow.tsx`.
- Update matching domain, storage, service, adapter, renderer, browser, local-API, package-smoke, README, and changelog tests.

### Task 1: Introduce the review batch domain model

**Files:**
- Create: `src/domain/review-batch.ts`
- Modify: `src/domain/ids.ts`, `src/domain/review-session.ts`, `src/adapters/storage/review-session-store.ts`
- Delete: `src/domain/review-draft.ts`
- Test: `tests/domain/review-domain.test.ts`, `tests/storage/patchdesk-storage.test.ts`, `tests/storage/review-session-store-begin-attempt.test.ts`

**Interfaces:**
- Produces `ReviewBatch`, `ReviewBatchItem`, `ReviewBatchState`, `RemoteWriteReceipt`, `parseReviewBatch`, `hasActiveReviewBatch`, and `discardBatchForRerun`.

- [x] **Step 1: Write failing tests for batch parsing and rerun blocking.**

```ts
it("accepts inline, reply, and thread-state items", () => {
  expect(parseReviewBatch(batchFixture())._tag).toBe("ok");
});

it("rejects an invalid range", () => {
  expect(parseReviewBatch(batchFixture({ startLine: 8, line: 7 }))._tag).toBe("err");
});

it("blocks a rerun until its local batch is discarded", () => {
  expect(startNextAttempt(sessionWithLocalBatch(), [])).toEqual(
    err({ _tag: "ActiveBatchBlocksRerun" }),
  );
});
```

- [x] **Step 2: Run the focused tests.**

Run: `pnpm test -- --run tests/domain/review-domain.test.ts tests/storage/patchdesk-storage.test.ts tests/storage/review-session-store-begin-attempt.test.ts`

Expected: FAIL because `ReviewBatch` and its transitions do not exist.

- [x] **Step 3: Implement the exact domain variants.**

```ts
export type ReviewAnchor = {
  readonly path: RepoRelativePath;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
};

export type ReviewBatchItem =
  | { readonly _tag: "InlineComment"; readonly id: LocalReviewItemId; readonly source: "finding" | "manual"; readonly findingId?: FindingId; readonly anchor: ReviewAnchor; readonly body: string; readonly include: boolean; readonly postability: Postability }
  | { readonly _tag: "ThreadReply"; readonly id: LocalReviewItemId; readonly threadId: GitHubThreadId; readonly body: string; readonly include: boolean }
  | { readonly _tag: "ThreadState"; readonly id: LocalReviewItemId; readonly threadId: GitHubThreadId; readonly action: "resolve" | "reopen"; readonly include: boolean };

export type ReviewBatchState =
  | { readonly _tag: "Local" }
  | { readonly _tag: "Applying"; readonly operation: BatchOperation }
  | { readonly _tag: "PartialFailure"; readonly operation: BatchOperation; readonly failure: SafeWriteFailure }
  | { readonly _tag: "PendingReview"; readonly reviewId: string }
  | { readonly _tag: "Submitted"; readonly reviewId: string; readonly event: GitHubReviewEvent }
  | { readonly _tag: "Completed" };
```

Add strict Valibot variants, branded item and thread IDs, and receipt variants. Replace `draft` and `draftContent` in `ReviewSession` with `batch` and `batchContent`. Persist schema version 3; explicitly migrate a valid v2 local draft once into its equivalent local batch, and reject malformed records or every other unsupported version instead of guessing a migration. A reply-only or thread-state-only batch reaches `Completed` after its recorded operations succeed; it never invents a GitHub review ID.

- [x] **Step 4: Make discard-for-rerun a pure legal transition.**

`discardBatchForRerun(session, confirmedAt)` removes only the batch fields, preserves the current result until a new result completes, and advances the session timestamp. `startNextAttempt` accepts a session only after that transition.

- [x] **Step 5: Run focused tests and typecheck.**

Run: `pnpm test -- --run tests/domain/review-domain.test.ts tests/storage/patchdesk-storage.test.ts tests/storage/review-session-store-begin-attempt.test.ts && pnpm typecheck`

Expected: PASS.

- [x] **Step 6: Commit.**

```bash
git add src/domain/review-batch.ts src/domain/ids.ts src/domain/review-session.ts src/adapters/storage/review-session-store.ts tests/domain/review-domain.test.ts tests/storage/patchdesk-storage.test.ts tests/storage/review-session-store-begin-attempt.test.ts
git rm src/domain/review-draft.ts
git commit -m "refactor: model review work as a local batch"
```

### Task 2: Derive and edit local batch items through one compare-and-set controller

**Files:**
- Modify: `src/services/review-workbench.ts`, `src/services/review-completion-service.ts`
- Create: `src/services/review-batch-controller.ts`
- Delete: `src/services/review-draft-controller.ts`
- Test: `tests/services/review-workbench.test.ts`, `tests/services/review-completion-service.test.ts`, `tests/services/review-batch-controller.test.ts`

**Interfaces:**
- Produces `createReviewBatch` and `ReviewBatchController.update(input)`.

- [ ] **Step 1: Write failing tests for automatic mapped items, manual ranges, replies, and discard confirmation.**

```ts
it("creates included items only for mapped findings", () => {
  const result = createReviewBatch({ session, attempt, result, createdAt });
  expect(result.value.batch.items).toContainEqual(
    expect.objectContaining({ _tag: "InlineComment", source: "finding", include: true }),
  );
  expect(result.value.repositoryFindings).toHaveLength(1);
});

it("rejects an unacknowledged discard command", async () => {
  await expect(controller.update(discardCommand(false))).resolves.toEqual(
    err({ reason: "acknowledgement_required" }),
  );
});
```

- [ ] **Step 2: Run the focused tests.**

Run: `pnpm test -- --run tests/services/review-workbench.test.ts tests/services/review-completion-service.test.ts tests/services/review-batch-controller.test.ts`

Expected: FAIL because batch derivation and commands are missing.

- [ ] **Step 3: Derive mapped findings into stable local items.**

Use a deterministic local item ID derived from `FindingId`. Populate body from suggested comment or explanation, set `include: true`, and preserve parsed anchor and side. Keep repository-level findings out of the batch.

- [ ] **Step 4: Implement strict editable commands.**

```ts
type ReviewBatchUpdate =
  | { readonly _tag: "AddInlineComment"; readonly anchor: ReviewAnchor; readonly body: string }
  | { readonly _tag: "EditItem"; readonly itemId: LocalReviewItemId; readonly body: string }
  | { readonly _tag: "RemoveItem"; readonly itemId: LocalReviewItemId }
  | { readonly _tag: "AddThreadReply"; readonly threadId: GitHubThreadId; readonly body: string }
  | { readonly _tag: "SetThreadState"; readonly threadId: GitHubThreadId; readonly action: "resolve" | "reopen" }
  | { readonly _tag: "DiscardForRerun"; readonly acknowledgement: true };
```

Parse the command, lock by profile/session, compare `expectedRevision` with `batch.updatedAt`, apply one pure transition, save, reload, and return the canonical batch. Reject empty bodies, duplicate queued thread actions, foreign attempt IDs, unknown item IDs, and edits after applying or submission.

- [ ] **Step 5: Run focused tests and remove old imports.**

Run: `pnpm test -- --run tests/services/review-workbench.test.ts tests/services/review-completion-service.test.ts tests/services/review-batch-controller.test.ts && rg -n "ReviewDraft|review-draft-controller|createLocalDraft" src tests`

Expected: tests PASS; search finds no production references.

- [ ] **Step 6: Commit.**

```bash
git add src/services/review-workbench.ts src/services/review-completion-service.ts src/services/review-batch-controller.ts tests/services/review-workbench.test.ts tests/services/review-completion-service.test.ts tests/services/review-batch-controller.test.ts
git rm src/services/review-draft-controller.ts tests/services/review-draft-controller.test.ts
git commit -m "feat: persist local review batch edits"
```

### Task 3: Add anchored GitHub thread reads and thread write capabilities

**Files:**
- Modify: `src/domain/github-context.ts`, `src/adapters/github/github-adapter.ts`
- Test: `tests/adapters/github-adapter.test.ts`

**Interfaces:**
- Produces anchored `GitHubConversationThread`, `GitHubReviewWriter.createThreadReply`, and `GitHubReviewWriter.setReviewThreadState`.

- [ ] **Step 1: Write failing adapter tests.**

```ts
it("projects a thread ID and its root diff anchor", async () => {
  await expect(adapter.getPullRequestComments({ profile, pr })).resolves.toEqual(
    ok({ threads: [expect.objectContaining({ id: "PRRT_kwDO", location: { path: "src/a.ts", line: 7, diffSide: "new" } })] }),
  );
});

it("sends reply and resolve mutations with a stored thread ID", async () => {
  await adapter.createThreadReply({ profile, pr, threadId, body: "Fixed." });
  await adapter.setReviewThreadState({ profile, pr, threadId, state: "resolved" });
  expect(await payload("thread-writes.json")).toMatchObject({ threadId: String(threadId) });
});
```

- [ ] **Step 2: Run the adapter test.**

Run: `pnpm test -- --run tests/adapters/github-adapter.test.ts`

Expected: FAIL because thread writes and full anchors are absent.

- [ ] **Step 3: Extend GraphQL reads and parse the safe projection.**

Request thread ID, resolved and outdated flags, root comment path, line, start line, side, start side, and chronological comments. Parse all values before projection. Threads with no valid source anchor remain readable in remote context but do not render as a diff annotation.

- [ ] **Step 4: Add GraphQL reply, resolve, and reopen methods.**

Use GraphQL global thread IDs. Classify each failed command into the existing safe auth, rejected, or unavailable failure. Extend `FakeGitHubAdapter` with a recording writer seam; do not use spies.

- [ ] **Step 5: Run focused tests and commit.**

Run: `pnpm test -- --run tests/adapters/github-adapter.test.ts`

Expected: PASS.

```bash
git add src/domain/github-context.ts src/adapters/github/github-adapter.ts tests/adapters/github-adapter.test.ts
git commit -m "feat: read and update GitHub review threads"
```

### Task 4: Apply a confirmed batch with receipts and no automatic retry

**Files:**
- Modify: `src/services/review-submission-service.ts`, `src/services/review-write-controller.ts`, `src/main/local-api.ts`
- Test: `tests/services/review-submission-service.test.ts`, `tests/local-api-auth.test.ts`

**Interfaces:**
- Produces `applyReviewBatch`, `POST /v1/reviews/apply-batch`, and a separate submit operation for `PendingReview`.

- [ ] **Step 1: Write failing batch execution tests.**

```ts
it("creates one pending review then applies saved replies and state actions", async () => {
  const result = await applyReviewBatch({ profile, session, batch, gateway, now });
  expect(gateway.recorded).toEqual(["createPendingReview", "createThreadReply", "setReviewThreadState"]);
  expect(result.value.batch.receipts.map((x) => x._tag)).toEqual(
    ["PendingReviewCreated", "ReplyCreated", "ThreadStateChanged"],
  );
});

it("skips pending review creation for a reply-only batch", async () => {
  await applyReviewBatch({ profile, session, batch: replyOnlyBatch, gateway, now });
  expect(gateway.recorded).toEqual(["createThreadReply"]);
});

it("persists completed receipts before a later ambiguous failure", async () => {
  const result = await applyReviewBatch({ profile, session, batch, gateway: ambiguousReplyGateway, now });
  expect(result).toMatchObject({ _tag: "err", error: { _tag: "BatchOutcomeUnknown" } });
});
```

- [ ] **Step 2: Run the focused tests.**

Run: `pnpm test -- --run tests/services/review-submission-service.test.ts tests/local-api-auth.test.ts`

Expected: FAIL because the service only creates and submits finding comments.

- [ ] **Step 3: Add a pure ordered operation planner.**

```ts
function planBatchOperations(batch: ReviewBatch): ReadonlyArray<BatchOperation> {
  const inline = batch.items.filter(isIncludedInlineComment);
  const threadItems = batch.items.filter(isIncludedThreadOperation);
  return [
    ...(inline.length === 0 ? [] : [{ _tag: "CreatePendingReview" as const, itemIds: inline.map((item) => item.id) }]),
    ...threadItems.map(toThreadOperation),
  ];
}
```

Persist `Applying(operation)` before every call. After success, append one receipt and persist. On known failure persist `PartialFailure`; on ambiguous transport outcome persist an unknown failure and block replay. Completed receipts are never replayed.

- [ ] **Step 4: Reuse the current controller safeguards.**

`ReviewWriteController.applyBatch` must require parsed profile/session IDs, expected revision, and `acknowledgement: true`; reuse its in-flight session guard. Recheck the GitHub head before the first operation. A changed head saves `Stale` and makes no remote call. Keep submit as a distinct confirmation and recheck the head before submission.

- [ ] **Step 5: Run focused tests and commit.**

Run: `pnpm test -- --run tests/services/review-submission-service.test.ts tests/local-api-auth.test.ts && pnpm typecheck`

Expected: PASS.

```bash
git add src/services/review-submission-service.ts src/services/review-write-controller.ts src/main/local-api.ts tests/services/review-submission-service.test.ts tests/local-api-auth.test.ts
git commit -m "feat: apply confirmed review batches safely"
```

### Task 5: Separate local workbench loading from manual remote refresh

**Files:**
- Modify: `src/services/review-workbench-projection.ts`, `src/services/review-workbench-controller.ts`, `src/main/local-api.ts`, `src/renderer/src/flows/completed-review-flow.tsx`
- Test: `tests/services/review-workbench-projection.test.ts`, `tests/local-api-auth.test.ts`, `tests/renderer/review-workbench.ui.test.tsx`

**Interfaces:**
- Produces `loadLocal` and `refreshRemote`. Local load never calls GitHub; remote refresh never persists local batch edits.

- [ ] **Step 1: Write failing projection tests.**

```ts
it("opens saved local work without calling GitHub", async () => {
  const result = await projections.loadLocal({ profileId, sessionId });
  expect(result).toMatchObject({ _tag: "ok", value: { remoteContext: { freshness: "not_refreshed" } } });
  expect(github.calls).toEqual([]);
});

it("refreshes remote data without replacing local batch items", async () => {
  const before = await sessions.load(profileId, sessionId);
  await projections.refreshRemote({ profileId, sessionId });
  const after = await sessions.load(profileId, sessionId);
  expect(after.value.batchContent).toEqual(before.value.batchContent);
});
```

- [ ] **Step 2: Run focused tests.**

Run: `pnpm test -- --run tests/services/review-workbench-projection.test.ts tests/local-api-auth.test.ts tests/renderer/review-workbench.ui.test.tsx`

Expected: FAIL because current `load` fetches threads, checks, and PR data.

- [ ] **Step 3: Implement the two projections and routes.**

`loadLocal` returns immutable patch, result, batch, and `freshness: "not_refreshed"`. `refreshRemote` concurrently fetches and parses PR, checks, and review threads into `RemoteReviewContext`, returns it without saving the batch, and backs `POST /v1/reviews/refresh`. Keep `POST /v1/reviews/load` local-only.

- [ ] **Step 4: Update the renderer flow action and test.**

Add `refreshRemote(): Promise<RemoteReviewContext>` to `CompletedReviewFlow`. Validate response shape at the flow boundary; do not pass unknown objects into the workbench.

- [ ] **Step 5: Run focused tests and commit.**

Run: `pnpm test -- --run tests/services/review-workbench-projection.test.ts tests/local-api-auth.test.ts tests/renderer/review-workbench.ui.test.tsx`

Expected: PASS.

```bash
git add src/services/review-workbench-projection.ts src/services/review-workbench-controller.ts src/main/local-api.ts src/renderer/src/flows/completed-review-flow.tsx tests/services/review-workbench-projection.test.ts tests/local-api-auth.test.ts tests/renderer/review-workbench.ui.test.tsx
git commit -m "refactor: refresh review context explicitly"
```

### Task 6: Replace Drafts and History with the Saved reviews inbox queue

**Files:**
- Modify: `src/domain/maintainer-inbox.ts`, `src/services/maintainer-inbox-service.ts`, `src/renderer/src/flows/inbox-flow.tsx`, `src/renderer/src/routes.ts`, `src/renderer/src/app.tsx`
- Delete: `src/renderer/src/flows/prepared-review-flow.tsx`
- Test: `tests/domain/maintainer-inbox.test.ts`, `tests/services/maintainer-inbox-service.test.ts`, `tests/renderer/maintainer-inbox.ui.test.tsx`, `tests/renderer/dashboard.ui.test.tsx`

**Interfaces:**
- Produces overlapping `saved_review` membership and direct workbench opening from the filtered inbox.

- [ ] **Step 1: Write failing queue and route tests.**

```ts
it("marks a resumable local batch as saved_review and authored when both apply", () => {
  expect(projectMaintainerInboxRow(input).categories).toEqual(
    expect.arrayContaining(["saved_review", "authored"]),
  );
});

it("excludes submitted batches from saved_review", () => {
  expect(projectMaintainerInboxRow(submittedInput).categories).not.toContain("saved_review");
});

it("has no Drafts or History destination", () => {
  expect(primaryDestinations.map((x) => x.kind)).not.toEqual(
    expect.arrayContaining(["drafts", "history"]),
  );
});
```

- [ ] **Step 2: Run focused tests.**

Run: `pnpm test -- --run tests/domain/maintainer-inbox.test.ts tests/services/maintainer-inbox-service.test.ts tests/renderer/maintainer-inbox.ui.test.tsx tests/renderer/dashboard.ui.test.tsx`

Expected: FAIL because the new queue and direct route are absent.

- [ ] **Step 3: Add the overlapping category and remove old destinations.**

A batch in `Local`, `Applying`, `PartialFailure`, or `PendingReview` adds `saved_review`; submitted, discarded, merged, and no-batch sessions do not. Queue selection filters one list at a time. My PRs remains author-based, so one row may match both. Remove Drafts, History, `ReviewRecords`, command-palette entries, and the prepared flow. A no-result workbench shows Run review in its own header.

- [ ] **Step 4: Run focused tests and commit.**

Run: `pnpm test -- --run tests/domain/maintainer-inbox.test.ts tests/services/maintainer-inbox-service.test.ts tests/renderer/maintainer-inbox.ui.test.tsx tests/renderer/dashboard.ui.test.tsx`

Expected: PASS.

```bash
git add src/domain/maintainer-inbox.ts src/services/maintainer-inbox-service.ts src/renderer/src/flows/inbox-flow.tsx src/renderer/src/routes.ts src/renderer/src/app.tsx tests/domain/maintainer-inbox.test.ts tests/services/maintainer-inbox-service.test.ts tests/renderer/maintainer-inbox.ui.test.tsx tests/renderer/dashboard.ui.test.tsx
git rm src/renderer/src/flows/prepared-review-flow.tsx
git commit -m "feat: show saved reviews in the inbox queue"
```

### Task 7: Replace the changed-file rail with Pierre Tree

**Files:**
- Create: `src/renderer/src/components/pierre-file-tree.tsx`
- Modify: `src/renderer/src/components/completed-review-workbench.tsx`, `src/renderer/src/components/review-diff-view.tsx`
- Delete: `src/renderer/src/components/changed-file-tree.tsx`
- Test: `tests/renderer/review-workbench.ui.test.tsx`, `tests/browser/milestone-9.spec.ts`, `tests/browser/performance.spec.ts`

**Interfaces:**
- Produces `PierreFileTree({ paths, selectedPath, onSelectPath })` and one canonical path-to-CodeView-item map.

- [ ] **Step 1: Write failing tree navigation tests.**

```ts
it("renders a Pierre tree as the only file rail", () => {
  renderWorkbench();
  expect(screen.getByRole("tree", { name: "Changed files" })).toBeTruthy();
  expect(screen.queryByText("Findings")).toBeNull();
});

test("tree navigation scrolls to the selected streamed file without tree scroll coupling", async ({ page }) => {
  await page.getByRole("treeitem", { name: "src/b.ts" }).click();
  await expect(page.locator("[data-selected-path='src/b.ts']")).toBeVisible();
  await page.locator(".review-diff-viewport").hover();
  await page.mouse.wheel(0, 800);
  await expect(page.getByRole("treeitem", { name: "src/b.ts" })).toHaveAttribute("aria-selected", "true");
});
```

- [ ] **Step 2: Run focused tests.**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx && pnpm exec playwright test tests/browser/milestone-9.spec.ts`

Expected: FAIL because the local tree still renders.

- [ ] **Step 3: Implement the tree wrapper.**

Use `useFileTree` and `ThemedFileTree` from the installed Pierre package. Construct its model once, preserve patch order, batch later streamed paths into the model, and route selection only to `onSelectPath`. Render file stats as row decoration only. Do not show findings, severity, filters, or extra scroll synchronization in the tree.

- [ ] **Step 4: Preserve direct selection behavior in CodeView.**

Use the existing selected-path effect to hydrate or materialize an item, then call one `CodeView.scrollTo`. Never call tree selection from `onScroll`. A deliberate finding or comment selection may call `scrollToPath(path, { focus: false })` only to reveal the already selected file.

- [ ] **Step 5: Run performance tests and commit.**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx && pnpm exec playwright test tests/browser/milestone-9.spec.ts tests/browser/performance.spec.ts`

Expected: PASS, including the existing 1,000-file threshold.

```bash
git add src/renderer/src/components/pierre-file-tree.tsx src/renderer/src/components/completed-review-workbench.tsx src/renderer/src/components/review-diff-view.tsx tests/renderer/review-workbench.ui.test.tsx tests/browser/milestone-9.spec.ts tests/browser/performance.spec.ts
git rm src/renderer/src/components/changed-file-tree.tsx
git commit -m "feat: navigate review files with Pierre Tree"
```

### Task 8: Render inline review work through Pierre annotations

**Files:**
- Create: `src/renderer/src/components/inline-review-thread.tsx`
- Modify: `src/renderer/src/components/review-diff-view.tsx`, `src/renderer/src/components/completed-review-workbench.tsx`, `src/renderer/src/flows/completed-review-flow.tsx`
- Test: `tests/renderer/review-workbench.ui.test.tsx`, `tests/renderer/review-diff-data.test.ts`, `tests/browser/milestone-9.spec.ts`

**Interfaces:**
- Produces annotation metadata derived from batch items, mapped findings, and refreshed anchored threads.

- [ ] **Step 1: Write failing inline-review tests.**

```ts
it("renders a mapped finding as an included inline draft", () => {
  renderWorkbenchWithMappedAndRepositoryFinding();
  expect(screen.getByText("Draft comment")).toBeTruthy();
  expect(screen.getByText("repository-level")).toBeTruthy();
});

it("saves a manual range comment through the batch action", async () => {
  renderWorkbench();
  await user.click(screen.getByRole("button", { name: "Add comment to lines 4 through 6" }));
  await user.type(screen.getByLabelText("Comment"), "Please preserve this guard.");
  expect(saveBatch).toHaveBeenCalledWith(expect.objectContaining({ _tag: "AddInlineComment" }));
});
```

- [ ] **Step 2: Run focused tests.**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/renderer/review-diff-data.test.ts && pnpm exec playwright test tests/browser/milestone-9.spec.ts`

Expected: FAIL because CodeView has no annotation renderer.

- [ ] **Step 3: Derive annotations and render cards.**

Map local `new` and `old` sides to Pierre additions and deletions. Pass `lineAnnotations` and `renderAnnotation` to CodeView. `InlineReviewThread` renders editable local comments, chronological remote thread messages and reply editor, or compact finding state. It emits only parsed local batch commands.

- [ ] **Step 4: Add line and range actions.**

Expose a one-line action on hover and a range action from Pierre selected-line state. Keep the composer below its anchor. Keep repository-level findings in Review result and inspector only. Hide resolved threads unless Show resolved is active.

- [ ] **Step 5: Run focused tests and commit.**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/renderer/review-diff-data.test.ts && pnpm exec playwright test tests/browser/milestone-9.spec.ts`

Expected: PASS.

```bash
git add src/renderer/src/components/inline-review-thread.tsx src/renderer/src/components/review-diff-view.tsx src/renderer/src/components/completed-review-workbench.tsx src/renderer/src/flows/completed-review-flow.tsx tests/renderer/review-workbench.ui.test.tsx tests/renderer/review-diff-data.test.ts tests/browser/milestone-9.spec.ts
git commit -m "feat: show review work inline with the diff"
```

### Task 9: Simplify the workbench and create separate PR details

**Files:**
- Create: `src/renderer/src/components/pr-details-view.tsx`
- Modify: `src/renderer/src/components/completed-review-workbench.tsx`, `src/renderer/src/components/review-diff-view.tsx`, `src/renderer/src/flows/completed-review-flow.tsx`, `src/renderer/src/routes.ts`, `src/renderer/src/app.tsx`
- Delete: `src/renderer/src/components/review-draft-sheet.tsx`
- Test: `tests/renderer/review-workbench.ui.test.tsx`, `tests/renderer/review-submission-dialog.ui.test.tsx`, `tests/browser/milestone-9.spec.ts`, `tests/browser/milestone-10.spec.ts`

**Interfaces:**
- Produces a contextual review inspector and read-only PR-details destination.

- [ ] **Step 1: Write failing simplification tests.**

```ts
it("has no prepared screen, review-details sidebar, filters, Fix queue, or load-more button", () => {
  renderDirectWorkbenchWithoutResult();
  expect(screen.getByRole("button", { name: "Run review" })).toBeTruthy();
  expect(screen.queryByText("Fix queue")).toBeNull();
  expect(screen.queryByRole("button", { name: /load more files/i })).toBeNull();
});

it("opens read-only PR details for checks", async () => {
  renderWorkbenchWithFailingChecks();
  await user.click(screen.getByRole("button", { name: "Checks failing" }));
  expect(screen.getByRole("region", { name: "PR details" })).toHaveTextContent("Checks");
  expect(screen.queryByRole("button", { name: "Reply to general comment" })).toBeNull();
});
```

- [ ] **Step 2: Run focused tests.**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/renderer/review-submission-dialog.ui.test.tsx && pnpm exec playwright test tests/browser/milestone-9.spec.ts tests/browser/milestone-10.spec.ts`

Expected: FAIL because the old workbench remains.

- [ ] **Step 3: Recompose the workbench.**

Header: PR identity, compact checks, Refresh, PR details, and one primary state action. Inspector: selected item evidence or current batch. Review result: compact navigation links only. Delete severity counts, findings cards, Fix queue, history, and draft sheet. Remove the manual progressive-stream button; retain near-bottom append in `use-progressive-review-diff-stream.ts` without scroll repositioning.

- [ ] **Step 4: Add read-only PR details.**

Render safe Markdown description, author, branch, full head, checks, commits, merge readiness, and read-only general discussion. Use `window.patchdesk.openExternalHttps` for external links. Start the existing explicit merge confirmation from this view only.

- [ ] **Step 5: Run focused tests and commit.**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/renderer/review-submission-dialog.ui.test.tsx && pnpm exec playwright test tests/browser/milestone-9.spec.ts tests/browser/milestone-10.spec.ts`

Expected: PASS.

```bash
git add src/renderer/src/components/pr-details-view.tsx src/renderer/src/components/completed-review-workbench.tsx src/renderer/src/components/review-diff-view.tsx src/renderer/src/flows/completed-review-flow.tsx src/renderer/src/routes.ts src/renderer/src/app.tsx tests/renderer/review-workbench.ui.test.tsx tests/renderer/review-submission-dialog.ui.test.tsx tests/browser/milestone-9.spec.ts tests/browser/milestone-10.spec.ts
git rm src/renderer/src/components/review-draft-sheet.tsx
git commit -m "feat: simplify the review workbench"
```

### Task 10: Complete verification and package QA

**Files:**
- Modify: `tests/browser/milestone-9.spec.ts`, `tests/browser/milestone-10.spec.ts`, `tests/browser/milestone-12.spec.ts`, `tests/browser/performance.spec.ts`, `tests/renderer/review-workbench.ui.test.tsx`, `tests/services/review-submission-service.test.ts`, `README.md`

**Interfaces:**
- Produces final behavior evidence for the workbench, writes, accessibility, overflow, and packaged Electron app.

- [ ] **Step 1: Add failing end-to-end failure-path and accessibility checks.**

```ts
test("refresh retains local reply text and hides resolved threads", async ({ page }) => {
  await page.getByLabel("Reply").fill("Will fix this.");
  await page.getByRole("button", { name: "Refresh review" }).click();
  await expect(page.getByLabel("Reply")).toHaveValue("Will fix this.");
  await expect(page.getByText("Resolved thread")).toBeHidden();
});

test("has no page-level horizontal overflow", async ({ page }) => {
  expect(await page.locator("html").evaluate((node) => node.scrollWidth === node.clientWidth)).toBe(true);
});
```

Cover keyboard tree navigation, forced colors, inline-editor focus, stale head before first write, reply-only confirmation, partial batch outcome, rerun discard confirmation, 1280px and 1440px desktop, and 960px compact sheet.

- [ ] **Step 2: Run focused browser and service tests.**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/services/review-submission-service.test.ts && pnpm exec playwright test tests/browser/milestone-9.spec.ts tests/browser/milestone-10.spec.ts tests/browser/milestone-12.spec.ts tests/browser/performance.spec.ts`

Expected: FAIL only for missing final checks or discovered approved behavior gaps.

- [ ] **Step 3: Fix only approved failing behavior and rerun focused checks.**

Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/services/review-submission-service.test.ts && pnpm exec playwright test tests/browser/milestone-9.spec.ts tests/browser/milestone-10.spec.ts tests/browser/milestone-12.spec.ts tests/browser/performance.spec.ts`

Expected: PASS.

- [ ] **Step 4: Update README documentation.**

Describe direct workbench opening, Saved reviews, local drafts, explicit refresh, inline threads, and confirmation. Do not expose storage internals or provider reasoning.

- [ ] **Step 5: Run the full repository and package gates.**

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
pnpm package:mac
pnpm test:package-smoke
```

Expected: every command exits 0.

- [ ] **Step 6: Run packaged-app CDP QA through a dedicated tester subagent.**

Launch an isolated packaged app with a distinct user-data directory and port. The tester must load `agent-browser skills get core` and `agent-browser skills get electron`, then take snapshots before every interaction, inspect errors and console output, assert `document.documentElement.scrollWidth - document.documentElement.clientWidth === 0`, and capture screenshots. Verify the saved customer-management PR, application rail, Saved reviews queue, direct workbench, Pierre Tree navigation, automatic streaming, command palette, console and page errors, dark mode, and no confirmation dialog entered.

- [ ] **Step 7: Commit final evidence.**

```bash
git add README.md tests/browser/milestone-9.spec.ts tests/browser/milestone-10.spec.ts tests/browser/milestone-12.spec.ts tests/browser/performance.spec.ts tests/renderer/review-workbench.ui.test.tsx tests/services/review-submission-service.test.ts
git commit -m "test: verify Pierre review workbench"
```

## Plan self-review

- Direct workbench, screen and control removal: Tasks 6 and 9.
- Current-result-only storage and confirmed discard: Tasks 1 and 2.
- Saved reviews overlapping My PRs: Task 6.
- Pierre Tree, one-way selection, virtualized scrolling, and automatic streaming: Tasks 7 and 9.
- Inline findings, manual comments, threads, replies, resolved-thread visibility, and inspector: Task 8.
- Read-only PR details and merge entry point: Task 9.
- Manual refresh, stale-head checks, receipts, partial failures, reply-only batches, and separate submit: Tasks 3 through 5.
- Renderer, browser, performance, package, CDP, accessibility, forced-color, and overflow proof: Task 10.

Placeholder scan: every task names files, interfaces, tests, commands, expected outcomes, and commit scope. Type consistency: `ReviewBatch`, `ReviewBatchItem`, `ReviewAnchor`, and `BatchOperation` are the single shared contracts across persistence, API, services, and renderer.
