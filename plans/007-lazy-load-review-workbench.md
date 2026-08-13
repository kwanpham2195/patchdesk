# Plan 007: Keep the Review workbench out of the initial renderer bundle

> **Executor instructions**: Follow this plan step by step. Run every
> verification and confirm its expected result before continuing. Preserve the
> current navigation and restoration behavior. If a STOP condition occurs,
> stop and report. When done, update this plan's row in `plans/README.md` unless
> a reviewer maintains the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 7b4f6e6..HEAD -- \
>   src/renderer/src/app.tsx \
>   src/renderer/src/flows/app-fixtures.tsx \
>   electron.vite.config.ts tests/browser tests/renderer
> git diff --stat -- \
>   src/renderer/src/app.tsx \
>   src/renderer/src/flows/app-fixtures.tsx \
>   electron.vite.config.ts tests/browser tests/renderer
> git diff --cached --stat -- \
>   src/renderer/src/app.tsx \
>   src/renderer/src/flows/app-fixtures.tsx \
>   electron.vite.config.ts tests/browser tests/renderer
> ```
>
> This plan runs after the Review architecture and Flue migration because both
> can change workbench imports and build output. If Plans 005 or 006 are not
> DONE, stop at the dependency check.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 005 and 006
- **Category**: performance / architecture
- **Planned at**: commit `7b4f6e6`, 2026-08-13
- **Status**: DONE (2026-08-13)

## Why this matters

`app.tsx` statically imports the entire Review workbench. That reaches Pierre,
syntax highlighting, generated Markdown, Analysis, and diff rendering before a
maintainer opens any Review. The audited production entry was approximately
3.7 MB, or 736 KB gzip. Inbox and Settings pay this parse and startup cost even
when Review functionality is not used.

Create a real async boundary at the Review route and prove it from build output.
Do not optimize individual libraries or weaken the large-patch performance
contract.

## Current state

`src/renderer/src/app.tsx:3` has:

```ts
import { ReviewWorkbenchFlow } from "./flows/review-workbench-flow";
```

Later, when `workbench?.state === "review"`, it renders that component inside
`AppShell`. Because the import is static, Rollup includes its dependency graph
in the initial entry.

The workbench graph includes:

- `review-workbench-flow.tsx`
- `components/review-workbench.tsx`
- `components/review-diff-view.tsx`
- Pierre trees/diffs/themes
- Shiki and generated Markdown support

`app-fixtures.tsx` also statically imports `ReviewWorkbench` for browser fixture
routes. Do not let a fixture import pull the workbench back into the production
entry. A fixture-only async boundary or separate fixture module may be needed.

`tests/browser/performance.spec.ts` checks interaction with a 1,000-file,
approximately 10 MB patch after the workbench loads. Preserve it. There is no
current build-output budget test.

## Target shape

- `App` uses `React.lazy()` or an equivalent native dynamic import for the
  production Review workbench route.
- A bounded Suspense fallback appears only while the chunk loads.
- Opening a Review, restoring its UI state, navigation guard state, and all
  workbench callbacks behave exactly as before.
- Fixture-only code does not make the production entry import the workbench.
- A build assertion proves a dedicated workbench chunk exists and heavy Review
  packages are absent from the initial entry graph.

## Commands you will need

- Build: `pnpm build`
- Focused renderer tests:
  `pnpm test -- --run tests/renderer/app.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx`
- Browser workbench/performance:
  `pnpm exec playwright test tests/browser/review-workbench.spec.ts tests/browser/performance.spec.ts`
- Standard gates: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`
- Whitespace: `git diff --check`

Locate exact app-test paths before editing if `tests/renderer/app.ui.test.tsx`
does not exist after Plans 005-006. Do not invent a duplicate harness.

## Scope

**In scope**

- `src/renderer/src/app.tsx`
- `src/renderer/src/flows/app-fixtures.tsx`
- Create a small async workbench/fixture entry under `src/renderer/src/flows/`
  if needed
- `electron.vite.config.ts` only for deterministic chunk naming or a reporting
  hook; avoid manual vendor chunking unless proven necessary
- Create `scripts/check-renderer-bundles.mjs`
- `package.json` for a `test:bundle` or equivalent command
- `tests/renderer/` app/navigation tests
- `tests/browser/review-workbench.spec.ts`
- `tests/browser/performance.spec.ts`
- `plans/README.md` status only

**Out of scope**

- Replacing Pierre, Shiki, marked, or Mermaid
- Lazy loading within an already-open Review
- Visual redesign of the loading state
- Main/preload process build changes
- Flue runtime packaging
- Changing the large-patch timing ceilings

## Git workflow

- Start after Plans 005-006 on their integrated branch or a clean descendant.
- Stage explicit paths only. Do not push or commit unless asked.
- If asked to commit, use `perf: lazy-load review workbench`.

## Steps

### Step 1: Record the build graph baseline

