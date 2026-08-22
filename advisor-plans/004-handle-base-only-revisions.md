# Plan 004: Create a new immutable session when the PR base changes

> **Executor instructions**: Follow the intentional schema-6 replacement design below. The maintainer accepts losing unsent schema-5 local review state while Patchdesk is unsettled. Do not add compatibility or migration; do prove quarantine/reprepare recovery leaves the Review usable. Run each regression gate before continuing.
>
> **Drift check (run first)**: `git diff --stat 4db4917..HEAD -- src/domain/ids.ts src/domain/review-session.ts src/services/review-session-preparation.ts src/services/review-refresh-service.ts src/adapters/storage/review-session-store.ts docs/adr/0026-prove-revision-identity-with-one-diff-renderer.md tests/services/review-refresh-service.test.ts tests/services/review-session-preparation.test.ts tests/storage/patchdesk-storage.test.ts`
> Any drift in session identity, preparation, refresh, or storage parsing requires design review before implementation.

## Status

DONE — implementation, staged quality, full tests, typecheck, and build verified.

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/003-build-typed-refresh-fixtures.md`
- **Category**: bug
- **Planned at**: commit `4db4917`, 2026-08-21

## Why this matters

Explicit refresh prepares a new session only when the head SHA changes. If the base branch advances while the PR head stays fixed, refresh can save a snapshot for the new base but retain the old patch, worktree, and session. This violates the accepted three-field revision proof and can present stale review content as fresh.

## Current state

- ADR 0026 defines revision identity as head SHA, base SHA, and canonical patch hash.
- `GitHubRevisionIdentityReader.read` already compares all three fields.
- `src/domain/review-session.ts:42-49` defines `ReviewSessionKey` with head SHA but no base SHA.
- `src/domain/ids.ts:277-300` creates session IDs from profile, PR identity, and head SHA only.
- `ReviewSessionPreparation.prepare` computes that head-only ID at `src/services/review-session-preparation.ts:140-158` and resumes a stored session with that ID at `:163-188`.
- Preparation requires a base later, but its final verification at `:286-292` checks only head SHA.
- `ReviewRefreshService.refresh` checks the second GitHub read only for head changes at `src/services/review-refresh-service.ts:583-587`.
- It prepares a replacement only when `current.value.headSha !== review.currentHeadSha` at `:647-665`.
- A simple base comparison is insufficient: head-only session lookup would resume the obsolete session.

Target invariant:

```text
New session artifact identity = PR identity + head SHA + base SHA
Remote revision proof = head SHA + base SHA + canonical GitHub patch hash
```

The patch hash remains stored evidence and must not be put into the folder/session ID: it is produced only after the immutable pair and artifact work are established. Patchdesk is still unsettled, and the maintainer explicitly accepts losing unsent local review state during this schema upgrade. Do not add legacy schema compatibility or a migration. Old sessions may be quarantined and rebuilt, but the Review must reopen successfully through the existing safe-recovery path.

## Commands you will need

| Purpose           | Command                                                                | Expected on success                            |
| ----------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| Refresh tests     | `pnpm test -- --run tests/services/review-refresh-service.test.ts`     | all pass, including base-only regressions      |
| Preparation tests | `pnpm test -- --run tests/services/review-session-preparation.test.ts` | pair capture/race tests pass                   |
| Storage tests     | `pnpm test -- --run tests/storage/patchdesk-storage.test.ts`           | schema-6 sessions load; old schema is rejected |
| Identity tests    | `pnpm test -- --run tests/domain/review.test.ts`                       | session/review identity tests pass             |
| Typecheck         | `pnpm typecheck`                                                       | exit 0                                         |
| Full gate         | `pnpm test:all && pnpm build`                                          | all pass                                       |

## Scope

**Production and decision files in scope**:

- `src/domain/ids.ts`
- `src/domain/review-session.ts`
- `src/services/review-session-preparation.ts`
- `src/services/review-refresh-service.ts`
- `src/services/review-workbench-controller.ts`
- `src/adapters/storage/review-session-store.ts`
- `docs/adr/0026-prove-revision-identity-with-one-diff-renderer.md`

**Tests in scope**:

- `tests/services/review-refresh-service.test.ts`
- `tests/services/review-refresh-fixture.ts`
- `tests/services/review-session-preparation.test.ts`
- `tests/services/review-workbench-controller.test.ts`
- `tests/storage/patchdesk-storage.test.ts`
- `tests/domain/review.test.ts`
- Every direct session-ID fixture caller required by the new key and schema. Find the exact list with `rg -l 'createReviewSessionId|schemaVersion: 5' src tests` before editing.

**Out of scope**:

- Changing canonical diff rendering or hashing.
- Deleting old session artifacts during refresh.
- Carrying pending-review or draft state into the new revision.
- Preserving or migrating schema-5 session state; accepted local draft loss is part of this upgrade.
- Remote-candidate garbage collection.
- New renderer/API error vocabulary; retain the existing `head_changed` race response as the wire-compatible changed-revision signal for this plan.
- General review detection redesign. Production detection already uses `ReviewObservationService` and complete identity proof.

## Git workflow

- Branch: `fix/base-only-review-revision`
- Suggested commits:
  1. `test(refresh): cover base-only revision changes`
  2. `fix(session): distinguish immutable base revisions`
  3. `fix(refresh): adopt sessions for changed base`
  4. `docs(adr): clarify base-aware session identity`
- Do not push unless instructed.

## Steps

### Step 1: Add failing refresh regressions

Using the typed fixture from Plan 003, add tests for:

1. same head and same base: no preparation; current session retained;
2. same head and changed base: preparation called once; a distinct session is saved and selected;
3. base changes between the first and final GitHub reads: refresh fails with the existing changed-revision failure and does not save the Review or clear the recent-write journal;
4. prepared session returns the expected head but wrong base: refresh refuses adoption;
5. a schema-5 current session is rejected by storage and the workbench open path quarantines/rebuilds it as schema 6.

The changed-base test must assert that old pending-review state is not copied into the new session. The recovery test may assert that schema-5 pending state is lost; this is explicitly accepted for this unsettled-app upgrade.

**Verify**: focused refresh test run → the new changed-base cases fail under current production code for the expected reason.

### Step 2: Make the base discriminator required and bump the session schema

In `src/domain/review-session.ts`, make `baseSha` a required member of `ReviewSessionKey`. Bump `ReviewSession.schemaVersion` from 5 to 6. Every newly constructed session must contain the exact head/base pair in its key.

In `src/domain/ids.ts`, change `createReviewSessionId` so it:

- requires `baseSha`;
- includes `__base-<first 8>` in the readable part;
- includes the full base SHA in the collision input;
- gives different IDs to the same PR/head with different bases;
- retains the existing profile/host/owner/repo/PR/head collision inputs.

Update every production caller and test fixture. Do not retain an overload, optional base, old-ID alias, or compatibility re-export.

Add tests proving deterministic base-aware IDs and same-head/different-base separation.

**Verify**: identity tests and typecheck pass; `rg -n 'createReviewSessionId\\(' src tests` shows every caller supplies a base SHA.

### Step 3: Accept only schema-6 session records

Update `src/adapters/storage/review-session-store.ts` so writes and reads require schema 6 and a required key base SHA. During decode:

- validate the ID with the required head/base pair;
- require key base to equal `pr.baseSha`;
- keep the checks that key head, PR head, and worktree head match;
- return `invalid_stored_value` for schema-5/head-only records.

Do not implement schema-5 parsing, migration, backfill, or draft extraction. Add storage tests for valid schema 6, mismatched key/PR base rejection, and explicit schema-5 rejection.

**Verify**: `pnpm test -- --run tests/storage/patchdesk-storage.test.ts` → schema-6 cases pass and schema 5 is rejected as `invalid_stored_value`.

### Step 4: Capture the full immutable pair before session lookup

Change `ReviewSessionPreparation.prepare`:

1. First PR read must contain `baseSha`; otherwise return `PreparationUnavailable` before creating an ID or journal.
2. Capture `{headSha, baseSha}` as one immutable pair.
3. Build the session key/ID with both values.
4. Pass the pair through `prepareCurrent` and `commit` rather than passing head alone.
5. At the second PR read, require both values to match before worktree/artifact creation.
6. Use the captured base for worktree preparation and artifact reads.
7. At the final PR read, require both values to match before marking the journal committing or saving the session.
8. Create the schema-6 session key with the required base and store the same base in `session.pr`.

Use a small named pair type or equality helper. Do not duplicate ad hoc comparisons.

Add tests where only base changes during preparation. Assert no committed session and journal abort/cleanup behavior matches existing head-race behavior.

**Verify**: focused preparation tests pass.

### Step 5: Make explicit refresh pair-aware

In `ReviewRefreshService.refresh`:

- Validate the current loaded session belongs to the Review as today.
- Capture the first fetched pair; missing base is unavailable and must not be adopted.
- After the parallel GitHub reads, compare both head and base on the final PR read.
- Determine replacement need from the current schema-6 session's represented pair, not only `review.currentHeadSha`: prepare when either head or base differs.
- Call preparation for any replacement need.
- Before saving the prepared session, require both prepared head and prepared base to equal the captured pair.
- Save the candidate, session, and Review only under the same pair.
- Clear the recent-write journal only after durable Review adoption, as today.

Keep `Review.currentHeadSha` head-only. `Review.currentSessionId` selects the base/patch-specific session.

**Verify**: focused refresh tests pass, including all new same-head/base-changed and torn-read cases.

### Step 6: Prove schema-upgrade recovery through the workbench boundary

Extend `tests/services/review-workbench-controller.test.ts` using the existing unusable-session recovery cases around `quarantineIfPresent`:

1. load a Review whose current session record is schema 5 and therefore returns `invalid_stored_value`;
2. assert the controller quarantines the old session and Review through the existing restart path;
3. assert preparation creates a schema-6 head/base-aware session;
4. assert opening completes with a usable projection instead of leaving the PR blocked;
5. do not assert preservation of pending review, receipts, or direct-summary state.

This is the required safety boundary: accepted local data loss must still result in deterministic recovery. Do not add a migration to satisfy the test.

**Verify**: `pnpm test -- --run tests/services/review-workbench-controller.test.ts` → schema-5 recovery opens a new schema-6 Review and all existing transient-failure cases still fail closed.

### Step 7: Clarify ADR wording

Update ADR 0026 where it says session identity embeds only the head SHA and where it previously preserved schema 5. Record the new decision:

- session identity embeds the immutable head/base pair;
- canonical hash remains separate stored proof from GitHub compare output;
- schema 6 intentionally invalidates schema-5 sessions;
- Patchdesk is unsettled and the maintainer accepts loss of unsent local review state for this upgrade;
- invalid records use quarantine/reprepare recovery and the Review must reopen;
- new revision preparation never copies old draft state.

Do not change the accepted canonical-renderer decision. Do not add a general `AGENTS.md` instruction requiring preservation of old session state.

**Verify**: `rg -n "schema 6|head.*base|quarantine|unsent" docs/adr/0026-prove-revision-identity-with-one-diff-renderer.md` → the upgrade and recovery decision is explicit.

### Step 8: Run full verification

```bash
pnpm typecheck
pnpm test -- --run tests/services/review-refresh-service.test.ts tests/services/review-session-preparation.test.ts tests/services/review-workbench-controller.test.ts tests/storage/patchdesk-storage.test.ts tests/domain/review.test.ts
pnpm test:all
pnpm build
```

Expected: every command exits 0. Because this changes main/service code, restart the dev app before any live read-only verification.

## Test plan

Regression tests must prove behavior and non-effects:

- changed base creates a different immutable session;
- unchanged pair does not prepare;
- base races abort without Review adoption or journal clear;
- preparation races leave no committed artifacts/session;
- schema-5 sessions are rejected, quarantined, and replaced through workbench recovery;
- mismatched stored base evidence is rejected;
- old drafts are not copied; their loss during this explicit upgrade is accepted.

Use existing head-race tests in `review-refresh-service.test.ts` and `review-session-preparation.test.ts` as structural patterns.

## Done criteria

- [ ] New session IDs distinguish same-head/different-base revisions.
- [ ] Schema 6 requires a head/base-aware ID and schema-5 records are rejected.
- [ ] Preparation captures and verifies both SHA values at every race boundary.
- [ ] Explicit refresh prepares and adopts a new session for base-only changes.
- [ ] Candidate, session, and Review cannot represent different SHA pairs.
- [ ] Workbench open quarantines an invalid schema-5 session and rebuilds a usable schema-6 Review without migrating drafts.
- [ ] Canonical hash behavior remains unchanged.
- [ ] Focused tests, `test:all`, typecheck, build, and staged quality pass.
- [ ] `advisor-plans/README.md` is updated.

## STOP conditions

- A schema-5 session failure leaves the Review unable to reopen through the existing restart path.
- The upgrade attempts to preserve or migrate schema-5 draft state despite the explicit no-compatibility decision.
- Patch hash must be known before selecting the session path; report the circular dependency rather than improvising.
- A new public error reason appears necessary.
- Cleanup expands beyond quarantine of records invalidated by this explicit schema upgrade.
- Any step changes GitHub canonical diff production.

## Maintenance notes

Every future code path that creates a production session must supply a base SHA. There is no schema-5 compatibility path. Reviewers should trace both flows: changed-base refresh through distinct ID and durable adoption, and schema-5 open through quarantine, fresh preparation, and a usable projection.
