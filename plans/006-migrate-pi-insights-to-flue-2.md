# Plan 006: Migrate Pi Insights from Flue beta.9 to Flue 2.0.3

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. This is a breaking dependency migration, not a version-only
> update. Remove beta APIs instead of adding compatibility wrappers. If any
> item in **STOP conditions** occurs, stop and report it; do not improvise.
> When done, update this plan's row in `plans/README.md` unless a reviewer says
> they maintain the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 7b4f6e6..HEAD -- \
>   AGENTS.md CHANGELOG.md package.json pnpm-lock.yaml flue.config.ts \
>   scripts/stage-flue-runtime.mjs scripts/package-smoke.mjs \
>   src/adapters/pi src/main/electron-main.ts src/main/workflow-runtime-root.ts \
>   src/services/flue-cli-review-invoker.ts \
>   src/services/flue-cli-walkthrough-invoker.ts \
>   src/services/insight-run-coordinator.ts src/services/model-review-runner.ts \
>   src/services/review-inspector-tools.ts src/workflows src/flue-runtime-types.ts \
>   tests/services tests/workflows tests/main-desktop-hardening.test.ts
> ```
>
> Then run the same path list through `git diff --stat --` and
> `git diff --cached --stat --`. The checkout was already dirty when this plan
> was written. `AGENTS.md`,
> `package.json`, and `pnpm-lock.yaml` contain unrelated React Doctor changes;
> preserve them. If Plans 004 and 005 have landed, compare live symbols with the
> **Post-Plan-005 assumptions** below rather than restoring deleted attempt,
> incremental, completion, or local-batch concepts.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/004-lock-packaged-flue-runtime.md` and
  `plans/005-remove-superseded-review-systems.md`
- **Category**: migration / dependencies / packaging
- **Planned at**: commit `7b4f6e6`, 2026-08-13
- **Target checked**: npm `latest` and upstream tag `v2.0.3`, 2026-08-13

## Why this matters

Patchdesk pins all Flue packages to `1.0.0-beta.9`. The current npm `latest` is
`2.0.3`. Flue 2 removes `defineWorkflow`, `defineAgent`, workflow discovery,
and `harness.session()`, so this is an execution-boundary rewrite rather than a
package bump. The migration must retain Patchdesk's current safety contract:
`InsightRunCoordinator` owns durable Analysis/Walkthrough state, cancellation,
revision checks, validation, and retained results; Flue performs one finite
model operation and has no GitHub write authority.

The migration also fixes the current unreproducible packaged runtime. Today the
staging script creates an unlocked manifest and can copy an older packaged
`node_modules`. The new runtime closure must be exact, frozen, verifiable, and
executed by package smoke tests.

## Upstream basis

Use the cached upstream checkout, not remembered beta APIs:

- Checkout: `/Users/kwanpham/.cache/checkouts/github.com/withastro/flue`
- Exact reviewed tag: `v2.0.3`
- Migration guide:
  `apps/docs/src/content/docs/guide/migration.md`
- Workflows guide:
  `apps/docs/src/content/docs/guide/workflows.md`
- Agents guide:
  `apps/docs/src/content/docs/guide/building-agents.md`
- Tools guide:
  `apps/docs/src/content/docs/guide/tools.md`
- Agent API:
  `apps/docs/src/content/docs/reference/agent-api.md`
- Runtime implementation:
  `packages/runtime/src/node/start.ts`,
  `packages/runtime/src/agent-client.ts`, and
  `packages/runtime/src/hooks/use-data-writer.ts`

Facts verified at `v2.0.3`:

1. Flue 2 removes workflows and `defineAgent`; agent modules export synchronous
   capitalized functions that use hooks.
2. A standalone Node program calls `start()` from `@flue/runtime/node`, then
   `init()` / `dispatch()` / `read()` from `@flue/runtime`.
3. `read()` returns `AgentReply`, including named `useDataWriter` data parts.
4. A signal passed only to `read()` cancels the local wait, not the submission;
   `AgentInstanceHandle.abort()` requests durable cancellation.
5. Custom tool handlers receive parsed arguments as `data`; object results must
   be wrapped as `{ output: value }`.
6. No `useSandbox()` means no filesystem/shell sandbox tools. The framework's
   `task` tool remains present but is inert when no subagents are declared.
7. Flue 2.0.3 requires Node `>=22.19.0`. The current Electron 43.1.1 Node mode
   reports Node `24.18.0`.
8. `@flue/runtime@2.0.3` depends on `@earendil-works/pi-ai@^0.83.0`; Patchdesk
   currently pins `0.80.7` and must align its direct Pi catalog dependency.
9. `flue run --json` emits final assistant text, not `AgentReply.data`. It is
   not a sufficient strict structured-result transport for Patchdesk.

## Current state

### Current beta execution

- `src/workflows/review-pr.ts` and
  `src/workflows/generate-walkthrough.ts` use `defineAgent`, `defineWorkflow`,
  and `harness.session().prompt(...)`.
- `src/services/flue-cli-review-invoker.ts` runs:

  ```text
  <electron-node> <@flue/cli>/bin/flue.mjs run workflow:review-pr --input <json>
  ```

- `src/services/flue-cli-walkthrough-invoker.ts` does the same for
  `workflow:generate-walkthrough`.
- `src/flue-runtime-types.ts` is a beta.9-only declaration workaround.
- `src/services/review-inspector-tools.ts` uses the beta tool shape:
  `run({ input })` and bare object returns.

