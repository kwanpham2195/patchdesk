# Plan 002: Validate preparation-journal cleanup paths

> **Executor instructions**: Execute each step and verification in order.
> Stop and report instead of broadening scope. Update this plan's status in
> `advisor-plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- src/services/review-preparation-journal.ts tests/services/review-preparation-journal.test.ts`
> Compare live code with the excerpts below if either file changed.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

Recovery reads cleanup targets from a persisted JSON journal and recursively
deletes them. The parser currently accepts arbitrary strings, so a corrupt or
tampered journal can direct cleanup outside Patchdesk-owned storage. Recovery
must validate every path against identifiers and `PatchdeskPaths` before the
first delete occurs.

## Current state

- `src/services/review-preparation-journal.ts:157-180` recursively removes
  stored targets and the stored staging root.
- `src/services/review-preparation-journal.ts:189-224` invokes cleanup during
  automatic recovery.
- `src/services/review-preparation-journal.ts:334-358` accepts raw strings for
  `stagingRoot` and `targets`:

```ts
if (typeof value.stagingRoot !== "string") return undefined;
if (!Array.isArray(value.targets) ||
    !value.targets.every((target) => typeof target === "string")) {
  return undefined;
}
```

- `tests/services/review-preparation-journal.test.ts` already constructs
  isolated `PatchdeskPaths.forTest(root)` fixtures. Continue using that seam.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `pnpm test -- --run tests/services/review-preparation-journal.test.ts` | all focused tests pass |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Unit gate | `pnpm test -- --run` | all tests pass |

## Scope

**In scope**:

- `src/services/review-preparation-journal.ts`
- `tests/services/review-preparation-journal.test.ts`

**Out of scope**:

- Changing app-owned directory locations.
- Deleting active or completed review data.
- Broad cleanup of old journals.
- Compatibility with arbitrary external cleanup targets.

## Git workflow

- Stay on the current branch unless the operator authorizes
  `fix/validate-preparation-cleanup`.
- Conventional commit example:
  `fix: validate preparation cleanup paths`.
- Stage only the two in-scope files. Do not push.

## Steps

### Step 1: Add malicious-journal regression coverage

Extend the journal tests with hand-written persisted JSON that uses valid
profile/session fields but supplies:

- an absolute target outside the `PatchdeskPaths.forTest` root;
- a lexical `..` escape;
- a symlink inside the staging area that points to an outside sentinel;
- a staging root that does not equal the path derived from the journal's
  branded identifiers.

For every case, create an outside sentinel and assert recovery returns a
validation failure without deleting any target. Also retain a valid recovery
case that proves all intended staging targets are removed.

**Verify**:
`pnpm test -- --run tests/services/review-preparation-journal.test.ts`
→ malicious cases fail against current code and the valid case passes.

### Step 2: Validate the entire deletion set before cleanup

In `ReviewPreparationJournal`, add one private validation path that:

1. parses profile/session/attempt identifiers with the existing domain
   parsers rather than casting;
2. derives the expected journal, staging-root, target, and worktree locations
   from the injected `PatchdeskPaths`;
3. requires exact equality for fixed locations and canonical containment for
   generated child paths;
4. rejects symlinked deletion roots and paths whose canonical parent escapes;
5. returns a complete validated deletion set before any `rm` call runs.

Do not delete a subset and then discover that a later target is invalid.
Treat an invalid journal as recoverable diagnostic state: report it to the
caller and leave the journal and filesystem evidence intact.

**Verify**:
`pnpm test -- --run tests/services/review-preparation-journal.test.ts`
→ all malicious and valid cleanup tests pass.

### Step 3: Preserve valid create/commit/recover behavior

Add assertions covering `begin`, committed-journal removal, and automatic
recovery of an interrupted valid preparation. Confirm the validated path set
matches exactly what `begin` writes.

**Verify**:
`pnpm test -- --run tests/services/review-preparation-journal.test.ts`
→ all focused tests pass.

### Step 4: Run the repository gates

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run`
→ every command exits 0.

## Test plan

- Outside absolute target survives.
- Lexical escape survives.
- Symlink escape survives.
- Mismatched staging root causes zero deletion.
- Valid interrupted preparation cleans only its owned paths.
- Committed journal behavior remains unchanged.

## Done criteria

- [ ] No recursive removal occurs before all persisted paths are validated.
- [ ] Cleanup paths are derived from parsed IDs and injected `PatchdeskPaths`.
- [ ] Invalid journals preserve evidence and outside sentinels.
- [ ] Focused tests and the static/unit gates pass.
- [ ] Only in-scope files and the index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- A documented storage contract intentionally permits arbitrary external
  cleanup targets.
- `PatchdeskPaths` cannot derive the paths written by `begin`.
- Validation would require deleting or migrating existing user data.
- A focused verification fails twice.

## Maintenance notes

Any future journal field that can influence deletion belongs in the same
all-or-nothing validator. Reviewers should look for unresolved path strings,
symlink traversal, and partial cleanup before rejection.
