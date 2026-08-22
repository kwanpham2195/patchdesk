# Plan 008: Enforce the verified pull-request gates in CI

> **Executor instructions**: Add CI only after Plans 001 and 002 land. Use repository scripts and read-only permissions. Do not enable branch protection, publish packages, add credentials, or weaken tests. Update the plan index when complete.
>
> **Drift check (run first)**: `git diff --stat 4db4917..HEAD -- package.json pnpm-lock.yaml runtime/flue/package.json runtime/flue/pnpm-lock.yaml CONTRIBUTING.md .github scripts/lint-staged-lib.mjs playwright.config.ts`
> If test scripts, lockfile ownership, browser configuration, or changed-file quality helpers differ from this plan, reconcile before adding the workflow.

## Status

- **Status**: IN PROGRESS
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `advisor-plans/001-run-complete-test-gate.md`, `advisor-plans/002-enforce-safe-staged-quality.md`
- **Category**: dx
- **Planned at**: commit `4db4917`, 2026-08-21

## Why this matters

Patchdesk has local type, test, build, browser, and bundle gates but no independent pull-request verification. A local pre-commit hook can be skipped and does not prove the final pushed commit. CI should run the same deterministic package scripts without pretending the known repo-wide lint debt is already green.

## Current state

- `.github/` has `CODEOWNERS` and `pull_request_template.md`, but no workflow.
- `CONTRIBUTING.md:95` says there is no CI.
- Root and `runtime/flue` are separate pnpm packages with separate lockfiles.
- Root `prepare` installs and builds the nested runtime.
- Plan 001 adds `pnpm test:all` for both Vitest suites.
- Plan 002 adds a check-only source-quality library for explicit paths; `lint:staged` itself cannot be used in CI because a CI checkout has no staged files.
- `package.json` provides `typecheck`, `build`, `test:bundle`, and browser scripts.
- `CONTRIBUTING.md:9-13` requires pnpm 8.8.0, Node >=22.19.0, and macOS development.
- Package smoke is macOS release verification and is not a PR gate.

## Commands you will need

| Purpose         | Command                              | Expected on success                                |
| --------------- | ------------------------------------ | -------------------------------------------------- |
| Install         | `pnpm install --frozen-lockfile`     | both package closures install; prepare builds Flue |
| Quality         | `pnpm typecheck && pnpm test:all`    | exit 0                                             |
| Bundle          | `pnpm test:bundle`                   | build and bundle-separation check pass             |
| Browser         | `pnpm test:e2e`                      | all Playwright browser specs pass                  |
| Changed quality | `pnpm lint:changed -- <base> <head>` | changed JS/TS files are Oxfmt/Oxlint clean         |

## Scope

**In scope**:

- `.github/workflows/pr.yml` (new)
- `.github/pull_request_template.md`
- `package.json`
- `scripts/check-changed-source.mjs` (new)
- `scripts/lint-staged-lib.mjs` from Plan 002, only to expose reusable explicit-path checking if needed
- `tests/scripts/check-changed-source.test.ts` (new)
- `CONTRIBUTING.md`

**Out of scope**:

- Branch protection configuration.
- Package build/sign/notarize/smoke or release publication.
- Secrets and write permissions.
- Repo-wide `pnpm lint` or `pnpm format:check` as required gates while their untouched baseline is red.
- Dependency or lockfile updates.
- Workflow deployment to branches other than pull requests targeting `main`.

## Git workflow

- Branch: `ci/pull-request-gates`
- Suggested commits:
  1. `ci: add changed-source quality command`
  2. `ci: verify pull requests`
  3. `docs: describe pull-request checks`
- Do not enable branch protection or push unless instructed.

## Steps

### Step 1: Add an explicit merge-base changed-file command

Create `scripts/check-changed-source.mjs` and package script:

```json
"lint:changed": "node scripts/check-changed-source.mjs"
```

The command accepts exactly two commit arguments: base and head. It must:

1. validate both arguments are non-empty commit references;
2. call `git diff --name-only --diff-filter=ACMR -z <base>...<head>`;
3. filter the same JS/TS extensions used by Plan 002;
4. ignore deleted paths and configured generated/vendor paths through tool configuration;
5. call the same check-only explicit-path Oxfmt and Oxlint functions from `lint-staged-lib.mjs`;
6. never inspect the index, run autofix, or call `git add`.

Do not duplicate formatter/linter command construction. Refactor the Plan 002 library only enough to expose `checkSourcePaths(paths)` and path filtering.

**Verify**: focused changed-source tests pass for no files, rename, path with spaces, Oxfmt failure, Oxlint failure, and invalid commit arguments.