### Current authority boundary to preserve

`docs/adr/0013-keep-model-runs-bounded-and-non-authoritative.md` requires:

- Patchdesk prepares immutable revision artifacts.
- Patchdesk starts one finite model run and validates a strict result.
- Pi Analysis receives only session-bound changed-file inspection and immutable
  Git reads.
- Pi Walkthrough receives bounded stored artifacts with no tools.
- Neither can mutate a checkout, read credentials, write GitHub state, publish,
  change threads, or merge.
- Patchdesk performs Finding mapping, freshness checks, retained-result updates,
  and every actionability decision after model output validation.

### Current packaging weakness

`scripts/stage-flue-runtime.mjs`:

- generates `out/workflow-runtime/package.json` with no committed runtime lock;
- runs an offline install against whatever is in the local store;
- copies dependencies from a previous packaged app on failure;
- stages workflow source and a special walkthrough discovery project.

`scripts/package-smoke.mjs` launches the packaged UI but does not execute the
packaged Pi runtime.

## Post-Plan-005 assumptions

Plan 005 must land first. At migration start, these statements must be true:

- Pi Analysis remains, but its invocation input has no Review Attempt ID,
  incremental `scope`, completion action, or local `ReviewBatch` fields.
- `InsightRunCoordinator` is the only Analysis/Walkthrough run owner.
- `ModelReviewRunner` still performs complete prepared-artifact review with the
  four `ReviewInspector` tools.
- The current Walkthrough schema, artifact bounds, normalization, and timeout
  calculation remain.
- `src/workflows/review-pr.ts` may have been renamed or simplified by Plan 005;
  locate its current Pi Analysis implementation before changing it.

If Plan 005 did not reach these conditions, stop. Do not port fields that Plan
005 is scheduled to delete. Plan 004 must also have replaced the unlocked
packaged-runtime cache with a committed exact lock; update that boundary rather
than recreating it.

## Architectural decision

Use a **Patchdesk-owned one-shot child runner** built on Flue 2's programmatic
Node API. Do not use `flue run` as the production transport.

The child process preserves the current isolation boundary while avoiding the
Flue 2 CLI's text-only result envelope:

1. Parent sends one bounded JSON invocation through stdin.
2. Child strictly parses the invocation.
3. Child constructs invocation-scoped agent functions and closures.
4. Child calls `start({ agents: [...] })` with default in-memory persistence.
5. Child dispatches one create-only conversation with a fresh deterministic ID.
6. The agent receives only its bounded inspection capabilities plus one
   `submit_patchdesk_result` tool whose input is the existing strict result
   schema. Walkthrough receives only the submission tool.
7. The submission tool writes its already schema-validated `data` through one
   unconditional `useDataWriter("patchdeskResult", { schema })` and returns
   `{ output: "Result recorded.", terminate: true }`.
8. Child reads `reply.data.patchdeskResult`, requires exactly one value, parses
   it again, and writes exactly one JSON object to stdout.
9. On SIGTERM/SIGINT, the child calls the active handle's `abort()`, waits only
   for a short bounded drain, stops Flue, and exits. `CommandRunner` remains the
   hard process-group termination backstop.

This design keeps strict structured output in a Valibot-backed model-callable
submission tool and Flue's `useDataWriter` data channel. It never interprets
model prose as the product result.

### Agent shape

The child creates one invocation-scoped agent per process. Each agent:

- is a named capitalized function;
- calls `useModel(input.model, { thinkingLevel: input.reasoning })`;
- declares one `submit_patchdesk_result` tool with `useTool()`;
- for Analysis only, mounts an inline `defineSkill()` created from trusted
  `SKILL.md` text read by normal Node code; do not rely on Vite's `.md` module
  transform in the standalone child;
- declares `useDataWriter("patchdeskResult", { schema })` unconditionally;
- does not call `useSandbox`, `useSubagent`, `useMcpConnection`,
  `usePersistentState`, or lifecycle hooks;
- returns the complete prepared prompt plus instructions that require one call
  to the submission tool and no independent answer.

The submission tool uses the current strict object schema directly as its
`input`. It receives `run({ data })`, writes `data`, and returns the terminating
tool envelope. The agent closure owns synchronous `submitted` and
`duplicateSubmissionAttempted` guards. The first valid call writes; every later
call sets the duplicate flag and returns a terminating refusal without writing.
After `read()`, the child rejects the result as `invalid_result` if the duplicate
flag is true even when exactly one data part exists. Tool batches execute
concurrently and Flue ends a turn only when every result in a batch terminates,
so every Analysis inspector tool must also return `terminate: true` when
`submitted` was already true at that tool call's completion. This prevents a
batch containing result submission plus inspection from forcing another model
turn. The next render removes all custom tools and tells the model that the
result is already recorded; later calls cannot replace it.

- Walkthrough custom tools: `submit_patchdesk_result` only.
- Analysis custom tools: exactly the four existing `ReviewInspector` tools plus
  `submit_patchdesk_result`.

Flue's inert framework `task` tool may additionally be present. Analysis also
has Flue's trusted `activate_skill` framework tool because it mounts the
Patchdesk review skill; Walkthrough does not. Tests must assert the exact
Patchdesk custom capability set and absence of sandbox/MCP/declared-subagent
tools, not that Flue's framework tool list is empty.

Create `ReviewInspector` outside the agent render and close over the instance,
so rerenders cannot reset its global eight-call budget.

