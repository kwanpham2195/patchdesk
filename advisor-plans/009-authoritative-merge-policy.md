# Plan 009: Fetch authoritative merge-policy state

> **Executor instructions**: Complete Plans 007 and 008 first. This plan must
> fail closed when GitHub policy data is incomplete. Update
> `advisor-plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- src/domain/github-context.ts src/domain/merge-readiness.ts src/adapters/github/github-adapter.ts src/services/merge-service.ts tests/domain/merge-readiness.test.ts tests/adapters/github-adapter.test.ts tests/services/merge-service.test.ts fixtures/github`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/007-characterize-review-run-merge-apis.md`,
  `advisor-plans/008-serialize-reconcile-merge-writes.md`
- **Category**: bug
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

The merge path currently treats review state and required-check classification
as unknown, while readiness blocks only checks explicitly marked required.
That can label a request ready or allow a merge without authoritative branch
policy. Every merge attempt must fetch a fresh policy snapshot for the exact
head and block when required approvals/checks cannot be proven.

## Current state

- `src/adapters/github/github-adapter.ts:1189-1203` maps the REST PR with
  `reviewState: "unknown"`.
- `src/adapters/github/github-adapter.ts:1303-1325` projects checks with
  `required: "unknown"`.
- `src/domain/merge-readiness.ts:49-54` blocks only when
  `check.required === true`.
- `src/services/merge-service.ts:39-64` fetches checks and PR immediately before
  readiness evaluation.
- The inbox GraphQL path already parses `reviewDecision` through
  `mapReviewDecision`; reuse its vocabulary, not cached inbox state.
- Explicit warning acknowledgement is not permission to bypass branch
  protection or required review policy.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused | `pnpm test -- --run tests/domain/merge-readiness.test.ts tests/adapters/github-adapter.test.ts tests/services/merge-service.test.ts` | all focused tests pass |
| Fixture check | `rg -n "reviewDecision|requiredStatus|statusCheckRollup|pageInfo" fixtures/github tests/adapters/github-adapter.test.ts` | new policy fixtures/assertions are present |
| Static | `pnpm lint && pnpm typecheck` | both exit 0 |
| Unit gate | `pnpm test -- --run` | all tests pass |

## Scope

**In scope**:

- `src/domain/github-context.ts`
- `src/domain/merge-readiness.ts`
- `src/adapters/github/github-adapter.ts`
- `src/services/merge-service.ts`
- `tests/domain/merge-readiness.test.ts`
- `tests/adapters/github-adapter.test.ts`
- `tests/services/merge-service.test.ts`
- task-specific files under `fixtures/github/`

**Out of scope**:

- Bypassing GitHub branch protection.
- Using cached inbox data for a merge decision.
- Admin override or auto-merge.
- Treating an unavailable policy query as ready.
- Changing explicit UI confirmation requirements.

## Git workflow

- Complete Plans 007 and 008. Stay on the operator branch or use authorized
  `fix/authoritative-merge-policy`.
- Commit example: `fix: enforce authoritative merge policy`.
- Stage explicit in-scope paths. Do not push.

## Steps

### Step 1: Define a complete merge-policy snapshot

In `src/domain/github-context.ts`, add a focused type containing:

- repository and PR identity;
- exact head SHA;
- review decision with explicit `approved`, `changes_requested`,
  `review_required`, and `unknown`;
- checks with name, terminal status/conclusion, and required
  `true | false | "unknown"`;
- `complete: boolean` plus a finite incomplete reason.

Update readiness tests first. An unknown review requirement, unknown required
classification, head mismatch, pagination cap, or API failure must create a
blocking result, not a warning that can be acknowledged.

**Verify**:
`pnpm test -- --run tests/domain/merge-readiness.test.ts`
→ new fail-closed cases pass after the domain change.

### Step 2: Fetch fresh review and branch-protection data

Add a dedicated GitHub adapter method for merge policy rather than overloading
the general inbox summary. Query the target PR at the expected head and fetch:

- GraphQL `reviewDecision`;
- current status/check rollup contexts;
- branch-protection required status check contexts using the supported GitHub
  API for the PR base branch.

Paginate every connection and apply named page/item caps. Join required
contexts to current head checks by GitHub's documented context identity. If
permissions, Enterprise schema, pagination, or mapping prevent a complete
answer, return `complete: false`.

Update command-argument fixtures and response fixtures. Do not use web data in
tests.

**Verify**:
`pnpm test -- --run tests/adapters/github-adapter.test.ts`
→ approved, review-required, required-check, head-mismatch, paginated, and
permission-denied fixtures all pass.

### Step 3: Make merge service consume only the authoritative snapshot

Immediately before the durable remote-write boundary from Plan 008,
`MergeService` must fetch the new policy snapshot for `session.headSha`.
Remove the old composition of generic PR summary plus check projection from
the merge decision.

Block when the snapshot is incomplete, stale, requests changes/review, or has a
pending/failing required check. Preserve warning acknowledgements only for
non-policy warnings already modeled by the domain.

**Verify**:
`pnpm test -- --run tests/services/merge-service.test.ts`
→ no GitHub merge write occurs for incomplete/stale/blocked policy; one occurs
for a complete ready snapshot.

### Step 4: Run static and unit gates

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run`
→ every command exits 0.

## Test plan

- Review approved, changes requested, review required, and unknown.
- Required check success, pending, failure, missing, and unknown mapping.
- Head mismatch between session and policy snapshot.
- Pagination completion and cap reached.
- Branch-protection permission failure fails closed.
- No remote merge call for every blocked case.

## Done criteria

- [ ] Merge readiness uses a fresh exact-head policy snapshot.
- [ ] Required review and check state is authoritative or merge is blocked.
- [ ] Cached inbox summaries no longer drive merge decisions.
- [ ] Warning acknowledgement cannot bypass incomplete policy.
- [ ] Focused and full gates pass.
- [ ] Only in-scope files and index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- Plans 007 or 008 are not complete.
- Supported GitHub/GitHub Enterprise APIs cannot classify required checks with
  the available token permissions.
- A product decision is needed for organizations without branch-protection
  read permission.
- The change would silently weaken fail-closed behavior.
- A focused verification fails twice.

## Maintenance notes

GitHub API versions and Enterprise schemas can drift. Reviewers should verify
fixtures cover incomplete permissions and that every new merge policy input
defaults to blocked until proven complete.
