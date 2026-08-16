---
created_at: 2026-08-16
repos:
  - patchdesk
status: in-progress
---

# Lint migration: anti-slop plugin (1850 findings) to a clean gate

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as work proceeds.

## Purpose / Big Picture

The `anti-slop` Oxlint plugin (15 rules, vendored at `tools/oxlint/anti-slop/`)
was just installed and enabled at `"error"` in `.oxlintrc.json`. Before the
install, `pnpm lint` was clean. Now `pnpm lint` fails with 1850 errors across
195 files. This plan migrates the codebase back to a clean `pnpm lint` gate,
rule batch by rule batch, without weakening any rule globally and without
laundering types to silence the linter.

The observable end state: `pnpm lint` exits 0, `pnpm typecheck` exits 0,
`pnpm test -- --run` reports 114 files / 669 tests passing, and every
remaining `unknown` in the codebase sits at a documented I/O boundary with a
per-file override that states its contract in `.oxlintrc.json`.

Two hard constraints from the repo owner (see `Decision Log`):

1. Where an honest named type or structural change exists, make it. Where the
   code IS the I/O boundary, keep `unknown` and add a targeted per-file
   override with a comment stating the boundary contract (the repo already
   uses this override pattern for `src/renderer/src/components/ui/**`).
2. Never launder types to make lint pass: no `as unknown` tricks, no faked
   `SAFETY:` comments, no severity weakening. `pnpm lint` runs with
   `--deny-warnings`, so a warning is a failure too.

## Progress

- [ ] 2026-08-16: Plan drafted. Baseline re-measured: lint 1850 errors / 195
      files; typecheck green; tests 114 files / 669 tests green; flue runtime
      tests 1 file / 15 tests green. Findings snapshot at `/tmp/oxlint-full.txt`
      (regenerable, see `Concrete Steps`).
- [ ] M0: repo-owner approval of the override-with-reason policy. NOT YET DONE
      (this is the first gate).
- [ ] M1 no-known-value-widening (43) - pending
- [ ] M2 no-chained-type-assertions (31) - pending
- [ ] M3 no-unsafe-dictionary-type (82) - pending
- [ ] M4 require-safety-comment-for-type-assertion (792) - pending
- [ ] M5 no-unknown-returns (15) - pending
- [ ] M6 no-conditional-empty-object-spread (416) - pending
- [ ] M7 no-runtime-typeof (255) - pending
- [ ] M8 no-unknown-parameters (212) - pending
- [ ] M9 no-module-mocking (4) - pending
- [ ] M10 final full gate sweep - pending

## Surprises & Discoveries

- The install also committed nothing; the install changes are uncommitted on
  `main`: `.oxlintrc.json`, `package.json`, `pnpm-lock.yaml`,
  `.agents/skills/install-anti-slop/`, `tools/oxlint/anti-slop/`. M0 must
  commit them so the migration starts from a clean tree.
  Evidence: `git status --short` at plan time shows exactly those paths.

- `.oxlintrc.json` is parsed as JSONC: inline `//` comments in the file are
  tolerated. This is what makes "override with a comment stating the boundary
  contract" physically possible.
  Evidence: a temp config with `//` comments and a per-file override parsed
  and ran oxlint cleanly (see `Artifacts and Notes`).

- Per-file overrides match paths with globs relative to the repo root, like
  the existing `src/renderer/src/components/ui/**/*.tsx` block at
  `.oxlintrc.json:171`. A bare `"files": ["src/renderer/src/api-client.ts"]`
  entry inside a config placed outside the repo did not match; the glob form
  `**/src/renderer/src/api-client.ts` did. In the repo-root config, the plain
  relative path form matches the existing style and works (the existing
  `src/renderer/src/components/ui/**` block proves the mechanism).
  Evidence: override test dropped `no-unknown-returns` errors 10 -> 9 with the
  glob form.

- The actual file count is 195 (74 under `tests/`, 120 under `src/` +
  `runtime/` + `scripts/`, plus root `electron.vite.config.ts`), not ~170 as
  first estimated. The error split 812 tests / 1038 non-tests matches exactly.
  Evidence: `npx oxlint --deny-warnings` output counted by path prefix.

- `runtime/flue/` is a separate sub-package: root `tsconfig.json` includes only
  `src`, `tests`, `electron.vite.config.ts`, `vitest.config.ts`, so
  `runtime/flue/src/patchdesk-insight-agent.ts` and
  `runtime/flue/src/package-smoke-runner.ts` (4 findings total: 2
  no-known-value-widening, 1 no-unsafe-dictionary-type, 1 no-unknown-returns)
  are NOT covered by root `pnpm typecheck`. They ARE linted by root oxlint.
  Their verification gate is `cd runtime/flue && pnpm test -- --run`
  (1 file / 15 tests) and optionally `pnpm build` in `runtime/flue`.

- `no-runtime-typeof` and `no-unknown-parameters` often fire on the SAME
  functions: `src/main/local-api.ts` (17 + 22), `src/adapters/github/github-adapter.ts`
  (25 + 16), `src/domain/ids.ts` (13 + 21), `src/renderer/src/app.tsx` (13 + 5).
  The triage for both rules should be done together per file even though the
  commits stay per rule.

