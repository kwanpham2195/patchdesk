# Plan 005: Stop persisting raw inspector paths, searches, and arguments

> **Executor instructions**: Complete Plan 001 first. Follow each verification
> gate and update `advisor-plans/README.md` when done. Debug-write failures must
> remain best-effort and must never change review results.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- src/services/review-inspector.ts src/services/review-context-service.ts tests/services/review-inspector.test.ts tests/services/review-context.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/001-safe-model-file-snapshots.md`
- **Category**: security
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

Review debug artifacts currently persist file paths, search queries, and
command arguments. Those values can contain workspace names, user input, or
other sensitive content, violating Patchdesk's rule that activity records use
finite safe milestones and causes only. Counts and fixed operation identifiers
provide useful support evidence without retaining raw inputs.

## Current state

- `src/services/review-inspector.ts:11-13` stores arrays of inspected paths,
  searches, and Git arguments.
- `gitShow` records argv including the absolute worktree path; `searchFiles`
  records the raw query; `readWhole` records the requested path.
- `src/services/review-inspector.ts:69-73` merges `debug()` into the persisted
  diagnostic JSON.
- `src/services/review-context-service.ts:34-37` initializes the same raw
  arrays and records raw `profileRuleLoadFailures`.
- `tests/services/review-inspector.test.ts` currently expects those raw values.
- Hard rule: review/walkthrough activity may record finite lifecycle milestones
  and safe terminal causes, never raw commands, prompts, paths, tokens, or
  model prose.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused | `pnpm test -- --run tests/services/review-inspector.test.ts tests/services/review-context.test.ts` | all focused tests pass |
| Secret check | `rg -n "inspectedPaths|searches|gitCommands|profileRuleLoadFailures" src/services tests/services` | no old telemetry fields remain in scope |
| Static | `pnpm lint && pnpm typecheck` | both exit 0 |
| Unit gate | `pnpm test -- --run` | all tests pass |

## Scope

**In scope**:

- `src/services/review-inspector.ts`
- `src/services/review-context-service.ts`
- `tests/services/review-inspector.test.ts`
- `tests/services/review-context.test.ts`

**Out of scope**:

- Removing diagnostic artifacts entirely.
- Recording hashes of raw values; hashes can still fingerprint sensitive input.
- Raw prompts, model prose, tokens, or command output.
- Changing review success/failure semantics.

## Git workflow

- Land Plan 001 first, then use the current branch or authorized
  `fix/redact-review-debug`.
- Commit example: `fix: redact review inspector diagnostics`.
- Stage only the four in-scope files. Do not push.

## Steps

### Step 1: Define tests for the safe debug shape

Replace raw-value assertions with a fixed schema such as:

```ts
{
  inspectedFileCount: number;
  searchCount: number;
  gitShowCount: number;
  profileRuleLoadFailureCount: number;
}
```

Use exact property names consistently in both services. Tests must serialize
the artifact and assert it does not contain the temp root, a requested
filename, the search query, `git`, `HEAD`, or a configured rule path.

**Verify**:
`pnpm test -- --run tests/services/review-inspector.test.ts tests/services/review-context.test.ts`
→ new safe-shape tests fail against current raw telemetry.

### Step 2: Replace raw collections with bounded counters

In `ReviewInspector`, increment numeric counters for each attempted operation.
Return a fresh safe object from `debug()`. Do not keep raw values in private
fields after the operation completes.

In `ReviewContextService`, initialize and persist the same counter-based shape.
Convert rule-load failures to a count only. Preserve best-effort writes: a
diagnostic failure must not affect context creation or review outcome.

**Verify**:
`pnpm test -- --run tests/services/review-inspector.test.ts tests/services/review-context.test.ts`
→ all focused tests pass.

### Step 3: Remove obsolete telemetry names and run gates

**Verify**:
`rg -n "inspectedPaths|searches|gitCommands|profileRuleLoadFailures" src/services tests/services`
→ no match in the in-scope implementation or tests.

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run`
→ all commands exit 0.

## Test plan

- Each operation increments only its own counter.
- Multiple operations aggregate counts.
- Persisted JSON contains no path, query, argv, or rule-path text.
- Diagnostic write failure remains non-fatal.

## Done criteria

- [ ] Persisted inspector/context telemetry contains finite counters only.
- [ ] No raw input is retained or hashed.
- [ ] Old telemetry property names are removed.
- [ ] Focused and full gates pass.
- [ ] Only in-scope files and the index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- Plan 001 has not landed or its `ReviewInspector` shape differs from the plan.
- A supported external consumer requires the old diagnostic JSON shape.
- Safe telemetry requires storing any raw value.
- A focused verification fails twice.

## Maintenance notes

New inspector operations should add only fixed-name counters or finite enums.
Review diagnostic changes specifically for indirect raw-data leakage.
