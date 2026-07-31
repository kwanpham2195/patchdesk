# Plan 011: Paginate review threads and replies

> **Executor instructions**: Follow the plan exactly. Preserve partial-data
> honesty when caps are reached. Update `advisor-plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- src/domain/github-context.ts src/adapters/github/github-adapter.ts src/services/review-workbench-projection.ts src/renderer/src/components/pr-overview-sheet.tsx tests/adapters/github-adapter.test.ts tests/services/review-workbench-projection.test.ts tests/browser/review-workbench.spec.ts fixtures/github`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

The GitHub adapter fetches only the first 100 review threads and first 100
comments per thread, but the UI presents the returned length as complete.
Large or long-lived reviews silently omit conversation. The adapter must
paginate within explicit caps and the UI must label capped or incomplete data.

## Current state

- `src/adapters/github/github-adapter.ts:37` requests
  `reviewThreads(first: 100)` and nested `comments(first: 100)` with no
  `pageInfo`.
- The response schema around line 92 has no pagination metadata.
- `getPullRequestComments` at lines 451-511 performs one GraphQL call.
- `src/renderer/src/components/pr-overview-sheet.tsx:105` displays the returned
  count as exact.
- Existing adapter tests and `fixtures/github/` record GraphQL argv and payload
  shapes; update both together.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Adapter | `pnpm test -- --run tests/adapters/github-adapter.test.ts` | all adapter tests pass |
| Projection | `pnpm test -- --run tests/services/review-workbench-projection.test.ts` | all projection tests pass |
| Browser | `pnpm exec playwright test tests/browser/review-workbench.spec.ts` | all workbench tests pass |
| Static/unit | `pnpm lint && pnpm typecheck && pnpm test -- --run` | all commands exit 0 |

## Suggested executor toolkit

- Use `patchdesk-electron-tester` for any live browser verification and return
  screenshots plus the visible incomplete-data label.

## Scope

**In scope**:

- `src/domain/github-context.ts`
- `src/adapters/github/github-adapter.ts`
- `src/services/review-workbench-projection.ts`
- `src/renderer/src/components/pr-overview-sheet.tsx`
- `tests/adapters/github-adapter.test.ts`
- `tests/services/review-workbench-projection.test.ts`
- `tests/browser/review-workbench.spec.ts`
- task-specific files under `fixtures/github/`

**Out of scope**:

- Streaming comments into the renderer.
- Editing or resolving GitHub threads.
- Infinite/unbounded pagination.
- Hiding incomplete results.
- Remote writes.

## Git workflow

- Stay on the current branch or use authorized
  `fix/paginate-review-threads`.
- Commit example: `fix: paginate review conversations`.
- Stage explicit in-scope paths. Do not push.

## Steps

### Step 1: Add completeness to the domain contract

Extend the review-comments result with `complete: boolean` and a finite
`incompleteReason` when false. If individual thread completeness is visible to
the workbench, add the same flag per thread. Keep all existing comment/thread
fields compatible.

Add projection tests proving complete data has an exact count and incomplete
data receives a distinct display model such as `100+` plus
`Some conversation was not loaded`.

**Verify**:
`pnpm test -- --run tests/services/review-workbench-projection.test.ts`
→ completeness projection tests pass.

### Step 2: Paginate the outer thread connection

Change the thread query and strict response schema to include
`pageInfo { hasNextPage endCursor }`. Loop with a cursor and named caps:
10 pages and 1,000 threads. Preserve stable GraphQL variables and append pages
in server order. Mark the result incomplete if the cap is reached or a cursor
does not advance.

**Verify**:
`pnpm test -- --run tests/adapters/github-adapter.test.ts`
→ two-page, cap, and non-advancing-cursor cases pass.

### Step 3: Paginate replies for long threads

The nested connection cannot paginate every thread in the outer loop. Include
comment `pageInfo` in the outer response, then issue a focused follow-up query
only for threads whose comments have another page. Use the thread node ID and
comment cursor.

Cap each thread at 10 pages/1,000 comments and cap the total response at 5,000
comments. Mark thread/result incomplete when any cap or response failure is
reached; retain successfully loaded earlier pages.

Preserve the adapter's current mapping of thread location to its first comment.

**Verify**:
`pnpm test -- --run tests/adapters/github-adapter.test.ts`
→ nested two-page, mixed-thread, cap, and partial-failure fixtures pass.

### Step 4: Present incomplete data honestly

Update the projection and PR overview to avoid an exact count when
`complete === false`. Reuse existing text and warning primitives; do not add a
new dependency. Add a browser fixture/scenario showing the incomplete label.

**Verify**:
`pnpm exec playwright test tests/browser/review-workbench.spec.ts`
→ all workbench tests pass, including incomplete-conversation UI.

### Step 5: Run repository gates

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm exec playwright test`
→ every command exits 0.

## Test plan

- Single and multiple outer pages.
- Multiple comment pages for one and several threads.
- Non-advancing cursor, page/item caps, and later-page failure.
- Ordering and location mapping remain stable.
- UI exact count for complete data and partial label for incomplete data.

## Done criteria

- [ ] Threads and replies paginate within named caps.
- [ ] Cap/failure state is represented in the domain.
- [ ] UI never presents partial length as exact.
- [ ] Adapter fixtures, unit tests, and browser gates pass.
- [ ] Only in-scope files and index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- Supported GitHub Enterprise GraphQL lacks the required connection fields.
- Pagination requires a token scope not already part of the read contract.
- The renderer contract is consumed externally and cannot add completeness
  without a product migration.
- Live UI verification is needed but no dedicated tester can be dispatched.
- A focused verification fails twice.

## Maintenance notes

Keep page and item caps named and tested. Any future UI count must carry
completeness rather than deriving truth from array length alone.
