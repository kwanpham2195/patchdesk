# Plan 013: Patch reachable runtime and build-tool dependency advisories

> **Executor instructions**: Treat React Doctor's supply-chain score as a lead, not proof. Verify each advisory path and update only direct dependencies or narrowly justified overrides. Use the `librarian` skill for upstream release and changelog evidence. Run package smoke for any packaging-path change. Update only this plan's status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a3813b8..HEAD -- package.json pnpm-lock.yaml runtime/flue/package.json runtime/flue/pnpm-lock.yaml scripts package.json`

## Status

- **Status**: REJECTED — Superseded by `.agents/PLANS/2026-08-14-complete-react-doctor-remediation.md`; existing advisory evidence remains authoritative input to the delta plan.

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 009
- **Category**: security
- **Planned at**: commit `a3813b8`, 2026-08-14

## Why this matters

React Doctor reported one low supply-chain score, but the useful evidence comes from pnpm's advisory graph. At planning time, `pnpm audit --prod --audit-level high` reported no high or critical production advisory, while the full audit reported 11 high advisories in development and packaging chains. Direct runtime dependencies also had patch-level moderate advisories: Hono 4.12.30 was below 4.12.34, and Mermaid 11.16.0 was below 11.16.1. Patch the direct reachable dependencies first, then address build-tool transitives without destabilizing Electron packaging.

## Current state

- `package.json` declares `hono: ^4.8.3`, `@hono/node-server: ^2.0.3`, and `mermaid: 11.16.0`. The lock resolved Hono 4.12.30 at planning time.
- `pnpm audit --prod --audit-level high` reported 0 high and 0 critical advisories across 218 production dependencies, but eight moderate advisories.
- The full audit reported high advisory paths through `electron-builder`, Electron download tooling, Vite/PostCSS, and React Doctor's own development chain. These are build/development paths unless proven otherwise.
- Packaged Flue production is isolated in `runtime/flue/` with exact versions and its own lock. Do not modify that closure unless an advisory is present in that lock and the Flue package gates prove the change.
- Package verification commands are `pnpm package:mac` and `pnpm test:package-smoke`.

## Commands you will need

- `pnpm audit --prod --audit-level high --json`
- `pnpm audit --audit-level high --json`
- `pnpm why <package>` for every affected transitive package
- `pnpm outdated`
- `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, `pnpm build`, `pnpm exec playwright test`
- `pnpm package:mac`, `pnpm test:package-smoke`, `pnpm test:bundle`

## Scope

**In scope**:

- `package.json`
- `pnpm-lock.yaml`
- `runtime/flue/package.json` and `runtime/flue/pnpm-lock.yaml` only if an advisory is proven inside that isolated closure
- Focused dependency/package tests only when an update changes observable behavior
- `CHANGELOG.md` only for a user-visible security or rendering behavior change
- `plans/README.md` status row only

**Out of scope**:

- Broad `pnpm update --latest`.
- New dependencies.
- Unverified `pnpm.overrides` that force incompatible transitive majors.
- Claiming React Doctor's Socket score proves exploitability.
- Changing provider capabilities or Review lifecycle behavior.

## Git workflow

- Branch: `chore/dependency-advisories`
- Commits: group runtime patches separately from build-tool patches, for example `chore: patch runtime dependency advisories` and `chore: patch packaging dependency advisories`.
- Stage explicit paths only. Do not push unless instructed.

## Steps

### Step 1: Reproduce and classify advisory paths

Capture production and full audit JSON. For each high/moderate direct or packaging advisory, run `pnpm why` and classify it as:

- shipped runtime;
- packaging/build only;
- test/tool only;
- separate Flue closure;
- unreachable or false-positive metadata.

Record package, current version, patched version, top-level owner, and verification gate. Do not copy sensitive environment values into notes.

**Verify**: every planned update has one `pnpm why` path and one patched-version source.

### Step 2: Patch direct runtime dependencies first

Use upstream releases and local compatibility checks to update:

- Hono and `@hono/node-server` to compatible versions that resolve Hono at or above the patched advisory floor;
- Mermaid to at least 11.16.1, preserving `securityLevel: "strict"`, `suppressErrorRendering`, and lazy loading.

Use the package manager so lockfile integrity is preserved. Do not add an override when a normal direct update resolves the advisory.

**Verify**:

- `pnpm audit --prod --audit-level high` reports 0 high and critical advisories.
- Focused local API and Markdown/Mermaid renderer tests pass.
- `pnpm build` passes.

### Step 3: Patch development and packaging chains conservatively

Check supported patch/minor updates for Electron, electron-builder, Vite, Vitest, Tailwind Vite integration, and React Doctor. Prefer top-level updates that naturally bring patched transitives. Use an override only when:

1. upstream permits the patched transitive range;
2. no supported top-level update exists;
3. package, build, and smoke gates pass;
4. the override has an explanatory comment or durable plan note.

Do not force a transitive version across incompatible major ranges.

**Verify**: rerun full audit and compare advisory paths. Any remaining high item has a documented owner, reachability, and reason it cannot yet be patched.

### Step 4: Prove packaging and runtime behavior

Run in order:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test -- --run`
5. `pnpm test:bundle`
6. `pnpm exec playwright test`
7. `pnpm package:mac`
8. `pnpm test:package-smoke`
9. `git diff --check`

Inspect the staged Flue manifest/digests if any runtime lock changed. Exact `@flue/runtime@2.0.3` and `@earendil-works/pi-ai@0.84.1` remain unchanged unless the user separately approves a Flue migration.

### Step 5: Rescan supply-chain findings

Run calibrated React Doctor with supply-chain enabled. Record its score and diagnostics, but use pnpm audit plus reachability as acceptance evidence. If Socket still gives Hono a low heuristic score while the installed version is patched and audit evidence is clean, record it as an evidence-backed tool disagreement; do not churn dependencies solely for the score.

## Test plan

- Existing local API authentication and main hardening tests protect Hono boundary behavior.
- Existing pull-request description tests protect Mermaid strict rendering and unsafe-markup rejection.
- Full build, browser, bundle, package, and package-smoke gates protect development and distribution paths.
- Add a regression test only if an upstream update changes a behavior Patchdesk relies on.

## Done criteria

- [ ] Every high/moderate direct or packaging advisory has a verified dependency path and disposition.
- [ ] Production audit has zero high and critical findings.
- [ ] Hono and Mermaid resolve at patched advisory versions.
- [ ] Remaining development high advisories are fixed or documented with reachability and upstream blocker evidence.
- [ ] Full tests, build, bundle, Playwright, package, and package smoke pass.
- [ ] Flue exact runtime versions remain unchanged unless separately approved.

## STOP conditions

- A patch requires a major Electron, Vite, or Flue migration.
- An override violates an upstream dependency range.
- Package smoke or renderer security tests regress.
- A dependency appears intentional but removal is proposed; ask before removing functionality or an intentional package.
- An advisory can only be fixed by changing the approved provider or GitHub-write capability boundary.

## Maintenance notes

Keep production and development advisory counts separate. A build-only advisory can still matter to release integrity, but it is not equivalent to a shipped runtime vulnerability. Record exact package paths so future audits can tell whether ownership moved.