Run a production build and identify:

- renderer entry JS file;
- all static imports reachable from it;
- total raw and gzip size of entry JS;
- whether Pierre, Shiki, marked, Mermaid, and Review workbench modules are in
  that initial graph.

Create `scripts/check-renderer-bundles.mjs` that reads the Vite manifest or
Rollup output graph. Prefer module/import identity over hashed file-name guesses.
The initial failing assertion must prove there is no async Review workbench
boundary today.

Do not set a brittle byte target from one machine alone. The core gate is graph
separation; report byte sizes as diagnostics. If a size budget is added, allow a
small documented margin over the post-split baseline.

**Verify**:

```bash
pnpm build
node scripts/check-renderer-bundles.mjs
```

Expected before the split: the graph assertion fails because workbench-heavy
modules are statically reachable. Expected after Step 3: it passes.

### Step 2: Add route loading behavior tests

Add or extend App tests to prove:

1. Inbox renders without resolving the workbench module.
2. Settings opens without resolving it.
3. Opening a Review shows the bounded loading fallback, then the workbench.
4. Initial section and restored UI state reach the loaded component.
5. Navigation state and `onWorkbenchReplace` callbacks still work.
6. A failed chunk import produces an explicit retryable error boundary rather
   than a blank renderer.

Use an injected loader or mockable module promise. Do not use sleeps.

**Verify**:

```bash
pnpm test -- --run tests/renderer/app.ui.test.tsx
```

Expected after Step 3: all route-loading cases pass.

### Step 3: Introduce the production async boundary

Replace the static workbench import in `app.tsx` with a typed dynamic import.
Use the existing AppShell around a small, accessible Suspense fallback. Keep the
workbench props and callback wiring in one component so the async boundary does
not duplicate state logic.

Separate fixture imports as needed. Production `app.tsx` must not statically
import a fixture module that itself statically imports Review workbench heavy
modules. Options, in order of preference:

1. lazy-load the fixture content only when `fixtureMode` is true;
2. split Review fixtures into a separate async module;
3. configure a test-only entry only if the first two cannot preserve current
   fixture URLs.

Do not add a generic route framework for this one boundary.

**Verify**:

```bash
pnpm build
node scripts/check-renderer-bundles.mjs
pnpm test -- --run tests/renderer/app.ui.test.tsx \
  tests/renderer/review-workbench-flow.ui.test.tsx
```

Expected: dedicated async workbench chunk exists, initial graph excludes the
heavy Review graph, and behavior tests pass.

### Step 4: Prove live Review behavior and performance

```bash
pnpm exec playwright test \
  tests/browser/review-workbench.spec.ts \
  tests/browser/performance.spec.ts
```

Expected: workbench opens after chunk load; large-patch filter, selection, and
main-thread ceilings remain unchanged.

For live desktop verification, restart `pnpm dev` because renderer build and
route loading changed. Use the `patchdesk-electron-tester` skill and verify
read-only:

- Inbox opens before any Review.
- Settings opens from Inbox.
- One Review opens and its current tab/state restores.
- Returning to Inbox remains functional.

### Step 5: Run the complete gate

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
node scripts/check-renderer-bundles.mjs
pnpm exec playwright test
git diff --check
```

Expected: every command exits 0 and the bundle checker prints entry and async
chunk sizes plus a passing separation result.

## Test plan

Required coverage:

- Inbox and Settings do not load the Review chunk.
- Review route resolves it once and renders a meaningful fallback meanwhile.
- Chunk failure is visible and retryable.
- Workbench props, restore state, and navigation guard survive the boundary.
- Production bundle graph proves separation.
- Existing 10 MB patch timing assertions remain strict.

## Done criteria

- [x] No static production import of `ReviewWorkbenchFlow` remains in `app.tsx`.
- [x] Fixture imports do not pull the Review graph back into the initial entry.
- [x] Build output has a dedicated async Review workbench chunk.
- [x] A deterministic graph check guards the boundary.
- [x] Inbox and Settings tests prove the chunk is not loaded.
- [x] Review loading, failure, restore, and navigation tests pass.
- [x] Browser and large-patch performance tests pass unchanged.
- [x] Full quality gate passes.
- [x] `git diff --check` has no output.
- [x] `plans/README.md` marks Plan 007 DONE.

## STOP conditions

Stop and report if:

- Plans 005 or 006 are incomplete or still changing the same import graph.
- Vite cannot expose a deterministic module/import graph for the check.
- Fixture separation requires shipping a second production application.
- Lazy loading breaks state restoration or navigation safety and cannot be
  corrected within the in-scope files.
- The only proposed fix is broad manual vendor chunking without a measured
  Review boundary.
- A verification fails twice after one focused correction.

## Maintenance notes

The module-graph assertion is more durable than one absolute bundle-size number.
Review future imports into `app.tsx` and fixture roots: either can accidentally
make the heavy Review graph eager again.
