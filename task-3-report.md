# Task 3 review defect evidence

## Scope

- Replaced every `v.unknown()` in `src/renderer/src/renderer-contracts.ts` with strict schemas for checks, comments, commits, insights, review results, walkthroughs, drafts, published feedback, remote context, and nested legal values.
- Added repository-relative path validation and strict nested objects so paths, prompts, provider events, raw errors, and unknown keys are rejected at the renderer boundary.
- Replaced both forbidden `import()` type annotations in `src/services/review-workbench-projection.ts` with a normal `ReviewAttempt` type import.
- Did not implement stable Review wiring, UI dispatch, or Insight lifecycle work.

## Test-first evidence

- Before production schema changes, the new nested-boundary renderer test failed because `checks[].providerEvent` was accepted.
- Before the import cleanup, the new projection source test failed because `import("../domain/review-attempt").ReviewAttempt` remained.

## Validation

- `pnpm test -- --run tests/renderer/renderer-contracts.test.ts tests/services/review-workbench-projection.test.ts` — passed (2 files, 29 tests).
- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `git diff --check -- src/renderer/src/renderer-contracts.ts src/services/review-workbench-projection.ts tests/renderer/renderer-contracts.test.ts tests/services/review-workbench-projection.test.ts` — passed.
- `v.unknown()` search in `src/renderer/src/renderer-contracts.ts` — no matches.
- `import()` type annotation search in `src/services/review-workbench-projection.ts` — no matches.

## Checkout safety

- No files staged or committed. Existing unrelated dirty checkout changes were left untouched.