### Step 2: Add the pull-request workflow

Create `.github/workflows/pr.yml`:

- name the workflow and job with stable, concise names suitable for later branch protection;
- trigger on `pull_request` targeting `main`;
- set top-level `permissions: contents: read`;
- add concurrency keyed by workflow and PR number, with cancellation of superseded runs;
- use a macOS runner because development/browser behavior is documented on macOS;
- use checkout with enough history to compare the PR base and head;
- install pnpm 8.8.0 and Node 22.19.0 with pnpm cache;
- include both `pnpm-lock.yaml` and `runtime/flue/pnpm-lock.yaml` in cache dependency paths;
- run `pnpm install --frozen-lockfile`;
- install Playwright Chromium without adding OS packages on macOS;
- run gates in this order:
  1. changed-source Oxfmt/Oxlint check against `${{ github.event.pull_request.base.sha }}` and `${{ github.event.pull_request.head.sha }}`;
  2. `pnpm typecheck`;
  3. `pnpm test:all`;
  4. `pnpm test:bundle`;
  5. `pnpm test:e2e`.

Keep each command as a separate named step so failures are visible. Do not embed credentials or expose environment contents.

**Verify**: parse the workflow with an available YAML parser or GitHub workflow linter; no syntax errors.

### Step 3: Keep release-only work out of PR CI

Confirm the workflow does not run:

- `pnpm package:mac`;
- `pnpm test:package-smoke`;
- signing/notarization;
- deployment;
- repo-wide `pnpm lint` or `pnpm format:check`.

`test:e2e` already builds before Playwright. `test:bundle` also builds and checks bundle separation. Keep these scripts rather than copying internal commands into YAML.

**Verify**: `rg -n "package:mac|package-smoke|notar|deploy|pnpm lint$|format:check" .github/workflows/pr.yml` → no matches.

### Step 4: Update contributor and PR documentation

In `CONTRIBUTING.md`:

- replace “There is no CI yet” with the exact PR gate list;
- retain local verification requirements;
- identify `pnpm test:all` as the complete unit/runtime gate;
- explain that CI checks only changed-file formatting/lint until repo-wide debt reaches zero.

In `.github/pull_request_template.md`, clarify that the test checkbox includes the Flue runtime and that focused browser proof is still required for desktop/renderer changes.

Do not claim package smoke runs on every PR.

**Verify**: documentation names the workflow's actual commands and no longer says CI is absent.

### Step 5: Run local command verification

```bash
pnpm install --frozen-lockfile
pnpm lint:changed -- HEAD HEAD
pnpm typecheck
pnpm test:all
pnpm test:bundle
pnpm exec playwright install chromium
pnpm test:e2e
```

Expected: all exit 0. The `HEAD HEAD` changed-source command should report no changed source and succeed.

### Step 6: Validate on one real pull request

After the operator permits a push/open PR:

- confirm the workflow starts on a PR targeting `main`;
- confirm both root and Flue suites appear;
- confirm browser tests run on the expected macOS runner;
- record the exact displayed workflow/job check name before any branch protection work.

Do not configure branch protection in this plan.

## Test plan

Add `tests/scripts/check-changed-source.test.ts` with injected Git/tool execution. Cover argument validation, `BASE...HEAD` selection, rename and path handling, no-change success, formatter failure, linter failure, and no mutation commands. Workflow behavior itself is proven by a test PR, not by snapshotting YAML.

## Done criteria

- [x] A PR-targeting-main workflow exists with read-only permissions and concurrency.
- [x] CI installs both locked package closures without lockfile changes.
- [x] Changed source files are checked without index assumptions or autofix.
- [x] Typecheck, `test:all`, bundle, and browser gates run as named steps.
- [x] Release/package operations and secrets are absent.
- [ ] Local commands pass and one test PR proves the workflow.
- [x] Documentation matches the real gate.
- [x] `advisor-plans/README.md` is updated.

### Current execution note

Local verification passes. The test-PR portion remains pending until the
operator authorizes a push and pull-request creation.

## STOP conditions

- Plan 001 or Plan 002 is not complete.
- Frozen install changes either lockfile.
- The selected macOS runner is unavailable or browser behavior depends on a different platform baseline.
- Any test unexpectedly needs credentials, network API access, or external services.
- Browser failures are addressed only by weakening assertions or snapshots.
- Branch protection is requested before the real check name is observed.

## Maintenance notes

Keep project scripts authoritative and YAML orchestration thin. Add future packages to `test:all` and cache dependency paths together. When repo-wide Oxfmt/Oxlint becomes green, replace the changed-file exception in a separate reviewed change rather than silently expanding this workflow.