## Commands you will need

- Install/update dependencies: `pnpm install --frozen-lockfile=false`
- Focused typecheck: `pnpm typecheck`
- Focused tests: use exact files listed per step with `pnpm test -- --run ...`
- Lint: `pnpm lint`
- Full tests: `pnpm test -- --run`
- Build: `pnpm build`
- Stage packaged runtime: `pnpm stage:flue-runtime`
- Package: `pnpm package:mac`
- Package smoke: `pnpm test:package-smoke`
- Browser gate: `pnpm exec playwright test`
- Whitespace: `git diff --check`

When a public API is uncertain, read the exact `v2.0.3` docs and source from
the cached upstream checkout named in **Upstream basis**. The production design
removes `@flue/cli`, so do not depend on `flue docs` being installed.

## Scope

### In scope

Expected source files; adjust names only when Plan 005 already renamed the same
concept:

- `package.json`
- `pnpm-lock.yaml`
- `CHANGELOG.md`
- `README.md`
- `docs/adr/0013-keep-model-runs-bounded-and-non-authoritative.md` only if its
  implementation wording needs a current Flue 2 clarification
- `AGENTS.md`
- `scripts/stage-flue-runtime.mjs`
- `scripts/package-smoke.mjs`
- create `scripts/smoke-env.mjs` or an equivalent explicit allowlist helper
  shared only by package smoke child launches
- create `runtime/flue/package.json`
- create `runtime/flue/pnpm-lock.yaml`
- create `runtime/flue/vite.config.ts` for the Node child bundle
- create `runtime/flue/src/package-smoke-runner.ts` or an equivalent separate
  smoke-only entry
- create `runtime/flue/src/patchdesk-insight-agent.ts` or equivalent
- create `runtime/flue/src/patchdesk-insight-runner.ts` or equivalent
- move or refactor the current logic in:
  - `src/workflows/review-pr.ts`
  - `src/workflows/generate-walkthrough.ts`
  - `src/services/model-review-runner.ts`
- `src/services/review-inspector-tools.ts`
- `src/services/flue-cli-review-invoker.ts`
- `src/services/flue-cli-walkthrough-invoker.ts`
- `src/main/electron-main.ts`
- `src/main/workflow-runtime-root.ts`
- `src/adapters/pi/pi-ai-catalog.ts` and provider/model catalog tests as needed
- delete `flue.config.ts` if no current caller remains
- delete `src/flue-runtime-types.ts`
- delete `src/flue-routing-types.ts` if no current caller remains
- relevant focused tests under `tests/adapters/`, `tests/services/`,
  `tests/workflows/`, and `tests/main-desktop-hardening.test.ts`

### Out of scope

- Codex invocation behavior, Codex permissions, or Codex protocol changes.
- GitHub writes, pending reviews, direct summaries, published feedback, thread
  state, merge behavior, Refresh, or observation.
- Renderer redesign or Insight result schema redesign.
- Adding a Flue HTTP server, Hono agent routes, `@flue/vite`, or Vite 8 to
  Electron's build. The programmatic child does not need them.
- Persisting Flue conversations. Every child uses in-memory persistence and one
  fresh instance.
- Flue instrumentation or telemetry. Flue 2 can capture content when
  instrumentation is installed; this migration must install none.
- Compatibility with beta Flue stores or beta APIs.
- Upgrading unrelated dependencies.

## Git workflow

- Remain on the current branch unless the operator requests a branch change.
- Preserve all pre-existing edits. Stage explicit paths only.
- Use conventional commits matching repository history, for example:
  `feat: migrate insight runtime to flue 2`.
- Do not push unless requested.

## Steps

### Step 1: Characterize the protected execution boundary

Before dependency changes, ensure focused tests explicitly cover the behavior
that must survive:

- `InsightRunCoordinator` owns queued/running/cancelling/terminal state.
- cancellation is durably requested before its signal terminates the child;
- late success after cancellation does not retain a result;
- stale revision and changed patch results become `superseded`;
- malformed output becomes `invalid_result`;
- retained results survive replacement failure;
- Analysis uses exactly the four inspector tools and the eight-call aggregate
  budget;
- Walkthrough uses no inspection tools and preserves all input/output bounds;
- debug and diagnostic records never contain invocation bodies, provider output,
  credentials, or unbounded stderr.

Use these files as the current patterns:

- `tests/services/insight-run-coordinator.test.ts`
- `tests/services/model-review-runner.test.ts`
- `tests/services/review-inspector.test.ts`
- `tests/services/review-inspector-tools.test.ts`
- `tests/workflows/generate-walkthrough.test.ts`

Do not add beta-specific assertions. The tests must describe Patchdesk behavior,
not `workflow:<name>` implementation details.

**Verify**:

```bash
pnpm test -- --run \
  tests/services/insight-run-coordinator.test.ts \
  tests/services/model-review-runner.test.ts \
  tests/services/review-inspector.test.ts \
  tests/services/review-inspector-tools.test.ts \
  tests/workflows/generate-walkthrough.test.ts
```

Expected: all selected tests pass before the migration starts.

### Step 2: Create the isolated Flue 2 package and one-shot proof

Do not replace root beta dependencies yet. Create the final dedicated
`runtime/flue/` package with its own exact manifest and lock so the proof can
run against Flue 2 while the current application remains buildable.

The package owns:

- exact `@flue/runtime: 2.0.3` and one exact compatible `pi-ai` production
  version;
