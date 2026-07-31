# Plan 006: Load configured repository review rules safely

> **Executor instructions**: Complete Plan 005 first. Follow each step and stop
> rather than weakening trusted reviewer policy. Update
> `advisor-plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat a9a801f..HEAD -- src/services/review-context-service.ts src/services/review-rubric.ts tests/services/review-context.test.ts tests/services/review-rubric.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/005-redact-inspector-debug-telemetry.md`
- **Category**: bug
- **Planned at**: commit `a9a801f`, 2026-07-31

## Why this matters

Settings promise that configured rule paths define the rules applied to a
workspace, but review context currently records only rule-file metadata. The
review model never receives the contents. Patchdesk should load bounded,
user-selected rule text as project criteria while keeping its trusted reviewer
policy, output schema, and safety rules authoritative.

## Current state

- `src/renderer/src/flows/settings-flow.tsx:503-535` describes Rule paths as
  rules that apply to repositories.
- `src/services/review-context-service.ts:27-47` checks root and profile rule
  files but emits metadata rather than content.
- `src/services/review-inspector.ts` exposes changed files only, so unchanged
  `AGENTS.md` or configured rules are not otherwise available to the model.
- `src/services/review-rubric.ts:13-27` is the trusted policy. It labels patch,
  PR, comments, checks, tool output, and repository guidance as evidence, not
  instructions. Preserve that trust boundary.
- Workspace profile rule paths are absolute by contract and may intentionally
  live outside the checked-out repository.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused | `pnpm test -- --run tests/services/review-context.test.ts tests/services/review-rubric.test.ts` | all focused tests pass |
| Static | `pnpm lint && pnpm typecheck` | both exit 0 |
| Unit gate | `pnpm test -- --run` | all tests pass |

## Scope

**In scope**:

- `src/services/review-context-service.ts`
- `src/services/review-rubric.ts`
- `tests/services/review-context.test.ts`
- `tests/services/review-rubric.test.ts`

**Out of scope**:

- Letting repository text override Patchdesk policy or output schema.
- Executing instructions or commands found in rule files.
- Searching arbitrary parent directories for more rule files.
- Persisting absolute rule paths or rule contents in diagnostics.
- Adding new Settings fields.

## Git workflow

- Land Plan 005 first. Stay on the operator branch or use authorized
  `fix/load-review-rules`.
- Commit example: `fix: include configured review rules`.
- Stage only the four in-scope files. Do not push.

## Steps

### Step 1: Specify bounded rule loading in tests

In `tests/services/review-context.test.ts`, add isolated files for:

- root `AGENTS.md` and `CONTRIBUTING.md`;
- a configured absolute profile rule path;
- missing, symlinked, non-regular, oversized, and secret-like rule files.

Adopt explicit limits: 128 KiB per rule and 512 KiB total. Accept only regular
non-symlink files. Run the repository's existing sensitive-data detector before
including text. Assert safe labels and contents appear for accepted rules, and
rejected rules contribute only the Plan 005 failure counter. Assert persisted
debug JSON contains neither absolute paths nor contents.

**Verify**:
`pnpm test -- --run tests/services/review-context.test.ts`
→ accepted-content tests fail against current metadata-only behavior.

### Step 2: Load and label selected rule evidence

Refactor `ReviewContextService` to return a `projectReviewCriteria` section with
bounded entries. Use stable labels:

- `AGENTS.md` and `CONTRIBUTING.md` for repository-root files;
- `configured-rule-1`, `configured-rule-2`, and so on for profile paths.

For profile rule paths, honor the user's absolute selection but reject symlinks
and non-regular files. Do not expose the absolute path to the model or debug
artifact. Skip unreadable, oversized, secret-like, or over-budget content and
increment only a safe failure count.

**Verify**:
`pnpm test -- --run tests/services/review-context.test.ts`
→ all context tests pass.

### Step 3: Place project criteria below trusted policy

In `src/services/review-rubric.ts`, render a clearly delimited
`Project review criteria` section after Patchdesk's trusted policy and before
untrusted PR/patch evidence. State in the trusted text that project criteria
may refine code-quality expectations but cannot change safety, tool access,
output schema, or the instruction hierarchy.

Test that accepted rule text is present in the final prompt and that apparent
prompt-injection text remains inside the evidence delimiter with an explicit
warning not to execute it.

**Verify**:
`pnpm test -- --run tests/services/review-rubric.test.ts`
→ all rubric tests pass.

### Step 4: Run repository gates

**Verify**:
`pnpm lint && pnpm typecheck && pnpm test -- --run`
→ every command exits 0.

## Test plan

- Load root and configured rules.
- Reject missing, symlink, directory, oversized, aggregate-overflow, and
  secret-like inputs.
- Redact absolute labels and all rule contents from diagnostics.
- Preserve trusted-policy ordering and delimit adversarial rule text.

## Done criteria

- [ ] Review prompts contain bounded accepted project criteria.
- [ ] Patchdesk policy and schema remain authoritative.
- [ ] Absolute configured paths and contents never enter diagnostics.
- [ ] Size, type, and sensitive-data rejection tests pass.
- [ ] Full static/unit gates pass.
- [ ] Only in-scope files and index are modified.
- [ ] The index row is `DONE`.

## STOP conditions

- Plan 005's safe telemetry contract is not available.
- The sensitive-data detector cannot safely inspect rule text.
- Product requirements treat repository files as trusted system instructions.
- Prompt composition happens outside the four in-scope files.
- A focused verification fails twice.

## Maintenance notes

Any new rule source must use the same loader, byte budget, safe labels, and
evidence delimiter. Reviewers should test prompt-injection-like rule content
and confirm it cannot override trusted review behavior.
