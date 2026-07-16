# Patchdesk Phase 1 — Milestone 4 report

Status: complete

## Scope delivered

- Added a read-only GitHub Adapter behind an explicit-argv `CommandRunner`.
- Added typed, safe classifications for timeout, unavailable command, missing local GitHub authentication, nonzero exit, and invalid JSON. Raw stdout and stderr remain inside the process boundary and do not enter adapter failures.
- Added reads for open PRs, one PR snapshot, review conversation threads, check runs, patch diff, and `gh auth status` account resolution. No GitHub write method exists.
- Added a fixture-only `FakeGitHubAdapter` so later dashboard and review tests can supply GitHub data without a process, filesystem, or network call.
- Added checked-in golden argv and response-payload fixtures for every read/auth command. The diff path runs `gh pr diff` first, and only attempts `git diff` when the caller supplies validated, explicit fetched-ref evidence.

## TDD evidence

Red:

```text
pnpm test -- --run github-adapter
```

The first run failed because `src/adapters/github/command-runner` did not exist. The test suite defined the desired boundary and golden argv contracts before production code was added.

Green:

```text
pnpm test -- --run github-adapter
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm exec prettier --check src/adapters/github src/domain/github-context.ts tests/adapters/github-adapter.test.ts fixtures/github/argv
git diff --check
```

Results: the focused adapter suite passed 8 tests. The full suite passed 70 tests across 7 files; lint, strict typecheck, Prettier, and diff checks passed.

## Scope boundary

No live `gh` command was run during this milestone. The adapter never reads, persists, returns, or logs token values; authentication is resolved only with `gh auth status` inside the adapter. Dashboard UI, GitHub writes, worktree fetching, and fetched-ref creation remain out of scope.

## Review fixes

- Replaced the unsupported `gh auth status --user` argv with the supported hostname-only status command. The adapter confirms that its safe status output identifies the configured account, and every status failure or mismatch becomes `GitHubAuthenticationFailed` (`github_auth`) without exposing command output.
- Strengthened diff fallback evidence: the adapter now verifies both Patchdesk-managed refs with `git rev-parse --verify --quiet --end-of-options`, parses the resolved commits, and requires them to match the expected fetched SHAs before it runs `git diff`. Missing or mismatched refs stop the fallback.
- Added `fixtures/github/payloads/malformed-get-pr.json`, which is valid JSON but fails the GitHub response contract and is classified as `GitHubResponseInvalid`.

Review-fix TDD red proof:

```text
pnpm test -- --run github-adapter
```

Before the changes, 4 new regression tests failed: the auth argv still had `--user`, fallback accepted syntactic ref names without resolving them, an account mismatch passed, and the malformed response fixture was absent.

Review-fix green verification:

```text
pnpm test -- --run github-adapter
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm exec prettier --check src/adapters/github src/domain/github-context.ts tests/adapters/github-adapter.test.ts fixtures/github .superpowers/sdd/milestone-4-report.md
git diff --check
```

Results: focused adapter tests passed 12 tests. The full suite passed 74 tests across 7 files; lint, strict typecheck, Prettier, and diff checks passed.

## Active-account fix

`gh auth status --hostname` can list multiple accounts, so successful status is insufficient by itself. The adapter now parses its account blocks and accepts the configured `ghAccount` only when that same block contains `Active account: true`; a listed inactive account is classified as `GitHubAuthenticationFailed` (`github_auth`).

Red proof:

```text
pnpm test -- --run github-adapter
```

The new inactive-account regression failed because the prior parser accepted any matching account line.

Green verification:

```text
pnpm test -- --run github-adapter
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm exec prettier --check src/adapters/github src/domain/github-context.ts tests/adapters/github-adapter.test.ts fixtures/github .superpowers/sdd/milestone-4-report.md
git diff --check
```

Results: focused adapter tests passed 13 tests. The full suite passed 75 tests across 7 files; lint, strict typecheck, Prettier, and diff checks passed.