- exact build/test dev dependencies, including Vite 7 (not Vite 8), TypeScript,
  and the test runner versions already used by the root where needed;
- `vite.config.ts` with two Node entries: production one-shot runner and a
  separate smoke-only runner;
- scripts for `build`, `test`, and a production-only frozen deployment;
- one committed `pnpm-lock.yaml` generated with pnpm 8.8.0.

The Vite build must bundle Patchdesk-owned child/orchestration modules but
externalize only the exact runtime dependencies staged beside the bundle. Its
output is `runtime/flue/dist/` during development and copied to
`out/workflow-runtime/` by staging. The package build must not import root
`node_modules` or require `@flue/vite`.

Create an integration proof around the exact production design, not a mock of
Flue:

- Start Flue with an in-memory database and a faux Pi provider.
- Register one invocation-scoped agent.
- Agent mounts one strict `submit_patchdesk_result` tool and one named data
  writer. Analysis also mounts exactly four bounded inspector tools.
- Read returns exactly one `patchdeskResult` value.
- No sandbox is mounted.
- No subagent is declared.
- Cancellation calls the agent handle's `abort()`; using only a read signal is
  forbidden.
- Stop the runtime after success, invalid output, cancellation, and startup
  failure.

Use Flue 2's official `fauxProvider()` from aligned `pi-ai`; do not make a
network call or require a real provider account.

Inject the provider as an explicit runner dependency in tests (or through a
separate smoke-only entry). Production runner code must not branch on arbitrary
renderer input to enable faux mode, and its normal `start()` call must not
register a faux provider.

Name this focused test clearly under the isolated package, for example:
`runtime/flue/tests/flue-2-insight-runtime.test.ts`.

The proof must include:

1. strict structured success;
2. missing data part -> `invalid_result`;
3. duplicate result write -> `invalid_result`; assert both multiple data writes
   and a refused duplicate attempt after the first write;
4. a provider batch containing `submit_patchdesk_result` and an inspector
   settles without a follow-up model turn and records only the submitted
   result;
5. malformed/extra fields rejected by the existing strict schema;
6. abort settles without retaining output;
7. a multi-turn Analysis prompt that attempts at least nine inspector calls;
   call nine is denied because one `ReviewInspector` instance survives every
   render/turn;
8. no Flue sandbox tools, MCP tools, or declared subagents; permit Flue's inert
   framework `task`, and permit `activate_skill` only for Analysis with the
   trusted Patchdesk review skill.

**Verify**:

```bash
pnpm --dir runtime/flue install --frozen-lockfile
pnpm --dir runtime/flue test -- --run tests/flue-2-insight-runtime.test.ts
```

Expected: all cases pass with no provider credentials and no network.

**STOP** if Flue 2 cannot return schema-validated `AgentReply.data` without
interpreting assistant text, or if the inspector budget cannot survive multiple
turns and concurrent tool calls.

### Step 3: Prove the aligned Pi catalog before changing root dependencies

Keep root beta packages installed while production callers are converted in
Steps 4-7. In the isolated runtime, choose one exact `pi-ai` version that
satisfies Flue `^0.83.0`. Prefer npm latest only after confirming every
Patchdesk-imported provider catalog subpath remains; otherwise pin `0.83.0` as
the smallest compatible version and record why.

Add a temporary read-only compatibility test or script that imports the exact
catalog symbols Patchdesk uses from the isolated version. Do not modify root
`package.json` yet and do not add a second permanent provider catalog.

**Verify**:

```bash
pnpm --dir runtime/flue test
pnpm test -- --run \
  tests/adapters/pi-runtime-model-catalog.test.ts \
  tests/adapters/pi-provider-catalog.test.ts
```

Expected: isolated Flue 2 tests and current root catalog tests pass. The chosen
exact Pi version is recorded in the runtime manifest and migration notes.

### Step 4: Add Flue 2 inspector adapters without breaking beta callers

Keep `src/services/review-inspector-tools.ts` working for the beta workflow
until Step 8. Extract or retain framework-neutral inspector operations and
schemas in current Patchdesk services, then add Flue 2 `useTool()` adapters
under `runtime/flue/src/`. Do not make root TypeScript resolve Flue 2 through
the beta declaration aliases.

The isolated adapters:

- expose exactly these custom inspector names:
  - `list_changed_files`
  - `search_files`
  - `read_file_range`
  - `git_show`
- rename handler context `input` to `data`;
- return `{ output: <typed value> }` for every object result;
- retain strict Valibot input/output schemas;
- retain denial results and do not expose internal denial reasons to the model;
- do not add a sandbox or generic file/shell/GitHub tool;
- do not reconstruct `ReviewInspector` inside a render or tool call.

Update `model-review-runner.ts` only as needed to prepare framework-neutral
Analysis prompt/input and to create one invocation-scoped `ReviewInspector`.
The existing beta workflow can call that preparation during the transition;
the isolated Flue 2 agent mounts its adapters and strict submission tool. Do
not create a root declaration shim for Flue 2.

**Verify**:

```bash
pnpm test -- --run \
  tests/services/review-inspector.test.ts \
  tests/services/review-inspector-tools.test.ts \
  tests/services/model-review-runner.test.ts
pnpm --dir runtime/flue test -- --run tests/flue-2-insight-runtime.test.ts
pnpm typecheck
```

Expected: all selected tests pass; call nine remains denied.

### Step 5: Build the Flue 2 Walkthrough vertical slice in isolation