- `src/services/dashboard-controller.ts:217` contains the exact laundering
  pattern the policy forbids:
  `...(typeof input.localPath === "string" ? { localPath: input.localPath as never } : {})`
  (`as never` to force the conditional spread to typecheck). This must be
  rebuilt honestly (parse with a schema; the repo already uses valibot), not
  preserved.

- `src/renderer/src/components/conversation.tsx:79` shows the chained
  assertion pattern `return null as unknown as React.JSX.Element`; the honest
  fix is simply `return null` (React permits null children), removing the
  fake `PrDescription` element entirely.

## Decision Log

- Decision: keep every anti-slop rule at `"error"`; never weaken severity
  globally or per-file (a per-file `"off"` is the only allowed override).
  Rationale: repo-owner policy; `--deny-warnings` makes warnings fail anyway.
  Date/Author: 2026-08-16 / repo owner + planner.

- Decision: where the code IS the I/O boundary (raw HTTP bodies, JSON.parse
  results, model outputs, test bridge doubles, honest `Record<string, unknown>`
  maps of external JSON), keep `unknown` and add a per-file override in
  `.oxlintrc.json` with an inline `// BOUNDARY: ...` comment stating the
  contract. Precedent: the existing `src/renderer/src/components/ui/**`
  override block.
  Rationale: a named type there would be fabricated evidence.
  Status: STILL UNCONFIRMED - this is M0, the first gate, requiring explicit
  repo-owner sign-off before any migration work starts.
  Date/Author: 2026-08-16 / planner, pending owner.

- Decision: per-rule batches, ordered by risk: safe type-level fixes first
  (no-known-value-widening, no-chained-type-assertions, most
  no-unsafe-dictionary-type), then safety-comment additions, then runtime
  refactors with an explicit fix-vs-override triage per site
  (no-unknown-returns, no-conditional-empty-object-spread, no-runtime-typeof,
  no-unknown-parameters, no-module-mocking).
  Rationale: each batch is independently testable and commit-sized.
  Date/Author: 2026-08-16 / planner.

- Decision: `no-runtime-typeof`'s `allowInTypeGuards` option (default false)
  is NOT enabled globally. Per-file override with the option is acceptable
  only inside M0's approved override policy for genuine type-guard helpers.
  Rationale: no global rule weakening.
  Date/Author: 2026-08-16 / planner.

## Outcomes & Retrospective

No milestones complete yet. This section is updated at each milestone and at
completion with per-rule counts cleared, gate results, and lessons learned.

## Context and Orientation

### The repo

Patchdesk is a local-first Electron app for pull-request review
(`pnpm` 8.8.0). Source lives in `src/` (main process, renderer under
`src/renderer/src/`, adapters, services, domain). Tests live in `tests/`
(114 files). `runtime/flue/` is a separate vendored sub-package (its own
`node_modules`, build, and vitest suite) staged into the app at package time.
Root configs: `electron.vite.config.ts` (also linted).

### Gate commands (all run from the repo root)

- `pnpm lint` -> `oxlint --deny-warnings`. CURRENTLY RED (1850 errors).
- `pnpm typecheck` -> `tsc --noEmit`. Green (verified at plan time).
- `pnpm test -- --run` -> vitest. Green: 114 files, 669 tests (verified at
  plan time).
- `cd runtime/flue && pnpm test -- --run` -> flue runtime vitest. Green:
  1 file, 15 tests. Run whenever a change touches `runtime/flue/src/**`.

### The 9 rules that fire (semantics + example from this repo)

1. `anti-slop/require-safety-comment-for-type-assertion` (792 findings;
   661 in `tests/`, 128 in `src/`). Every non-`as const` type assertion
   (`x as T` or `<T>x`) needs a comment matching `/\bSAFETY\s*:/` on the line
   immediately before the assertion or before its owner statement
   (ExpressionStatement, PropertyDefinition, ReturnStatement, ThrowStatement,
   VariableDeclaration). Existing correct examples to copy:
   `src/domain/ids.ts:316` (`// SAFETY: each parser above establishes ...`),
   `src/adapters/github/github-adapter.ts:804`,
   `src/services/codex-insight-invoker.ts:96`. Hotspot:
   `tests/services/review-refresh-service.test.ts` (151).

2. `anti-slop/no-conditional-empty-object-spread` (416; 400 in `src/`). Fires
   on `...(cond ? {} : { ... })` or `...(cond ? { ... } : {})`. Fix by building
   the object with separate statements and adding the property only when
   present. Example: `src/renderer/src/components/pierre-file-tree.tsx:51`
   `...(activePath === undefined ? {} : { initialSelectedPaths: [activePath] })`.

3. `anti-slop/no-runtime-typeof` (255; 233 in `src/`). Fires on `typeof x`
   checks that narrow unparsed values. The intended fix parses at the I/O
   boundary and branches on domain values. Option `allowInTypeGuards` exists
   (default false); do not enable globally. Examples:
   `src/main/local-api.ts` (17), `src/adapters/github/github-adapter.ts` (25),
   `src/renderer/src/app.tsx` (13), `src/domain/ids.ts` (13).

4. `anti-slop/no-unknown-parameters` (212; 175 in `src/`). Fires on explicit
   `: unknown` parameters; a parameter literally named `cause` is exempt.
   Example: `src/main/local-api.ts:586` route handlers taking `jsonBody(...)`
   results typed `unknown`; `src/domain/ids.ts` parse functions
   (`parseGitHubHost(input: unknown, ...)`) that ARE the boundary parsers.

