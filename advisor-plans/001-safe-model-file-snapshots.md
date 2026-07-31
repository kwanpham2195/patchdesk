# Plan 001: Make model file snapshots safe and bounded

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Stop
> and report when a STOP condition occurs. When done, update this plan's row in
> `advisor-plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- src/services/model-review-runner.ts src/services/review-inspector.ts tests/services/model-review-runner.test.ts tests/services/review-inspector.test.ts`
> If an in-scope file changed, compare the excerpts below with live code. Stop
> if the security boundary no longer matches this plan.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

The review runner snapshots changed files before exposing them to model tools,
but it currently follows filesystem links and has no byte limits. A changed
path can therefore read outside the managed worktree or consume excessive
memory. The snapshot map must become an authoritative, bounded allowlist so a
skipped file cannot be read later through the inspector fallback.

## Current state

- `src/services/model-review-runner.ts:73-89` resolves paths lexically and then
  calls `readFile`:

```ts
const root = await realpath(worktreePath);
for (const path of files) {
  const candidate = resolve(root, path);
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith("..") || relativePath === "") continue;
  snapshots[path] = await readFile(candidate, "utf8");
}
```

- `src/services/review-inspector.ts:51-66` returns a snapshot when present but
  falls back to disk when the key is absent:

```ts
const snapshot = this.fileSnapshots?.[path];
if (snapshot !== undefined) return snapshot;
const root = await realpath(this.worktreePath);
const candidate = await realpath(resolve(root, path));
```

- `src/services/model-review-runner.ts:51-59` always passes the snapshot object
  into the model-facing inspector.
- The Electron renderer is sandboxed. Do not relax its security settings or
  move filesystem access into the renderer.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `pnpm test -- --run tests/services/model-review-runner.test.ts tests/services/review-inspector.test.ts` | all focused tests pass |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Lint | `pnpm lint` | exit 0, no warnings |
| Unit gate | `pnpm test -- --run` | all tests pass |

## Scope

**In scope**:

- `src/services/model-review-runner.ts`
- `src/services/review-inspector.ts`
- `tests/services/model-review-runner.test.ts`
- `tests/services/review-inspector.test.ts`

**Out of scope**:

- Renderer or Electron sandbox settings.
- Patch generation and diff-size limits.
- Support for reading symlinks or special files.
- New dependencies.

## Git workflow

- Stay on the operator-provided branch. If a new branch is authorized, use
  `fix/safe-model-file-snapshots`.
- Use conventional commits, for example
  `fix: bound model file snapshots`.
- Stage only the four in-scope paths. Do not push without explicit approval.

## Steps

### Step 1: Lock down the unsafe cases with regression tests

In `tests/services/model-review-runner.test.ts`, follow the existing
`mkdtemp` fixture style and add cases for:

1. a changed-file symlink that points outside the worktree;
2. a directory or other non-regular changed path;
3. a regular file larger than 512 KiB;
4. several regular files whose accepted contents exceed a 4 MiB aggregate.

Make the fake model attempt to read every path. Assert that no outside or
oversized content reaches the model tool result. In
`tests/services/review-inspector.test.ts`, prove that when `fileSnapshots` is
defined, a missing key is denied rather than read from disk.

**Verify**:
`pnpm test -- --run tests/services/model-review-runner.test.ts tests/services/review-inspector.test.ts`
→ the new tests fail for the expected unsafe-read behavior.

### Step 2: Build an authoritative safe snapshot map

In `src/services/model-review-runner.ts`, give snapshot construction named
limits of 512 KiB per file and 4 MiB total. For each changed path:

- reject absolute paths, root itself, and lexical escapes;
- use `lstat` to reject symbolic links and non-regular files before reading;
- resolve the candidate with `realpath` and verify it remains below the
  canonical worktree root;
- open/read no more than the allowed bytes, and reject a file rather than
  truncating it;
- stop accepting additional snapshots when the aggregate limit would be
  exceeded.

Use `path.relative` plus `path.isAbsolute` for containment. Catch per-file
filesystem races as a denied snapshot; do not fail the complete review.

**Verify**:
`pnpm test -- --run tests/services/model-review-runner.test.ts`
→ all runner tests pass, including link and size cases.

### Step 3: Make snapshot mode deny fallback reads

In `src/services/review-inspector.ts`, distinguish `fileSnapshots ===
undefined` from an authoritative snapshot object. When the object is present,
`readWhole` may return only its own keys. A missing key must return the same
safe denial shape used for invalid paths and must not call `realpath` or
`readFile`.

Keep the no-snapshot fallback for non-model callers that explicitly construct
the inspector without `fileSnapshots`.

**Verify**:
`pnpm test -- --run tests/services/review-inspector.test.ts`
→ all inspector tests pass and the fallback distinction is covered.

### Step 4: Run the static and unit gates

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run`
→ every command exits 0.

## Test plan

- Model runner: ordinary changed file, outside symlink, directory, per-file
  limit, aggregate limit, and a disappearing file.
- Inspector: authoritative snapshot hit, authoritative miss, and legacy
  no-snapshot safe read.
- Do not assert exact OS error messages; assert safe denial and absence of
  protected content.

## Done criteria

- [ ] Model snapshots never follow symlinks or read non-regular files.
- [ ] The 512 KiB per-file and 4 MiB aggregate limits have named constants and
  tests.
- [ ] Authoritative snapshot misses cannot fall back to disk.
- [ ] Focused tests, lint, typecheck, and full unit gate pass.
- [ ] Only in-scope files and `advisor-plans/README.md` are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- The model runner no longer passes snapshots into `ReviewInspector`.
- A required caller depends on snapshot misses reading live disk state.
- Safe containment requires weakening Electron or renderer isolation.
- A verification fails twice after a focused fix.

## Maintenance notes

Keep the limits aligned with the model prompt and artifact budgets. Reviewers
should scrutinize time-of-check/time-of-use handling and verify that every
skipped snapshot remains unreadable through all model tools.