Extract the current bounded Walkthrough operation into framework-neutral plain
Patchdesk prompt preparation. Keep the beta `defineWorkflow` wrapper calling
that preparation until Step 8. Build the new Flue 2 Walkthrough agent and child
path under `runtime/flue/src/`; do not switch production composition yet.

Preserve exactly:

- `walkthroughInputSchema`;
- artifact size bounds;
- hunk alias manifest creation;
- output schema limits and total-section check;
- `insightOutputGuidance("walkthrough")`;
- model and reasoning selection supplied by the validated invocation;
- no custom tools except `submit_patchdesk_result`;
- post-return parse and `normalizeNarrativeWalkthrough` in the coordinator.

The Walkthrough agent must have no `useSkill`, `useSandbox`, `useSubagent`, MCP,
or inspector tools. Its root driver is application plumbing, not model-visible
GitHub capability.

Add the common one-shot process adapter behind a new internal class while
`FlueCliWalkthroughInvoker` remains the production beta path. Step 8 switches
composition and deletes the old class/name. Keep bounded timeout calculation
and `CommandRunner` process-group cancellation in the target adapter.

**Verify**:

```bash
pnpm test -- --run \
  tests/workflows/generate-walkthrough.test.ts \
  tests/services/flue-cli-walkthrough-invoker.test.ts \
  tests/services/insight-run-coordinator.test.ts
pnpm --dir runtime/flue test -- --run tests/flue-2-insight-runtime.test.ts
pnpm typecheck
```

Expected: Walkthrough success, bounds, timeout, invalid-result, and cancellation
cases pass through the new child boundary.

### Step 6: Build Analysis and skill packaging in isolation

Build current Analysis in the same isolated Flue 2 child pattern while keeping
the beta production wrapper operational. Shared Patchdesk preparation and
validation may be extracted, but Flue 2 hooks stay under `runtime/flue/src/`
until the atomic switch.
Preserve:

- complete prepared context, review input, and patch reads;
- immutable file snapshot creation and safe Git object reads;
- one invocation-scoped `ReviewInspector` shared across all turns;
- exactly four inspector tools plus `submit_patchdesk_result`;
- strict `modelReviewResultSchema` as the submission tool's `input` schema;
- Patchdesk-side parse, Finding mapping, and retained-result validation;
- no GitHub write capabilities.

Do not use a static `.md` import: Flue 2 turns `SKILL.md` imports into
`SkillReference` objects through `@flue/vite`, which this standalone runtime
intentionally does not install. Instead:

- read the trusted packaged `src/skills/patchdesk-code-review/SKILL.md` during
  child startup through a fixed app-owned path;
- strictly parse its current frontmatter name and description;
- pass its Markdown body to `defineSkill({ name, description, instructions })`;
- mount the returned definition with `useSkill()` and instruct the driver
  prompt to activate it;
- reject malformed or missing packaged skill content as `runtime_unavailable`;
- never accept a skill path or skill text from renderer/model input.

Its current directory has no supporting files. If supporting files appear
before execution, STOP and either package them explicitly through
`defineSkill({ files })` with bounded, symlink-free reads or revise the plan;
do not silently drop them.

Do not mount a sandbox. Prepared artifacts are read by trusted Patchdesk code
before dispatch; the model sees only the composed prompt, the four bounded
inspectors, and the strict submission tool.

**Verify**:

```bash
pnpm test -- --run \
  tests/services/model-review-runner.test.ts \
  tests/services/review-inspector.test.ts \
  tests/services/review-inspector-tools.test.ts \
  tests/services/flue-cli-review-invoker.test.ts \
  tests/services/insight-run-coordinator.test.ts
pnpm --dir runtime/flue test -- --run tests/flue-2-insight-runtime.test.ts
pnpm typecheck
```

Expected: Analysis produces a strict result; immutable snapshots and the
inspection budget remain; no write-capable tool enters the graph.

### Step 7: Complete the isolated strict child protocol and cancellation handshake

The child stdin protocol must be one strict discriminated object:

```ts
{ type: "analysis", input: <current Analysis invocation> }
{ type: "walkthrough", input: <current Walkthrough invocation> }
```

Requirements:

- bounded stdin and stdout (retain the current 2 MiB process-output ceiling or
  choose a smaller documented result ceiling consistent with schemas);
- enforce the stdin byte limit in the parent before `CommandRunner.execute()`
  writes to the child, and independently reject an oversized stdin stream in
  the child before JSON parsing;
- no invocation JSON in argv, process title, diagnostics, or logs;
- stdout contains exactly one JSON result and nothing else;
- stderr may contain Flue operational output but stays inside the adapter and is
  mapped to allowlisted categories before persistence;
- child validates all paths and domain identifiers before reading;
- child verifies runtime Node `>=22.19.0` before starting Flue;
- each child starts one in-memory Flue runtime and one fresh create-only agent
  instance;
- `InsightRunCoordinator` remains the only durable run owner;
- SIGTERM/SIGINT handler calls `handle.abort()` and then bounded `flue.stop()`;
- parent `AbortSignal` still causes `CommandRunner` to terminate only the owned
  process group;
- timeout and forced termination remain safe even when the provider ignores
  cancellation;
- output arriving after parent cancellation is discarded.

Do not pass the parent signal only to `handle.read()`: upstream says that stops
only the local wait and leaves the submission running.

