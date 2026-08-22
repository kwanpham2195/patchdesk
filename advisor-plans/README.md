# Patchdesk Advisor Plans

Generated from the standard Patchdesk improvement audit on 2026-08-21 and reconciled at commit `4db4917`. These plans cover all ten vetted findings selected by the maintainer. Execute in the order below unless a dependency explicitly permits parallel work.

Every executor must:

1. read its plan fully before editing;
2. run the drift check first;
3. honor in-scope/out-of-scope boundaries and STOP conditions;
4. run every listed verification command;
5. update the status row when work finishes or blocks;
6. avoid pushes, PRs, branch-protection changes, and GitHub writes unless the operator explicitly requests them.

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED — <reason>`, `REJECTED — <reason>`.

## Execution order and status

| Plan                                          | Title                                                        | Priority | Effort | Depends on | Status |
| --------------------------------------------- | ------------------------------------------------------------ | -------- | ------ | ---------- | ------ |
| [001](001-run-complete-test-gate.md)          | Make the complete test gate run root and Flue runtime tests  | P1       | S      | —          | DONE   |
| [002](002-enforce-safe-staged-quality.md)     | Enforce a safe touched-file formatting and lint ratchet      | P1       | M      | —          | DONE   |
| [003](003-build-typed-refresh-fixtures.md)    | Replace repeated refresh dependency bags with typed fixtures | P1       | L      | 002        | DONE   |
| [004](004-handle-base-only-revisions.md)      | Create a new immutable session when the PR base changes      | P1       | L      | 003        | DONE   |
| [005](005-own-retention-scheduler.md)         | Stop retention scheduling with the Local API server          | P2       | M      | 001        | DONE   |
| [006](006-remove-merge-module-mock.md)        | Test merge orchestration through the real merge service      | P2       | M      | 002        | DONE   |
| [007](007-relocate-executable-discovery.md)   | Move executable discovery into the adapter layer             | P3       | S      | 002        | TODO   |
| [008](008-add-pr-ci.md)                       | Enforce the verified pull-request gates in CI                | P1       | M      | 001, 002   | TODO   |
| [009](009-decompose-review-workbench-flow.md) | Decompose ReviewWorkbenchFlow by protocol responsibility     | P2       | L      | 001, 002   | TODO   |
| [010](010-decompose-review-diff-surface.md)   | Decompose ReviewDiffSurface by state-machine concern         | P2       | L      | 001, 002   | TODO   |

## Dependency notes

- **001 before 008**: CI must call one canonical command that includes the isolated Flue runtime suite.
- **002 before 003, 006, 007, 009, and 010**: every touched source file must be safely formatted and lint-clean without auto-staging unrelated work.
- **003 before 004**: the base-revision correction needs readable typed fixtures and high-signal race tests before session identity changes.
- **004 intentionally upgrades sessions to schema 6 without schema-5 compatibility or migration**. The maintainer accepts loss of unsent schema-5 local state while the app is unsettled; workbench quarantine/reprepare recovery must still reopen the Review.
- **001 and 002 can run in parallel** because they touch different script concerns; reconcile the `package.json` hunks normally when landing both.
- **005, 006, and 007 can run in parallel** after their prerequisites because they have disjoint production/test ownership.
- **009 and 010 must remain separate refactors**. They can run in parallel only in isolated worktrees; both touch renderer verification surfaces and should not share one working checkout writer.
- **008 should land before branch protection is considered**. Branch protection itself is not part of these plans.

## Finding-to-plan map

1. Root verification omitted Flue runtime tests → Plan 001.
2. Same-head/base-changed refresh could retain stale session artifacts → Plans 003 and 004; 003 is enabling test work.
3. Repo-wide lint debt lacked a safe actionable policy → Plan 002, revised to a touched-file ratchet rather than bulk cleanup.
4. `ReviewWorkbenchFlow` mixed unrelated protocols and imported service implementation modules → Plan 009.
5. `ReviewDiffSurface` mixed renderer, hydration, navigation, scroll, and authoring state machines → Plan 010.
6. Refresh tests repeated large invalid dependency bags → Plan 003.
7. Retention scheduling outlived Local API stop → Plan 005.
8. Pull requests had no independent verification → Plan 008.
9. Merge controller tests patched the merge-service module → Plan 006.
10. Executable discovery lived in the Electron composition layer → Plan 007.

## Verification policy across plans

- `pnpm typecheck` must pass.
- After Plan 001, `pnpm test:all` is the complete root plus Flue test gate.
- Repo-wide `pnpm lint` and `pnpm format:check` are known red from untouched legacy files; they are not completion gates for these plans.
- After Plan 002, every touched JS/TS file must pass the check-only staged quality gate. No plan may weaken rules or add dishonest casts/comments.
- Update mandatory commands and hook behavior in `AGENTS.md` only after the implementing plan has passed its verification; do not document future behavior as current behavior.
- Desktop or renderer plans must run `pnpm build`, focused browser coverage, and read-only live Electron QA when their plan requires it.
- Package smoke remains release-only unless explicitly requested.

## Direction item not converted into a build plan

Chunked Walkthrough processing for patches over the current size limit remains a product/design option, not a vetted defect. It was intentionally excluded from these implementation plans because aggregation, cancellation, revision binding, and bounded model-output behavior need a separate design spike and maintainer decision.

## Findings considered and rejected

- **Delete many tests because the suite is large**: rejected. The root suite is fast and most cases protect distinct safety behavior. Plans consolidate unsafe scaffolding without broad test deletion.
- **Split `github-adapter.ts` solely because it is large**: rejected. It is a deliberate GitHub authority boundary; no concrete split with better locality was proven.
- **Split all 52 Local API routes solely because `local-api.ts` is large**: rejected. Central capability/origin middleware and composition are deliberate. Plan 005 extracts only the lifecycle-owned scheduler with a concrete defect.
- **Treat every `vi.fn` as a mock smell**: rejected. Recording callbacks and injected fake seams are valid. Plan 006 removes the one unsuppressed module patch that bypasses production behavior.
- **Bulk-fix all existing lint diagnostics before other work**: rejected. The maintainer selected a touched-file ratchet; untouched debt must not block focused changes.
- **Make repo-wide lint/format required in CI immediately**: rejected while their untouched baseline is red. Plan 008 checks only changed source through a merge-base command.
- **Dependency migration or vulnerability remediation**: no supported finding. Production audit reported no known high-severity dependency vulnerability.
- **Security rewrite of loopback authentication**: rejected. The audited route stack applies capability and exact-origin checks before protected routes; no concrete bypass was found.

## Review notes

- Plans were reconciled against a clean `main` checkout at `4db4917`, which was seven commits ahead of `origin/main` at completion time.
- The audit was hotspot-weighted, not a line-by-line whole-repository proof.
- Full live Electron QA, package smoke, and all Playwright suites were not run during planning; the relevant plans require them during execution.
- Three reviewer workstreams were retained for detailed planning research after the maintainer limited delegation; all final excerpts and design claims were independently checked against repository files before these plans were written.