5. `anti-slop/no-unsafe-dictionary-type` (82; 42 in tests/). Fires on
   dictionaries whose value type is `unknown` (e.g. `Record<string, unknown>`)
   when the key/value set is knowable. Examples:
   `src/renderer/src/lib/logger.ts:9,24`, `tests/adapters/github-adapter.test.ts`
   (22).

6. `anti-slop/no-known-value-widening` (43). Fires when a syntactically
   established value flows into an explicit anonymous object type or explicit
   broad type that discards evidence. Fix with inference or `satisfies`.
   Examples: `src/renderer/src/main.tsx:22`
   (`static getDerivedStateFromError(): { readonly failed: true }`),
   `tests/renderer/settings-modal.ui.test.tsx:505`.

7. `anti-slop/no-chained-type-assertions` (31). Fires on assertion chains
   `x as A as B`. Fix by collapsing to the honest single assertion or
   restructuring. Example: `src/renderer/src/components/conversation.tsx:79`
   `return null as unknown as React.JSX.Element` -> `return null`.

8. `anti-slop/no-unknown-returns` (15). Fires on functions annotated to return
   `: unknown`. Most sites are genuine boundaries (see M5). Examples:
   `src/services/read-object-field.ts:5`, `src/renderer/src/api-client.ts:40`
   (`requestJson`), `src/main/desktop-bridge.ts:273,281`.

9. `anti-slop/no-module-mocking` (4). Fires on `vi.mock(...)` calls:
   `tests/adapters/command-runner.test.ts:7,8`
   (`vi.mock("node:child_process")`, `vi.mock("../../src/main/executable-discovery")`),
   `tests/renderer/review-diff-view.ui.test.tsx:18`
   (`vi.mock("@pierre/diffs", ...)` partial mock with `importOriginal`),
   `tests/services/merge-write-controller.test.ts:3`
   (`vi.mock("../../src/services/merge-service")`).

Rules configured but currently finding nothing (keep at `"error"`, no work):
`no-object-parameters`, `no-reflect-apply`, `no-reflect-get`,
`no-shape-in-symbol-names`, `no-unknown-type-aliases`, `no-widen-then-assert`.

### How to inspect findings

Regenerate the full snapshot and per-rule counts:

```bash
cd /Users/kwanpham/Work/cfw/patchdesk
npx oxlint --deny-warnings 2>&1 | tee /tmp/oxlint-full.txt | grep -c "error"
grep -oE "anti-slop\([a-z-]+\)" /tmp/oxlint-full.txt | sort | uniq -c | sort -rn
# per-file for one rule:
grep "no-runtime-typeof" /tmp/oxlint-full.txt | grep -oE "^[^:]+" | sort | uniq -c | sort -rn
```

Expected at baseline: `1850` total; per-rule counts
792 / 416 / 255 / 212 / 82 / 43 / 31 / 15 / 4 (safety-comment, conditional-
spread, runtime-typeof, unknown-parameters, unsafe-dictionary, known-value-
widening, chained-assertions, unknown-returns, module-mocking).

### The override mechanism (verified)

`.oxlintrc.json` tolerates JSONC comments. A per-file override looks like:

```json
{
  "files": ["src/renderer/src/api-client.ts"],
  // BOUNDARY: requestJson returns the raw HTTP response body; each route caller parses with valibot.
  "rules": {
    "anti-slop/no-unknown-returns": "off",
    "anti-slop/no-unknown-parameters": "off"
  }
}
```

Place each override block inside the existing top-level `"overrides"` array of
`.oxlintrc.json`, next to the `src/renderer/src/components/ui/**/*.tsx` block.
Every override MUST carry a `// BOUNDARY:` or `// COMMENT:` comment stating the
contract; M10 re-checks this.

## Plan of Work

The migration proceeds in ten milestones. Each milestone is one rule batch,
ordered by risk. Workflow inside a batch:

1. Re-read the rule semantics above and list its findings
   (`grep <rule> /tmp/oxlint-full.txt`).
2. Triage every site: fix honestly (named type / structural change /
   `SAFETY:` comment / `satisfies` / explicit object construction) or, when
   the code IS the I/O boundary, override that file in `.oxlintrc.json` with a
   contract comment. Never fabricate: no `as unknown` laundering, no invented
   invariants.
3. Fix, then verify (see `Validation and Acceptance`).
4. Commit the batch with a conventional message, lowercase imperative subject.
5. Update this plan's `Progress`, `Decision Log` (per-site override decisions
   if notable), and `Outcomes & Retrospective`.

Batches M1-M3 are safe type-level work (no behavior change). M4 is comment
additions only. M5 builds the boundary inventory (which functions stay
`unknown` and why) that M7/M8 reuse. M6-M8 are runtime refactors where the
risky fix is swapping loose boundary reads for strict schemas; each site gets
an explicit fix-vs-override decision, and overrides are preferred when the
site is a genuine boundary. M9 rewrites test harnesses to dependency
injection. M10 is the final full sweep and owner review of every override.

## Milestones

### M0 - Approval gate and clean baseline (BLOCKED on repo owner)

Goal: explicit repo-owner sign-off on the override-with-reason policy
(Decision Log entry 2), plus a clean starting tree.

Work:

- Commit the uncommitted install changes in one commit:
  `chore: install anti-slop oxlint plugin` (`.oxlintrc.json`, `package.json`,
  `pnpm-lock.yaml`, `.agents/skills/install-anti-slop/`, `tools/oxlint/anti-slop/`).
- Re-verify the baseline gates (commands below) and record the numbers in
  this plan's `Progress`.
- Obtain owner confirmation of: (a) per-file overrides with contract comments
  are acceptable; (b) the M5 boundary inventory approach (functions that stay
  `unknown`); (c) commit granularity (one commit per rule batch).

Commands (repo root):

```bash
git add .oxlintrc.json package.json pnpm-lock.yaml .agents/skills/install-anti-slop tools/oxlint/anti-slop
git commit -m "chore: install anti-slop oxlint plugin"
pnpm typecheck
pnpm test -- --run
cd runtime/flue && pnpm test -- --run
```

Expected result: install commit lands; typecheck exits 0; tests report
114 files / 669 passed; flue reports 1 file / 15 passed. Lint remains red
(1850 errors) - that is expected until M10.

Why it reduces risk: nothing ships until the owner has approved the policy
that every later batch depends on; the tree is clean for restartability.

Effort: ~0.5 h plus owner review time.

### M1 - no-known-value-widening (43) - safe type-level

Goal: every site uses inference or `satisfies`; zero findings for this rule.

Work:

- For each finding, replace the explicit anonymous/broad annotation with
  inference or `satisfies`. Example: `src/renderer/src/main.tsx:22`
  `getDerivedStateFromError(): { readonly failed: true }` -> return without
  the annotation (or keep a named type if the class requires it and the type
  is an honest contract). Test fixtures at `tests/renderer/settings-modal.ui.test.tsx:505,514`
  annotate `success`/`failure` return values: drop the annotation or use
  `satisfies`.
- `runtime/flue/src/patchdesk-insight-agent.ts` has 2 findings; after fixing,
  run the flue gate.

Commands (repo root; after edits):

```bash
npx oxlint src/renderer/src/main.tsx tests/renderer/settings-modal.ui.test.tsx src/services/review-context-service.ts  # 0 errors
grep "no-known-value-widening" /tmp/oxlint-full.txt  # list, then confirm none remain
npx oxlint --deny-warnings 2>&1 | grep -c "no-known-value-widening"   # 0
pnpm typecheck
pnpm test -- --run
cd runtime/flue && pnpm test -- --run   # only if flue files touched
```

Commit: `refactor: keep inferred types at known-value sites`

Expected result: rule count 43 -> 0; typecheck and 669 tests green; no
behavior change (types only).

Why it reduces risk: pure type-level cleanup with the smallest blast radius
builds the per-batch workflow before anything risky.

Effort: ~2-3 h.

### M2 - no-chained-type-assertions (31) - safe type-level

Goal: every chain collapses to the honest single assertion or disappears.

Work:

- For each chain, determine the truthful type. Examples: `return null as
  unknown as React.JSX.Element` (`src/renderer/src/components/conversation.tsx:79`)
  -> `return null`; fixture casts in tests usually need one honest assertion
  plus a `SAFETY:` comment (which M4 will require anyway - add the comment
  now if the assertion survives).
- Files: `tests/services/storage-management-service.test.ts` (5),
  `tests/renderer/pull-request-description.ui.test.tsx` (4),
  `tests/adapters/codex-app-server-client.test.ts` (4),
  `src/renderer/src/flows/inbox-flow.tsx` (2),
  `src/renderer/src/components/conversation.tsx` (2),
  `electron.vite.config.ts` (1, root config - remember it).

Commands (repo root): same shape as M1, replacing the rule name; per-file
`npx oxlint <file>` must show 0 errors on the touched files, then the
full-run grep for the rule returns 0. Then `pnpm typecheck` and
`pnpm test -- --run`.

Commit: `refactor: collapse chained type assertions`

Expected result: rule count 31 -> 0; gates green.

Why it reduces risk: assertion chains are self-contained; removing fabricated
`as unknown as` bridges is exactly the anti-laundering policy in action.

Effort: ~2-3 h.

### M3 - no-unsafe-dictionary-type (82) - mostly safe + triage

Goal: dictionaries with knowable key/value sets get concrete types; honest
dictionaries (arbitrary external JSON) get overrides with contract comments.

Work:

- Fixable: where the value type is knowable, name it. Examples:
  `src/renderer/src/lib/logger.ts:9,24` (structured log payloads),
  `tests/adapters/github-adapter.test.ts` (22 - fixture maps usually have a
  known shape or should become typed fixtures), preference stores
  (`src/renderer/src/inbox-view-preferences.ts`, `diff-theme-preferences.ts`).
- Override candidates (honest maps of external JSON): parts of
  `src/adapters/github/github-adapter.ts` (7), `runtime/flue/src/patchdesk-insight-agent.ts`
  (1), `src/domain/log-entry.ts` (3 - arbitrary metadata),
  `src/adapters/codex/codex-app-server-client.ts` (2). Each override needs a
  `// BOUNDARY:` comment describing what the map actually contains.
- Record each override in `Decision Log` or a per-batch note so M10 can
  re-audit.

Commands: per-file `npx oxlint <file>` -> 0 errors; full-run grep for
`no-unsafe-dictionary-type` -> 0; `pnpm typecheck`; `pnpm test -- --run`;
flue gate if `runtime/flue/src/patchdesk-insight-agent.ts` touched.