Rename process classes and resolver symbols to current vocabulary if practical:
`FlueCli*` and `workflow-runtime-root` are misleading once no CLI/workflow
exists. Delete old names rather than retain aliases.

**Verify**:

```bash
pnpm --dir runtime/flue test -- --run tests/flue-2-insight-runtime.test.ts
pnpm test -- --run \
  tests/services/flue-cli-review-invoker.test.ts \
  tests/services/flue-cli-walkthrough-invoker.test.ts \
  tests/services/insight-run-coordinator.test.ts \
  tests/main-desktop-hardening.test.ts
pnpm typecheck
```

Expected: success, invalid protocol, oversized stdin, malformed result,
pre-abort, mid-run abort, timeout, output overflow, and child crash cases pass.

### Step 8: Switch root callers and dependencies atomically

After the isolated proof and converted child protocol pass, make the root
switch in one change:

- point both Pi Insight invokers and production composition at the compiled
  dedicated child;
- remove root `@flue/cli`, `@flue/react`, `@flue/runtime`, and `@flue/sdk`;
- update root `@earendil-works/pi-ai` to the same exact version selected by the
  isolated runtime;
- remove beta TypeScript aliases and declarations only when no current source
  import needs them;
- remove temporary beta wrappers and old workflow modules only after both
  production invokers resolve the new compiled child;
- add root `engines.node: ">=22.19.0"` and retain pnpm 8.8.0;
- do not add `@flue/vite` or upgrade root Vite.

Run the complete import inventory:

```bash
rg -n '@flue/(cli|react|sdk|vite)|@flue/runtime|@earendil-works/pi-ai' \
  src tests scripts package.json runtime/flue/package.json
pnpm why @flue/runtime
pnpm why @earendil-works/pi-ai
```

Expected: root has no Flue runtime package; the dedicated package owns exactly
Flue 2.0.3; root and child use one exact compatible Pi version; beta.9 is gone.

Do not finish this step in a state where root tests import Flue 2 hooks through
the old beta declaration aliases. The root application must typecheck and both
Insight paths must use the child before beta packages are removed.

**Verify**:

```bash
pnpm typecheck
pnpm test -- --run \
  tests/adapters/pi-runtime-model-catalog.test.ts \
  tests/adapters/pi-provider-catalog.test.ts \
  tests/services/flue-cli-review-invoker.test.ts \
  tests/services/flue-cli-walkthrough-invoker.test.ts
pnpm --dir runtime/flue test
```

Expected: root typecheck/provider/invoker tests and isolated runtime tests pass
without any beta dependency.

### Step 9: Update the reproducible packaged runtime closure

Plan 004 already introduced a committed exact beta runtime lock and removed
the previous-package cache fallback. Replace that package with the dedicated
Flue 2 package created in Step 2; do not create another lock or restore dynamic
manifest generation:

```text
runtime/flue/
  package.json
  pnpm-lock.yaml
```

Rules:

- exact Flue/Pi versions, no ranges in the runtime package;
- committed lockfile generated for this package;
- install/stage with `--frozen-lockfile`, `--prod`, `--offline`, and
  `--ignore-scripts` after dependencies are already fetched by the normal root
  install or an explicit preparation step;
- no copy-from-previous-package fallback;
- fail closed when the offline store is incomplete;
- stage a self-contained runtime tree that does not depend on absolute pnpm
  symlink targets outside `Resources/flue-runtime`;
- stage the compiled one-shot runner, converted agent/orchestration modules,
  strict domain schemas, and full Analysis skill folder;
- do not stage `flue.config.ts`, workflow discovery directories, a walkthrough
  subproject, or `@flue/cli` unless a proven current runtime import requires it;
- write a small non-secret build manifest containing the expected Flue version,
  Pi version, Node floor, and lockfile digest;
- verify staged package versions and runner imports before `electron-builder`.

Update `package.json` Electron resources:

- remove beta workflow/skill `asarUnpack` entries that the staged runtime no
  longer needs;
- copy only the verified staged runtime;
- stage or compile a separate smoke-only child entry that registers the fixed
  faux provider. Production main-process composition must never resolve this
  entry for a user-initiated Insight run;
- keep source maps out unless required for safe local diagnostics and reviewed
  for path/content exposure.

Update runtime resolution to require the runner and build manifest, not
`flue.config.ts` plus `.pnpm`. It must choose:

- development: the built/staged local runner;
- packaged: `Contents/Resources/flue-runtime/<runner>`.

It must reject a missing or wrong-version runtime instead of falling back to
app.asar or an old CLI path.

**Verify**:

```bash
pnpm stage:flue-runtime
node -e '
  const p=require("./out/workflow-runtime/package.json");
  if (p.dependencies?.["@flue/runtime"] !== "2.0.3") process.exit(1)
'
test -f out/workflow-runtime/pnpm-lock.yaml
! rg -n '1\.0\.0-beta\.9|workflow:review-pr|workflow:generate-walkthrough|defineWorkflow|defineAgent' \
  out/workflow-runtime package.json scripts/stage-flue-runtime.mjs
```

Expected: all commands exit 0; no beta API/version remains in staged runtime.

### Step 10: Extend package smoke to execute the real packaged runtime

Before UI smoke, validate the packaged runtime itself with no real credentials:

- start packaged Electron in Node mode or invoke the packaged child using the
  packaged Electron executable with `ELECTRON_RUN_AS_NODE=1`;
