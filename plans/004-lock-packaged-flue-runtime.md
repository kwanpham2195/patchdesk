# Plan 004: Make the packaged Flue runtime reproducible

> **Executor instructions**: Follow this plan step by step. Run every
> verification and confirm the expected result before continuing. This plan
> locks the current Flue beta.9 runtime only; it must not start the Flue 2 API
> migration. If a STOP condition occurs, stop and report. When done, update the
> status row in `plans/README.md` unless a reviewer maintains the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 7b4f6e6..HEAD -- \
>   package.json pnpm-lock.yaml scripts/stage-flue-runtime.mjs \
>   scripts/package-smoke.mjs src/main/workflow-runtime-root.ts \
>   tests/main-desktop-hardening.test.ts
> git diff --stat -- \
>   package.json pnpm-lock.yaml scripts/stage-flue-runtime.mjs \
>   scripts/package-smoke.mjs src/main/workflow-runtime-root.ts \
>   tests/main-desktop-hardening.test.ts
> git diff --cached --stat -- \
>   package.json pnpm-lock.yaml scripts/stage-flue-runtime.mjs \
>   scripts/package-smoke.mjs src/main/workflow-runtime-root.ts \
>   tests/main-desktop-hardening.test.ts
> ```
>
> `package.json` and `pnpm-lock.yaml` already contain unrelated React Doctor
> changes. Preserve them. If the runtime is no longer beta.9 or Plan 006 has
> started, STOP; Plan 006 owns the Flue 2 closure instead.

## Status

- **Priority**: P1 — medium effort with immediate packaging and audit gain
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 001-003
- **Category**: security / dependencies / packaging
- **Planned at**: commit `7b4f6e6`, 2026-08-13

## Why this matters

The package staging script creates a new dependency manifest without a lock and
installs from whatever is present in the local pnpm store. If that fails, it
copies `node_modules` from a previously packaged app. Therefore, one source
commit can ship different transitive packages or stale dependencies from
another build. Security fixes and regressions cannot be audited reliably.

This plan commits the exact dependency closure for the current beta runtime,
stages only from that lock, and fails closed when dependencies are unavailable.
Plan 006 later replaces the beta runtime and updates this already-reproducible
boundary to Flue 2.

## Current state

`scripts/stage-flue-runtime.mjs` currently writes this manifest dynamically:

```js
dependencies: { "@flue/cli": "1.0.0-beta.9" },
```

It then runs a lockless offline install. Its catch branch prints:

```text
Using the last verified packaged Flue dependency cache for offline staging.
```

and copies dependencies from
`release/mac-arm64/Patchdesk.app/Contents/Resources/flue-runtime/node_modules`.
The source is not proven to match the current commit.

The staged source still needs beta.9 workflow discovery:

- `flue.config.ts`
- `src/workflows/review-pr.ts`
- `src/workflows/generate-walkthrough.ts`
- the isolated `walkthrough/` discovery root
- `@flue/cli@1.0.0-beta.9`

Do not remove these in this plan.

`package.json` copies `out/workflow-runtime` into app Resources.
`src/main/workflow-runtime-root.ts` resolves the staged CLI through pnpm's
virtual store. `tests/main-desktop-hardening.test.ts` characterizes that
resolution.

## Target shape

Add a committed, current-runtime package:

```text
runtime/flue-beta9/
  package.json
  pnpm-lock.yaml
