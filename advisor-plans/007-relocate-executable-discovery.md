# Plan 007: Move executable discovery into the adapter layer

> **Executor instructions**: This is a mechanical architecture correction. Move the implementation; do not change executable search behavior. Remove the obsolete main-layer path rather than keeping a compatibility re-export. Update the plan index when done.
>
> **Drift check (run first)**: `git diff --stat 4db4917..HEAD -- src/main/executable-discovery.ts src/main/electron-main.ts src/services/insight-provider-catalog.ts src/adapters/github/command-runner.ts tests/adapters/command-runner.test.ts tests/services/insight-provider-catalog.test.ts docs/architecture.md`
> If callers or discovery behavior changed, remap imports and tests before proceeding.

## Status

- **Status**: DONE
- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `advisor-plans/002-enforce-safe-staged-quality.md`
- **Category**: tech-debt
- **Planned at**: commit `4db4917`, 2026-08-21

## Why this matters

Filesystem and PATH-based executable discovery is an operating-system adapter, but it currently lives under the Electron composition layer. An adapter and a service import upward into `src/main/`, reversing the documented dependency direction. Moving the unchanged implementation gives the module one clear owner and prevents `src/main/` from becoming a general utility layer.

## Current state

- `docs/architecture.md` defines `src/adapters/` as I/O and `src/main/` as Electron composition.
- `src/main/executable-discovery.ts` reads `process.env.PATH`, checks executable access, and adds macOS desktop paths. It is pure adapter behavior.
- `src/adapters/github/command-runner.ts:8` imports `discoverExecutable` from `../../main/executable-discovery`.
- `src/services/insight-provider-catalog.ts:1` imports `discoverPathOnlyExecutable` from `../main/executable-discovery`.
- `src/main/electron-main.ts:54` imports the path-only function from the current main module.
- Both consumers already support injected discovery functions, so behavior can remain unchanged.
- `tests/adapters/command-runner.test.ts` proves discovery injection and cancellation; `tests/services/insight-provider-catalog.test.ts` proves provider discovery injection.

Target path: `src/adapters/process/executable-discovery.ts`.

## Commands you will need

| Purpose       | Command                                                                                                                                                  | Expected on success            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Import search | `rg -n -e "main/executable-discovery" -e "\./executable-discovery" src tests`                                                                            | no obsolete imports after move |
| Focused tests | `pnpm test -- --run tests/adapters/command-runner.test.ts tests/adapters/command-runner-process.test.ts tests/services/insight-provider-catalog.test.ts` | all pass                       |
| Typecheck     | `pnpm typecheck`                                                                                                                                         | exit 0                         |
| Build         | `pnpm build`                                                                                                                                             | exit 0                         |

## Scope

**In scope**:

- `src/adapters/process/executable-discovery.ts` (new location)
- `src/main/executable-discovery.ts` (remove after callers move)
- `src/adapters/github/command-runner.ts`
- `src/services/insight-provider-catalog.ts`
- `src/main/electron-main.ts`
- A direct adapter test only if current focused tests cannot cover the moved exports

**Out of scope**:

- Search paths, environment inheritance, executable permission semantics, or platform policy.
- Command spawning, cancellation, timeout, or output behavior.
- Provider availability policy.
- Compatibility re-export from `src/main/executable-discovery.ts`.
- Broad adapter directory reorganization.

## Git workflow

- Branch: `refactor/executable-discovery-adapter`
- Commit: `refactor(adapters): own executable discovery`
- Use a real move when practical so history remains clear. Do not leave both implementations.

## Steps

### Step 1: Move the implementation unchanged

Create `src/adapters/process/executable-discovery.ts` with the existing imports, constants, `discoverExecutable`, `discoverPathOnlyExecutable`, and private `executableFile` implementation unchanged except for formatting required by the destination.

Do not widen exports or add an interface. Existing function injection is already the narrow seam.

**Verify**: compare old and new function bodies; search-path order and path-only restrictions are identical.

### Step 2: Update all three consumers

Update imports:

- `src/adapters/github/command-runner.ts` → adapter process path;
- `src/services/insight-provider-catalog.ts` → adapter process path;
- `src/main/electron-main.ts` → adapter process path.

This produces the intended direction:

```text
main -> adapters/services
a service -> adapter
an adapter -> another adapter
```

No service or adapter may import from `src/main/` afterward.

**Verify**:

```bash
rg -n 'from ".*main/' src/services src/adapters
rg -n 'executable-discovery' src
```

Expected: first command has no matches; second lists only the new adapter module and its three consumers.

### Step 3: Remove the obsolete path

Delete `src/main/executable-discovery.ts` after all imports compile. Do not retain a re-export, alias, or fallback path; repository policy removes obsolete internal paths.

**Verify**: `test ! -e src/main/executable-discovery.ts` exits 0.

### Step 4: Run focused behavior tests

Run the command-runner injection/process tests and provider-catalog tests. They should pass without test changes because public consumer behavior is unchanged.

If a direct discovery test is needed, create `tests/adapters/executable-discovery.test.ts` and use temporary executable files plus explicit `pathValue`; do not depend on the developer's ambient PATH. Avoid platform-specific macOS fallback assertions unless guarded and deterministic.

**Verify**: focused test command exits 0.

### Step 5: Run final gates

```bash
pnpm typecheck
pnpm test -- --run tests/adapters/command-runner.test.ts tests/adapters/command-runner-process.test.ts tests/services/insight-provider-catalog.test.ts
pnpm test:all
pnpm build
```

All commands must exit 0.

## Test plan

Prefer existing injection tests; this is a move, not a behavior change. Add direct tests only if coverage is lost or import-only compilation does not exercise the moved module. Any new test must pass an explicit PATH and use a temporary directory.

## Done criteria

- [x] Executable discovery exists only under `src/adapters/process/`.
- [x] No service or adapter imports from `src/main/`.
- [x] Search behavior and public function signatures are unchanged.
- [x] The obsolete main file is removed with no compatibility re-export.
- [x] Focused tests, typecheck, complete tests, build, and staged quality pass.
- [x] `advisor-plans/README.md` is updated.

## STOP conditions

- A hidden consumer requires the old module path; locate and update it rather than adding a shim, unless it is an external public contract.
- Moving the file changes bundling or causes renderer inclusion of Node-only code.
- Tests require ambient credentials or PATH state.
- Correctness appears to require changing search policy; that is a separate finding.

## Maintenance notes

Keep operating-system process/filesystem discovery in adapters. Keep Electron lifecycle and composition in `src/main/`. Future providers should receive discovery functions through composition or import the adapter, never reach upward into main.