- assert embedded Node meets `>=22.19.0`;
- assert build-manifest versions and lock digest;
- invoke the separate packaged smoke-only child entry directly from
  `scripts/package-smoke.mjs`. That entry always constructs one fixed
  `fauxProvider()` and calls `start({ agents, providers: [faux.provider] })`.
  The production child contains no faux-provider branch and must ignore
  `PATCHDESK_PACKAGE_SMOKE`; never use that ambient environment variable to
  choose a provider or runner. The fixture model ID, scripted turns, and
  invocation data are constants compiled into the smoke-only entry, not
  accepted from the renderer;
- run one faux-provider Walkthrough and one tool-using Analysis fixture;
- validate one strict result from each;
- verify Analysis call nine is denied;
- verify cancellation terminates the child;
- set temporary `HOME`, minimal `PATH`, no provider credentials, and read-only
  `Contents/Resources/flue-runtime`;
- launch the model smoke child with an explicit environment allowlist built
  from constants (`HOME`, minimal `PATH`, required Electron/Node flags, and
  locale only). Do not spread or merge `process.env`; a denylist is not
  sufficient. Add a test that seeds representative provider credential
  variables in the parent and proves none reaches the child;
- confirm the child writes no database/cache beneath app Resources;
- then run the existing packaged UI smoke.

Do not make package smoke call a live Pi account, GitHub, or network.

**Verify**:

```bash
pnpm package:mac
pnpm test:package-smoke
```

Expected: package and smoke exit 0, with explicit output confirming Flue 2.0.3,
compatible embedded Node, strict Analysis/Walkthrough fixtures, cancellation,
and the existing UI fixture.

### Step 11: Delete beta code and update current documentation

Delete after all callers move:

- `flue.config.ts`
- `src/flue-runtime-types.ts`
- `src/flue-routing-types.ts` if unused
- beta `src/workflows/*` wrapper files if their current logic has moved to
  correctly named agent/orchestration modules
- old CLI path resolution and walkthrough subproject staging
- `@flue/cli`, `@flue/react`, `@flue/sdk`, and `@flue/vite` dependencies when
  no current caller exists
- compatibility comments, aliases, tests, and fixtures for beta APIs

Update:

- `AGENTS.md`: replace "Executable Flue workflow entries belong in
  `src/workflows/`" and "Keep Flue beta.9 pinned" with the current Flue 2
  one-shot runtime rule and authority boundary.
- `README.md`: document Node `>=22.19.0`, pnpm 8.8.0, and package/runtime smoke.
- `CHANGELOG.md`: add one user-facing bullet in existing style.
- Current ADR wording only where it names an implementation that no longer
  exists. Keep the domain phrase "Analysis run"; do not replace product
  vocabulary merely because Flue removed its workflow primitive.

Run:

```bash
rg -n '1\.0\.0-beta\.9|beta\.9|defineWorkflow|defineAgent|harness\.session|workflow:review-pr|workflow:generate-walkthrough|@flue/cli/config|@flue/react|@flue/sdk|FlueCli|flue.config|src/workflows' \
  AGENTS.md README.md CHANGELOG.md package.json pnpm-lock.yaml scripts src tests docs
```

Expected: no matches except historical ADR/archive text that is explicitly
retained as history. Current source, tests, and docs have no beta runtime claim.

### Step 12: Run the complete gate