```

The manifest must use exact versions and contain the production dependency
needed by the staged current runtime. Keep the package name private and set
`type: "module"`.

`stage-flue-runtime.mjs` must:

1. clear `out/workflow-runtime`;
2. copy the committed manifest and lock into it;
3. install with `--frozen-lockfile --prod --offline --ignore-scripts`;
4. fail with a clear message if the store is incomplete;
5. never read or copy dependencies from `release/**`;
6. copy the same current beta source and walkthrough project as before;
7. verify the staged CLI exists and reports the locked beta version.

A fresh online dependency preparation may be a separate documented command,
but staging itself stays frozen and offline.

## Commands you will need

- Root install: `pnpm install --frozen-lockfile`
- Stage runtime: `pnpm stage:flue-runtime`
- Focused test:
  `pnpm test -- --run tests/main-desktop-hardening.test.ts`
- Standard gates: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`,
  `pnpm build`
- Package: `pnpm package:mac`
- Package smoke: `pnpm test:package-smoke`
- Audit: `pnpm audit --prod --audit-level high`
- Whitespace: `git diff --check`

Expected: all functional commands exit 0. Audit advisories must be reported with
reachability context; do not claim every advisory affects the packaged runtime.

## Scope

**In scope**

- Create `runtime/flue-beta9/package.json`
- Create `runtime/flue-beta9/pnpm-lock.yaml`
- `scripts/stage-flue-runtime.mjs`
- `package.json` only if a deterministic preparation or verification script is
  needed; preserve React Doctor changes
- `pnpm-lock.yaml` only if root scripts/dependencies genuinely change
- `src/main/workflow-runtime-root.ts` only if deterministic staging changes its
  path assumptions
- `tests/main-desktop-hardening.test.ts`
- Create `tests/scripts/stage-flue-runtime.test.ts` or an equivalent focused
  staging test if the script can be tested without mutating tracked files
- `README.md` for one concise packaging prerequisite if needed
- `CHANGELOG.md` for one user-facing packaging reliability bullet
- `plans/README.md` status only

**Out of scope**

- Flue 2, `pi-ai` upgrades, agent functions, or programmatic `start()`
- Changes to Analysis or Walkthrough behavior
- Removing workflow discovery, CLI, or beta declaration files
- Package-smoke execution of a real model/provider; Plan 006 owns that
- Renderer or GitHub behavior
- Fixing all dependency advisories without proven packaged reachability

## Git workflow

- Preserve every pre-existing dirty hunk.
- Stage explicit files only. Do not push or commit unless asked.
- If asked to commit, use `build: lock packaged flue runtime`.

## Steps

### Step 1: Characterize the staging contract

Add focused tests or extract pure helpers so the following are machine-checked:

- the committed runtime manifest and lock both exist;
- manifest dependency versions are exact;
- the staging command includes `--frozen-lockfile`, `--prod`, `--offline`, and
  `--ignore-scripts`;
- no fallback source under `release/` is referenced;
- a failed install rejects staging instead of copying an old package;
- current runtime resolution still finds the staged beta CLI and walkthrough
  root.

Do not run the live staging script inside a unit test if that would mutate the
shared `out/` tree concurrently. Prefer pure command/config builders and a
temporary-directory integration seam.

**Verify**:

```bash
pnpm test -- --run \
  tests/main-desktop-hardening.test.ts \
  tests/scripts/stage-flue-runtime.test.ts
```

If the new file uses another exact name, use it consistently. Expected after
Step 2: all tests pass.

### Step 2: Commit the exact beta.9 runtime closure

Create `runtime/flue-beta9/package.json` with exact
`@flue/cli: 1.0.0-beta.9`. Generate its lock with the repository's pnpm 8.8.0.
Review the lock and commit it; do not generate a lock during packaging.

Keep this package minimal. Do not add root dev tools or rely on a workspace
symlink outside the packaged Resources tree.

**Verify**:

```bash
node -e '
  const p = require("./runtime/flue-beta9/package.json");
  if (p.dependencies?.["@flue/cli"] !== "1.0.0-beta.9") process.exit(1);
'
test -f runtime/flue-beta9/pnpm-lock.yaml
```

Expected: both commands exit 0.

### Step 3: Make staging frozen and fail closed

Refactor `scripts/stage-flue-runtime.mjs` to copy the committed manifest and
lock into the cleared staging root before installation. Remove:

- `packagedRuntimeRoot`;
- `stagePackagedDependencyCache()`;
- all access/copy logic from `release/**`;
- the catch that converts install failure into cache reuse.

On install failure, throw an error that says the exact locked runtime could not
be staged and that the operator must populate the pnpm store through the normal
preparation path. Do not retry online silently during packaging.

After source staging, assert the expected CLI file and workflow config exist.
Keep the walkthrough symlink inside the staged tree only.

**Verify**:

```bash
pnpm stage:flue-runtime
node -e '
  const p = require("./out/workflow-runtime/package.json");
  if (p.dependencies?.["@flue/cli"] !== "1.0.0-beta.9") process.exit(1);
'
cmp runtime/flue-beta9/pnpm-lock.yaml out/workflow-runtime/pnpm-lock.yaml
test -f out/workflow-runtime/node_modules/@flue/cli/bin/flue.mjs
! rg -n 'last verified packaged|stagePackagedDependencyCache|release/mac' \
  scripts/stage-flue-runtime.mjs
```

Expected: all commands exit 0.

### Step 4: Prove incomplete input fails rather than reusing old output

Using the focused staging seam, simulate an install failure or empty store.
Assert that staging exits nonzero and does not copy a sentinel dependency from
a fake previous package. Also assert that staging clears old output before
starting, so an old node_modules tree cannot survive a failed run.

**Verify**:

```bash
pnpm test -- --run \
  tests/main-desktop-hardening.test.ts \
  tests/scripts/stage-flue-runtime.test.ts
```

Expected: failure-path and current resolver tests pass.

### Step 5: Run package acceptance

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm stage:flue-runtime
pnpm package:mac
pnpm test:package-smoke
pnpm audit --prod --audit-level high
git diff --check
```

Expected: lint, typecheck, tests, build, staging, packaging, smoke, and whitespace
checks pass. Record audit output and identify which advisories are present in
`runtime/flue-beta9/pnpm-lock.yaml`; do not expand scope without proven shipped
impact.

## Test plan

Required tests:

- Exact manifest and lock are copied into staging.
- Frozen offline production install arguments are fixed.
- Previous packaged app dependencies are never consulted.
- Failed installation leaves no apparently valid staged runtime.
- Runtime root and walkthrough root resolve after deterministic staging.
- Existing packaged UI smoke still opens the workbench and Settings.

Use temporary directories and injected command/filesystem seams where practical.
Do not make tests depend on a user's existing `release/` folder.

## Done criteria

- [ ] `runtime/flue-beta9/package.json` and `pnpm-lock.yaml` are committed inputs.
- [ ] Staging uses `--frozen-lockfile --prod --offline --ignore-scripts`.
- [ ] No code copies dependencies from a prior package or `release/**`.
- [ ] Incomplete locked dependencies fail staging visibly.
- [ ] Staged manifest and lock match the committed inputs.
- [ ] Current beta Analysis and Walkthrough discovery still resolve.
- [ ] Package and existing package smoke pass.
- [ ] Standard quality gates pass.
- [ ] Audit output is reported without unsupported reachability claims.
- [ ] `git diff --check` has no output.
- [ ] `plans/README.md` marks Plan 004 DONE.

## STOP conditions

Stop and report if:

- The selected Flue version is no longer beta.9; execute/reconcile Plan 006
  instead of building a temporary compatibility layer.
- A self-contained locked runtime cannot be produced with pnpm 8.8.0.
- Staging requires absolute symlink targets outside app Resources.
- Current package smoke depends on the previous-package cache as product state.
- Fixing a high advisory requires changing Analysis behavior or starting the
  Flue 2 migration.
- A verification fails twice after one focused correction.

## Maintenance notes

Plan 006 must update this exact closure rather than reintroducing generated
manifests. Reviewers should inspect the packaged runtime lock, staged manifest,
and actual Resources tree, not only the root lockfile.
