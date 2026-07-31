# Plan 010: Index prepared patches for per-file hydration

> **Executor instructions**: Preserve the 1,000-file `<200ms` performance
> ceiling. Use a dedicated Patchdesk tester for any live browser verification;
> the primary implementation agent must not perform live UI steps. Update the
> index when complete.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- src/domain/patch.ts src/services/review-diff-source-service.ts src/services/review-patch-index.ts tests/services/review-diff-source-service.test.ts tests/browser/performance.spec.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

Progressive diff hydration requests several files, but the service rereads and
reparses the complete patch for every file. Large reviews therefore repeat
linear work and undermine the existing 1,000-file interaction budget. A
bounded in-memory index should parse each immutable prepared patch once and
return exact per-file slices thereafter.

## Current state

- `src/services/review-diff-source-service.ts:72-83` reads the full patch and
  calls `parseUnifiedPatch(patch).find(...)` per request.
- `patchForPath` at `src/services/review-diff-source-service.ts:229-236` splits
  the full patch again.
- `src/renderer/src/use-progressive-review-diff-stream.ts:55-57` hydrates files
  in repeated batches.
- `tests/browser/performance.spec.ts` enforces selection under 200 ms for a
  1,000-file review. Do not loosen that assertion.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused | `pnpm test -- --run tests/services/review-diff-source-service.test.ts` | all focused tests pass |
| Performance | `pnpm test:performance` | all tests pass; 1,000-file selection remains `<200ms` |
| Static | `pnpm lint && pnpm typecheck` | both exit 0 |
| Full browser | `pnpm exec playwright test` | all tests pass |

## Suggested executor toolkit

- Use `patchdesk-electron-tester` for live browser evidence if a UI check is
  needed. Return screenshots and measured evidence to the primary agent.

## Scope

**In scope**:

- `src/services/review-diff-source-service.ts`
- `src/services/review-patch-index.ts` (create)
- `src/domain/patch.ts` only if the parser must expose exact source ranges
- `tests/services/review-diff-source-service.test.ts`
- `tests/browser/performance.spec.ts` only to add coverage, never loosen limits

**Out of scope**:

- Changing renderer hydration batch sizes.
- Persisting a second patch copy to disk.
- Raising timeouts or the 200 ms ceiling.
- Changing displayed diff semantics.
- Caching unbounded sessions or bytes.

## Git workflow

- Stay on the current branch or use authorized
  `perf/index-review-patches`.
- Commit example: `perf: index prepared review patches`.
- Stage only in-scope files. Do not push.

## Steps

### Step 1: Characterize one-read, one-parse behavior

Extend the service tests with a multi-file patch including add, delete, rename,
binary, and omitted/large-file metadata. Inject or wrap the patch reader so
tests can count reads. Hydrate two or more paths from one session and assert:

- current returned metadata and raw patch text stay byte-for-byte equivalent;
- one patch read and one index construction serve all requests;
- old and new rename paths resolve consistently;
- a missing path returns the current safe absence result.

**Verify**:
`pnpm test -- --run tests/services/review-diff-source-service.test.ts`
→ count assertions fail on current repeated work.

### Step 2: Build a pure exact-slice patch index

Create `review-patch-index.ts` as a pure parser/index that stores for each file:

- parsed file metadata already used by the service;
- exact start/end offsets into the original patch string;
- aliases needed for rename old/new paths.

Return the original substring for a file; do not reconstruct hunks or normalize
line endings. If `src/domain/patch.ts` changes, keep existing public parser
results compatible and add source offsets rather than duplicating parsing.

**Verify**:
`pnpm test -- --run tests/services/review-diff-source-service.test.ts`
→ semantic and byte-equivalence cases pass.

### Step 3: Add a bounded service cache

Cache the index by immutable session/patch identity. Validate reuse with patch
file size plus modification time or a content digest; invalidate if the patch
changes. Bound the cache to 8 sessions and 32 MiB of source patch text, evicting
least-recently-used entries. Never cache a parse failure as valid.

Keep cache state inside the service instance used by local API composition.

**Verify**:
`pnpm test -- --run tests/services/review-diff-source-service.test.ts`
→ reuse, invalidation, eviction, and failure-retry tests pass.

### Step 4: Protect the measured browser budget

Keep the existing 1,000-file `<200ms` assertion unchanged. If useful, add a
separate large multi-hydration scenario without weakening the existing one.
For live inspection, dispatch a dedicated tester and retain its screenshot and
timing evidence.

**Verify**:
`pnpm test:performance`
→ all performance tests pass with the unchanged ceiling.

### Step 5: Run full gates

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm exec playwright test`
→ every command exits 0.

## Test plan

- Exact slice equivalence across patch kinds.
- One read/parse for multiple files.
- Rename aliases, missing file, invalid patch.
- Patch mutation invalidates cache.
- LRU entry and byte-cap eviction.
- Existing 1,000-file performance ceiling remains unchanged.

## Done criteria

- [ ] One prepared patch read/parse serves repeated file hydration.
- [ ] Returned patch text remains exact.
- [ ] Cache has tested entry and byte bounds.
- [ ] The `<200ms` ceiling is unchanged and passes.
- [ ] Full static/unit/build/browser gates pass.
- [ ] Only in-scope files and index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- Prepared patches are intentionally mutable during a session.
- Exact raw slices cannot be produced without changing public diff semantics.
- Meeting the test requires loosening the 200 ms ceiling.
- A live check is needed but no dedicated tester can be dispatched.
- A focused verification fails twice.

## Maintenance notes

When patch syntax support expands, add exact-slice fixtures before changing the
index. Reviewers should inspect cache bounds and invalidation, not just timing.