Commit: `refactor: give dictionaries concrete value contracts`

Expected result: rule count 82 -> 0; gates green; every surviving
`Record<string, unknown>` is documented in `.oxlintrc.json`.

Why it reduces risk: establishes the fix-vs-override discipline on a mostly
safe rule before the dangerous runtime rules.

Effort: ~3-4 h.

### M4 - require-safety-comment-for-type-assertion (792) - comment additions

Goal: every surviving type assertion carries a truthful `SAFETY:` comment.

Work:

- This is the largest batch. 661 of 792 sites are in `tests/` (fixture
  assertions); 128 in `src/`. Work file-by-file, largest first:
  `tests/services/review-refresh-service.test.ts` (151),
  `tests/adapters/github-adapter.test.ts` (44),
  `tests/domain/pending-review.test.ts` (37),
  `tests/services/storage-management-service.test.ts` (32), then the rest.
- For each assertion, write the invariant the assertion relies on in plain
  language. Copy the house style from `src/domain/ids.ts:316`,
  `src/adapters/github/github-adapter.ts:804`, `src/services/codex-insight-invoker.ts:96`.
  If an assertion cannot be justified truthfully, it is not a comment case:
  fix the code instead (remove the assertion, narrow the type, or restructure)
  and note it in the batch summary.
- Assertions the M2/M3/M7/M8 batches already removed are out of scope.
- Never write a comment that restates the type ("it is a Foo") - the comment
  must state the runtime invariant TypeScript cannot express.

Commands: per-file `npx oxlint <file>` -> 0 errors (this rule only if other
rules in that file are handled by later batches - use
`npx oxlint --deny-warnings <file> 2>&1 | grep -c require-safety-comment` and
require 0); full-run grep for the rule -> 0; `pnpm typecheck`;
`pnpm test -- --run`.

Commit: `refactor: document type assertion invariants with SAFETY comments`

Expected result: rule count 792 -> 0; gates green; zero fabricated comments.

Why it reduces risk: pure additive comments; the largest count drops in one
batch; the discipline ("justify or fix") surfaces the assertions that cannot
be honestly justified, which M7/M8 then handle structurally.

Effort: ~6-10 h (bulk, mostly mechanical but requires honest writing).

### M5 - no-unknown-returns (15) - boundary inventory

Goal: every `: unknown` return is either narrowed or documented as a boundary.

Work: the 15 sites are:

- Genuine boundaries (keep `unknown`, override with contract comment):
  `src/renderer/src/api-client.ts:40` (`requestJson` - raw HTTP body),
  `src/services/read-object-field.ts:5`,
  `src/main/desktop-bridge.ts:273,281` (`readBridgeResponseBody`, `parseJson`),
  `src/domain/log-entry.ts:182` (`sanitizeMetaValue` - arbitrary log values),
  `src/services/insight-run-coordinator.ts:1140,1155`
  (`currentWalkthroughOutput`, `readRetainedValue` - raw model output),
  `src/main/local-api.ts:1143`, `src/renderer/src/app.tsx:858` (`api`),
  `src/main/external-navigation.ts:6`, `runtime/flue/src/package-smoke-runner.ts:36`.
- Test bridge doubles (keep `unknown`, override or narrow in-file):
  `tests/renderer/use-insight-run.test.ts:78`, `tests/renderer/use-review-diff-hydration.test.ts:34`
  (`installBridge` handlers return `Promise<unknown> | unknown` - the bridge
  contract is explicitly unparsed),
  `tests/renderer/review-workbench-flow.ui.test.tsx:103`,
  `tests/domain/review-result.test.ts:10:67`.
- This batch produces the authoritative boundary list that M7/M8 reuse. Put
  the override blocks in `.oxlintrc.json` now (each with a `// BOUNDARY:`
  comment), so later batches do not re-litigate them.

Commands: per-file `npx oxlint <file> 2>&1 | grep -c no-unknown-returns` -> 0;
full-run grep -> 0; `pnpm typecheck`; `pnpm test -- --run`; flue gate.

Commit: `chore: document unknown-return boundaries with overrides`

Expected result: rule count 15 -> 0; the boundary inventory is written into
`.oxlintrc.json` comments and this plan.

Why it reduces risk: a tiny batch that front-loads the trickiest decision -
which functions legitimately stay `unknown` - before the two dangerous rules.

Effort: ~2 h.

### M6 - no-conditional-empty-object-spread (416) - behavior-sensitive

Goal: every conditional empty-object spread becomes explicit construction
with identical runtime semantics.

Work:

- These objects are frequently JSON-serialized (storage records, API
  payloads, snapshots). The rewrite MUST preserve: key order, and
  omitted-vs-`undefined` distinction (a present `undefined` key survives
  `JSON.stringify` differently than an omitted key in some paths; where the
  code relies on `in` checks, omission matters). Prefer building the object in
  statements and assigning the optional property conditionally, or use a
  helper that adds keys only when present.
- Hotspots: `src/adapters/storage/review-remote-store.ts` (53 - serialized
  snapshots; highest care),
  `src/adapters/github/github-adapter.ts` (41 - GitHub API payloads),
  `src/renderer/src/flows/review-workbench-flow.tsx` (26),
  `src/services/review-workbench-projection.ts` (21),
  `src/domain/review-result.ts` (19 - model output schemas),
  `src/renderer/src/components/review-workbench.tsx` (18),
  `src/renderer/src/components/review-diff-view.tsx` (18),
  `src/main/local-api.ts` (16), `src/renderer/src/app.tsx` (14).