Run in repository order:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
pnpm stage:flue-runtime
pnpm package:mac
pnpm test:package-smoke
pnpm audit --prod --audit-level high
git diff --check
```

Expected:

- lint, typecheck, tests, build, Playwright, staging, packaging, and package
  smoke exit 0;
- audit output is reviewed. Do not claim all advisories are reachable; block
  only on high/critical issues proven reachable in the shipped runtime or
  packaging path;
- `git diff --check` has no output.

Then inspect:

```bash
git status -sb
git --no-pager diff --color=never --stat
git --no-pager diff --color=never
```

Confirm every migration hunk traces to this plan and all pre-existing React
Doctor and renderer edits remain intact.

## Test plan

### Existing tests to preserve or rewrite

- `tests/services/insight-run-coordinator.test.ts`: Patchdesk lifecycle,
  cancellation, superseded results, invalid output, and terminal persistence.
- `tests/services/model-review-runner.test.ts`: complete prepared artifacts,
  immutable snapshots, strict Analysis result, and four tools.
- `tests/services/review-inspector.test.ts`: containment, revision allowlist,
  byte bounds, and eight-call budget.
- `tests/services/review-inspector-tools.test.ts`: Flue 2 `data` input and
  `{ output }` result envelopes.
- `tests/workflows/generate-walkthrough.test.ts`: move/rename with production
  module; preserve prompt, bounds, aliases, and strict output.
- `tests/services/flue-cli-review-invoker.test.ts` and
  `tests/services/flue-cli-walkthrough-invoker.test.ts`: rename if production
  classes are renamed; assert stdin protocol rather than beta argv JSON.
- `tests/main-desktop-hardening.test.ts`: resolve verified runner/runtime
  manifest rather than CLI paths and workflow subprojects.

### Required new integration coverage

Create `runtime/flue/tests/flue-2-insight-runtime.test.ts` or equivalent and
prove:

1. actual Flue 2 `start/init/dispatch/read` with a faux provider;
2. exact one-value `AgentReply.data.patchdeskResult` contract;
3. malformed, missing, duplicate, and extra-field result rejection;
4. Analysis receives exactly four custom inspector tools plus the strict
   submission tool; Walkthrough receives only the strict submission tool.
   Flue's inert `task` is permitted, and `activate_skill` is permitted only for
   Analysis with the trusted Patchdesk review skill;
5. no sandbox, MCP server, declared subagent, GitHub writer, or shell/filesystem
   tool is mounted;
6. one inspector instance and aggregate eight-call budget survive rerenders,
   multiple model turns, and concurrent calls;
7. pre-start, mid-prompt, timeout, and forced-process cancellation;
8. `handle.abort()` is called; a read signal alone is not treated as abort;
9. child stdout is one bounded JSON value; stderr and invocation bodies do not
   cross the adapter or enter durable diagnostics;
10. in-memory Flue state disappears with the child and no beta store is read.
11. the production child has no faux-provider branch, and package smoke child
    environment is allowlisted so inherited provider credentials cannot reach
    it.

### Package acceptance coverage

Package smoke must execute both converted Pi Insight paths with a faux provider
from read-only packaged resources. Static file existence is not enough.

## Done criteria

All must hold:

- [ ] Plan 005 is complete and no attempt/incremental/completion/local-batch
      fields were ported into Flue 2.
- [ ] Root and dedicated runtime resolve `@flue/runtime@2.0.3` and a compatible
      exact `pi-ai` version; no Flue beta package remains.
- [ ] `@flue/cli`, `@flue/react`, `@flue/sdk`, and `@flue/vite` are absent unless
      a documented, tested current caller requires one.
- [ ] No `defineWorkflow`, `defineAgent`, workflow discovery, or
      `harness.session()` remains in current source.
- [ ] Pi Analysis and Walkthrough run through a Patchdesk-owned one-shot child
      using Flue 2 `start/init/dispatch/read`.
- [ ] Strict results travel through the Valibot-backed
      `submit_patchdesk_result` tool and exactly one `AgentReply.data` value;
      assistant prose is never parsed as authority.
- [ ] `InsightRunCoordinator` remains the only durable Insight lifecycle,
      revision, cancellation, validation, and retention owner.
- [ ] Analysis has exactly four Patchdesk inspector tools and no sandbox/write
      surface; Walkthrough has no model inspection tools.
- [ ] The aggregate eight-call inspector budget survives rerenders and
      concurrent calls.
- [ ] Cancellation requests Flue abort and retains owned-process termination as
      a hard backstop.
- [ ] The dedicated packaged runtime has an exact committed lock, installs with
      `--frozen-lockfile`, and never reuses a previous packaged cache.
- [ ] Package smoke executes real faux-provider Analysis and Walkthrough from
      read-only packaged resources with no credentials/network.
- [ ] Node `>=22.19.0` is documented and checked in development and package
      smoke.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, `pnpm build`,
      Playwright, staging, packaging, and package smoke all pass.
- [ ] `git diff --check` has no output.
- [ ] `plans/README.md` marks Plan 006 DONE.

## STOP conditions

Stop and report; do not improvise if:

1. Plan 005 has not removed attempt, incremental scope, completion, and local
   batch fields from the current Pi Analysis boundary.
2. Flue 2 cannot provide a strict result through the Valibot-backed submission
   tool and `AgentReply.data` without parsing assistant prose.
3. The one `ReviewInspector` aggregate budget resets across renders/turns or can
   exceed eight through concurrent tool calls.
4. Flue requires `useSandbox()`, generic filesystem/shell tools, MCP, a declared
   subagent, GitHub credentials, or GitHub writes for either Insight.
5. Parent cancellation can only cancel `read()` while model execution continues
   and `handle.abort()` plus owned-process termination cannot be proven.
6. A proposed design makes Flue persistence/submission state authoritative for
   Patchdesk Insight recovery, freshness, validation, or retained results.
7. The packaged Electron Node version is below 22.19.0 or an unsupported Node
   release for the selected Flue version.
8. Direct `pi-ai` and Flue cannot use one compatible package graph without
   breaking Patchdesk's provider/model catalog.
9. The packaged runtime cannot be reproduced from an exact committed lock, or
   staging requires copying an unverifiable prior app runtime.
10. Package smoke cannot execute strict faux-provider Analysis and Walkthrough
    without network, credentials, or writes beneath app Resources.
11. Package smoke requires merging the parent's ambient environment or cannot
    prove provider credentials are absent from the model child.
12. The migration requires upgrading root Vite to 8 or introducing a Flue HTTP
    server. That is a separate build architecture decision and must be planned
    explicitly.
13. An implementation would weaken immutable represented-review inspection,
    post-run patch mapping, strict schemas, or diagnostic redaction.

## Maintenance notes

- Flue latest is time-dependent. This plan targets the verified latest release
  `2.0.3`; re-run `npm view @flue/runtime version` before execution. If latest
  has advanced, review the intervening changelog and either update this plan or
  deliberately pin 2.0.3. Do not silently install a newer major/minor.
- Keep the dedicated runtime lock synchronized with the root direct Pi version.
  A review should reject split Flue/Pi runtime registries.
- Any future Flue instrumentation needs a separate content/redaction review.
- Any future sandbox or subagent use changes the Analysis capability boundary
  and requires an ADR, threat review, and new negative tests.
- A future move from one-shot children to an in-process long-lived Flue runtime
  changes cancellation, isolation, memory, credential, and crash-recovery
  behavior; do not treat it as a refactor.
- Reviewers should inspect the packaged runtime, not only root `node_modules`.