- `src/services/dashboard-controller.ts:217` (`as never` laundering) is fixed
  here or in M7/M8's file-level work - do it once, honestly (schema-parse
  `localPath`).
- Where a rewritten object's tests already cover serialization, they prove
  semantics; where not, add a focused unit test asserting exact key set and
  order for the touched serialization boundary (e.g. review-remote-store).

Commands: per-file `npx oxlint <file> 2>&1 | grep -c no-conditional-empty-object-spread` -> 0;
full-run grep -> 0; `pnpm typecheck`; `pnpm test -- --run`; flue gate.

Commit: `refactor: build conditional objects explicitly`

Expected result: rule count 416 -> 0; gates green; serialization tests
(including any added) prove key-set and order equivalence.

Why it reduces risk: 400 of the 416 sites are in `src/`; getting the
omitted-vs-undefined discipline right here prevents subtle storage/API
regressions before the runtime parsing batches.

Effort: ~6-8 h.

### M7 - no-runtime-typeof (255) - dangerous, parse at boundary

Goal: every `typeof` narrowing is replaced by boundary parsing or justified
as a boundary helper.

Work - fix-vs-override triage per site:

- Fix honestly: where a real schema parse belongs at the boundary, add it
  (the repo already uses valibot: `src/renderer/src/renderer-contracts.ts`,
  `src/adapters/storage/*`, `src/adapters/github/github-adapter.ts`,
  `src/main/desktop-bridge.ts`, `src/domain/pending-review.ts`). Then branch
  on the parsed domain value, not `typeof`. This is the risky fix: it changes
  what the app ACCEPTS. Where the current acceptance is intentional (permissive
  for backward compatibility with persisted data), prefer override + comment
  over a stricter schema.
- Override (boundary helpers that are the parse point themselves):
  `src/services/read-object-field.ts` (its `typeof value !== "object"` guard
  IS the boundary check), `src/domain/ids.ts` parse functions, `jsonBody`
  in `src/main/local-api.ts`, `src/renderer/src/api-client.ts` internals
  (`typeof response.body` checks on raw bodies).
- Hotspots: `src/adapters/github/github-adapter.ts` (25),
  `src/main/local-api.ts` (17), `src/renderer/src/app.tsx` (13),
  `src/domain/ids.ts` (13), `src/renderer/src/flows/settings-flow.tsx` (11),
  `src/renderer/src/lib/screen-restore.ts` (10 - persisted window prefs:
  consider schema-parse since data is versioned app state).
- Do not enable `allowInTypeGuards` globally. If a per-file override wants
  it, that is an M0-policy decision recorded in `Decision Log`.

Commands: per-file `npx oxlint <file> 2>&1 | grep -c no-runtime-typeof` -> 0;
full-run grep -> 0; `pnpm typecheck`; `pnpm test -- --run`; flue gate.

Commit: `refactor: parse runtime input at I/O boundaries`

Expected result: rule count 255 -> 0; gates green; every surviving `typeof`
sits in a documented boundary helper.

Why it reduces risk: this is the first of the two dangerous rules; the
fix-vs-override triage discipline from M5's boundary inventory keeps fixes
honest and overrides documented.

Effort: ~6-8 h.

### M8 - no-unknown-parameters (212) - dangerous, parse at boundary

Goal: no unparsed `unknown` parameters except in boundary parsers.

Work - fix-vs-override triage per site (reuse M5 inventory):

- Fix honestly: internal functions that currently accept `unknown` forwarded
  from a boundary should accept the parsed named type; move the parse to the
  true boundary. Examples: `src/services/dashboard-controller.ts` methods
  (`addWatchlistRepo(input: unknown)` etc. - parse the route body with a
  schema, then pass a named input type), `src/services/review-workbench-projection.ts`
  (6), `src/services/review-workbench-controller.ts` (5).
- Override (the function IS the boundary parser): `src/domain/ids.ts` (21
  parse functions returning `Result<Brand, InvalidDomainValue>`),
  `src/main/local-api.ts` `jsonBody`/route plumbing (22),
  `src/adapters/github/github-adapter.ts` (16 - arbitrary external JSON),
  `src/renderer/src/renderer-contracts.ts` (8), test bridge doubles in
  `tests/renderer/review-workbench-flow.ui.test.tsx` (7) and
  `tests/services/storage-management-service.test.ts` (12) where the test
  intentionally feeds unparsed bodies.
- `cause`-named parameters are exempt - no work.

Commands: per-file `npx oxlint <file> 2>&1 | grep -c no-unknown-parameters` -> 0;
full-run grep -> 0; `pnpm typecheck`; `pnpm test -- --run`; flue gate.

Commit: `refactor: accept named inputs at internal boundaries`

Expected result: rule count 212 -> 0; gates green; every `unknown` parameter
is a documented boundary parser.

Why it reduces risk: the second dangerous rule; fixing it honestly requires
adding real schemas at true boundaries, which the tests then exercise.

Effort: ~5-7 h.

### M9 - no-module-mocking (4) - test-harness DI

Goal: replace `vi.mock` with dependency injection through real seams.

Work - each site individually:

- `tests/adapters/command-runner.test.ts:7,8` - mock `node:child_process`
  and `src/main/executable-discovery`. Check whether `CommandRunner`
  (`src/adapters/github/command-runner.ts`) already takes injectable deps
  (spawn factory / executable discoverer); if not, add a constructor seam
  (default to the real `spawn`/`discoverExecutable`), keeping production
  behavior identical. This pulls a small production seam along.
- `tests/services/merge-write-controller.test.ts:3` - mocks
  `src/services/merge-service.mergePullRequest`. Prefer injecting a
  `MergeService`-shaped collaborator into `MergeWriteController`
  (`src/services/merge-write-controller.ts`), or restructure the test to use
  a faithful in-test implementation.
- `tests/renderer/review-diff-view.ui.test.tsx:18` - partial mock of
  `@pierre/diffs` (`preloadHighlighter`). Prefer a vitest `vi.spyOn` on the
  real module or a renderer-level seam; keep the jsdom environment behavior.

Commands: per-file `npx oxlint <file> 2>&1 | grep -c no-module-mocking` -> 0;
full-run grep -> 0; `pnpm typecheck`; `pnpm test -- --run`; flue gate.

Commit: `refactor: replace module mocks with injected seams`

Expected result: rule count 4 -> 0; gates green; production seams are
backward-compatible (existing callers unchanged).

Why it reduces risk: small count but the widest blast radius (production
constructor changes); done last so earlier batches have stabilized the rules
and the M5 boundary inventory exists.

Effort: ~4-6 h.

### M10 - Final gate sweep and owner audit

Goal: all gates green, no fabricated lint fixes, every override documented.

Work:

- `pnpm lint` must exit 0 (run `npx oxlint --deny-warnings`; expect
  `Found 0 warnings and 0 errors`).
- `pnpm typecheck` exit 0; `pnpm test -- --run` 114 files / 669 tests;
  `cd runtime/flue && pnpm test -- --run` 1 file / 15 tests.
- Audit `.oxlintrc.json`: every new override block carries a `// BOUNDARY:`
  or `// COMMENT:` line; no rule was weakened globally; the rule set is
  unchanged at `"error"`.
- Grep for laundering residue: `grep -rn "as unknown as" src/ tests/ runtime/flue/src/`
  must return only sites with truthful `SAFETY:` comments (or none); every
  `as never` in `src/` must be a genuine exhaustiveness marker, not a
  conditional-spread workaround.
- Update `Outcomes & Retrospective`; present the per-rule cleared counts and
  the final override list to the repo owner for review.

Commands (repo root):

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
cd runtime/flue && pnpm test -- --run
grep -rn "as unknown as" src/ tests/ runtime/flue/src/ | wc -l
```

Expected result: all four gates green; audit greps clean; owner signs off.

Commit (if any stragglers): `chore: finalize anti-slop migration`

Why it reduces risk: proves the user-visible outcome end to end and catches
override creep before merge.

Effort: ~1-2 h.

## Concrete Steps

Every milestone follows the same command skeleton. Working directory is the
repo root unless stated.

```bash
# 1. Regenerate the findings snapshot (cheap, ~10-20 s)
cd /Users/kwanpham/Work/cfw/patchdesk
npx oxlint --deny-warnings 2>&1 | tee /tmp/oxlint-full.txt | grep -c "error"

# 2. List the batch's sites
grep "<rule-name>" /tmp/oxlint-full.txt

# 3. Fix / triage / override, then verify the touched files are clean
npx oxlint --deny-warnings <file1> <file2> 2>&1 | grep -c "error"   # expect 0

# 4. Verify the rule's repo-wide count is 0
npx oxlint --deny-warnings 2>&1 | grep -c "<rule-name>"             # expect 0

# 5. Gates
pnpm typecheck
pnpm test -- --run
cd runtime/flue && pnpm test -- --run   # only when runtime/flue/src/** changed

# 6. Commit (per-batch message from the milestone)
git add -A && git commit -m "<message>"
```

Per-milestone commit messages:

- M0: `chore: install anti-slop oxlint plugin`
- M1: `refactor: keep inferred types at known-value sites`
- M2: `refactor: collapse chained type assertions`
- M3: `refactor: give dictionaries concrete value contracts`
- M4: `refactor: document type assertion invariants with SAFETY comments`
- M5: `chore: document unknown-return boundaries with overrides`
- M6: `refactor: build conditional objects explicitly`
- M7: `refactor: parse runtime input at I/O boundaries`
- M8: `refactor: accept named inputs at internal boundaries`
- M9: `refactor: replace module mocks with injected seams`
- M10: `chore: finalize anti-slop migration` (only if stragglers exist)

Repo convention: conventional commits, lowercase imperative subjects
(`feat:`/`fix:`/`docs:`/`chore:`/`refactor:`/`style:` all appear in history).

## Validation and Acceptance

Acceptance is the observable end state, verified at M10:

- `pnpm lint` exits 0 (oxlint `--deny-warnings`, `Found 0 warnings and 0 errors`).
- `pnpm typecheck` exits 0.
- `pnpm test -- --run` reports `Test Files 114 passed` and `Tests 669 passed`.
- `cd runtime/flue && pnpm test -- --run` reports `1 passed` file,
  `15 passed` tests (only required if flue files were touched).
- `.oxlintrc.json` rule set is identical to install state (all 15 anti-slop
  rules `"error"`, no severity changes); the only additions are per-file
  `off` overrides, each with a `// BOUNDARY:`/`// COMMENT:` line.
- No `as unknown` laundering remains without a truthful `SAFETY:` comment;
  no `as never` conditional-spread workarounds remain.

Per-milestone acceptance is: that rule's repo-wide count is 0, the touched
files show 0 errors, typecheck green, 669 tests green, and a commit landed.

Manual spot-check after M6-M8 (behavior-sensitive batches): run the dev app
(`pnpm dev`) and exercise one review open/refresh and one settings save to
confirm persisted data round-trips (snapshot JSON key sets unchanged).

## Idempotence and Recovery

- The findings list is deterministic: re-running `npx oxlint --deny-warnings`
  regenerates `/tmp/oxlint-full.txt`. Every batch step is repeatable.
- Partial batch: unfinished sites simply keep findings; you can commit the
  finished portion of a batch early (per-file clusters) and continue - the
  per-milestone grep count gate (`grep -c <rule>` -> 0) is the single source
  of truth for "batch done".
- Broken fix: each batch lands as one commit; revert a bad file with
  `git checkout <previous-commit> -- <file>` and redo the triage for that
  file. Commits are per-rule, so reverting one batch never touches another
  rule's work.
- Override mistakes: an override added in error is removed by deleting the
  block from `.oxlintrc.json` and re-running the file's `npx oxlint <file>`
  check; the M10 audit re-scans every block.
- Riskiest recovery is M7/M8 (acceptance-behavior changes): if a stricter
  schema breaks a persisted-data path that tests do not cover, the override-
  with-comment option (not the schema) is the fallback for that site; record
  the decision in `Decision Log`.
- If a milestone's tests turn red for reasons unrelated to the batch, stop,
  investigate, and record in `Surprises & Discoveries` before continuing.

## Artifacts and Notes

Verified mechanics (re-run to reproduce):

```bash
# JSONC comments + per-file override are accepted by oxlint
cat > /tmp/oxlint-override-probe.json <<'EOF'
{
  "jsPlugins": [
    { "name": "anti-slop",
      "specifier": "/Users/kwanpham/Work/cfw/patchdesk/tools/oxlint/anti-slop/index.ts" }
  ],
  "rules": { "anti-slop/no-unknown-returns": "error",
             "anti-slop/no-unknown-parameters": "error" },
  "overrides": [
    {
      "files": ["**/src/renderer/src/api-client.ts"],
      // BOUNDARY: requestJson returns the raw HTTP response body; route callers parse with valibot.
      "rules": { "anti-slop/no-unknown-returns": "off" }
    }
  ]
}
EOF
npx oxlint -c /tmp/oxlint-override-probe.json src/renderer/src/api-client.ts 2>&1 | grep -c "error"  # 2 (both remaining are no-unknown-parameters)
```

Baseline evidence captured at plan time (2026-08-16):

- `npx oxlint --deny-warnings`: 1850 errors, 195 files (74 `tests/`,
  120 `src/`+`runtime/`+`scripts/`, plus `electron.vite.config.ts`); split
  812 tests / 1038 non-tests.
- Per-rule: 792 safety-comment, 416 conditional-spread, 255 runtime-typeof,
  212 unknown-parameters, 82 unsafe-dictionary, 43 known-value-widening,
  31 chained-assertions, 15 unknown-returns, 4 module-mocking.
- `pnpm typecheck`: exit 0.
- `pnpm test -- --run`: 114 files / 669 tests passed (12.6 s).
- `cd runtime/flue && pnpm test -- --run`: 1 file / 15 tests passed (1.0 s).

Existing SAFETY-comment style to copy: `src/domain/ids.ts:316`,
`src/adapters/github/github-adapter.ts:804`, `src/services/codex-insight-invoker.ts:96`.
Existing override precedent: `.oxlintrc.json:171`
(`src/renderer/src/components/ui/**/*.tsx`).

## Interfaces and Dependencies

- Gate commands: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`
  (root); `pnpm test -- --run` in `runtime/flue` (sub-package, own vitest).
- `.oxlintrc.json`: the ONLY config file edited; all 15 anti-slop rules stay
  `"error"`; new per-file override blocks go in the top-level `"overrides"`
  array with contract comments.
- Boundary parsing library: valibot (`import * as v from "valibot"`) is the
  established schema tool - reuse existing schemas
  (`src/domain/review-result.ts` `modelReviewResultSchema`,
  `src/services/walkthrough-operation.ts` `walkthroughOutputSchema`,
  renderer contracts) instead of inventing new parse styles.
- Production seams that M9 may extend: `CommandRunner`
  (`src/adapters/github/command-runner.ts`) and `MergeWriteController`
  (`src/services/merge-write-controller.ts`) - new seams must default to
  current behavior so existing callers are untouched.
- `runtime/flue/src/patchdesk-insight-agent.ts` and
  `runtime/flue/src/package-smoke-runner.ts` are linted by root oxlint but
  typechecked only by the flue package - any edit there requires the flue
  test gate (and `pnpm build` in `runtime/flue` for a full check).
- `.agents/PLANS/` sibling plan style: frontmatter `created_at`,
  `repos: [patchdesk]`, `status`; this plan follows it.
- The repo owner is the approver for M0 (override policy) and M10 (final
  override audit). No other external dependencies.
