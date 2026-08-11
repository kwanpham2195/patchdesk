---
created_at: 2026-08-11
repos:
  - patchdesk
status: todo
research: .agents/research/2026-08-11-plannotator-codex-app-server.md
adr: docs/adr/0016-use-the-local-codex-cli-account.md
---

# Add the Codex CLI account Insight provider

> **Executor instructions:** Read this plan and ADR-0016 fully before editing. This is an implementation plan, not authorization to inspect credentials, run `codex`, start login, or make a GitHub write. Keep the renderer sandboxed. Codex may run only in the trusted main process, only after an explicit maintainer action, and only as `codex app-server` discovered from the inherited `PATH`.
>
> **Drift check:** `git diff --stat 9d93f47..HEAD -- AGENTS.md CONTEXT.md docs/adr/0016-use-the-local-codex-cli-account.md src/domain src/adapters src/services src/main src/renderer/src tests`
>
> If the listed seams or ADR conflict with live code, stop and reconcile the plan before implementation. Do not retain a compatibility alias when callers have moved; the one explicit persisted-data upgrade is documented below.

## Status

- Priority: P1
- Effort: L
- Risk: HIGH — adds a subscription-backed child process and a new model-provider boundary.
- Depends on: ADR-0016, committed as `9d93f47`.
- Planned at: `9d93f47` on `fix/inline-conversation-freshness-repair`.

## Purpose

Patchdesk will let a maintainer choose **Pi** or **Codex CLI account** independently when starting Analysis or a Walkthrough. Codex reuses the local CLI login without Patchdesk reading, copying, storing, or showing credentials. The provider must leave the existing Insight lifecycle unchanged: one active run per Insight type, immutable revision inputs, strict result validation, current-result mapping, and no GitHub authority.

## Fixed decisions

- The provider picker appears in every Insight run dialog and is prefilled from separate, non-secret, profile-scoped Analysis and Walkthrough preferences.
- The confirmation view repeats provider, model, and reasoning effort and says the selected provider receives the prepared pull-request artifacts. Later picker changes affect only future runs.
- Settings may display passive, redacted Codex setup status. It never starts Codex or attempts login.
- Codex discovery is `codex` on the main process's inherited `PATH` only. Do not add Homebrew/macOS fallback directories, an executable-path preference, a shell command, or a renderer-provided path.
- A passive provider catalog must not launch Codex. A maintainer explicitly selecting/loading Codex in the run dialog may start a throwaway app server for `model/list`; every actual run revalidates its exact model/reasoning selection using a fresh process.
- Do not hard-code a fallback Codex model. Render only a successful live `model/list` result and reject an unavailable selected model or reasoning effort rather than substituting one.
- Every Codex run gets a fresh `codex app-server` process and thread. Do not persist or resume a Codex thread ID.
- Codex receives only a new immutable prepared-artifact directory, never a checkout or worktree. It runs with a read-only sandbox; command, file-change, and permission-escalation requests are automatically denied in the main process and never become renderer actions.
- Codex must return the exact existing Analysis or Walkthrough result shape. There is no raw-prose fallback and no Codex-specific Finding, publication, or lifecycle path.
- Store only immutable provider/model/reasoning provenance with the run. Do not store account identity, executable path, thread ID, prompts, raw JSON-RPC, stdout, stderr, or credentials. Renderer failures remain bounded categories; local diagnostics are bounded and redacted.
- Analysis and Walkthrough may run concurrently, including two Codex runs. A provider-side concurrency or rate-limit response is a retryable failure, not a global queue.

## Current state

- `src/adapters/pi/pi-runtime-model-catalog.ts` provides a Pi-only, passive static model catalog. `canonicalModelId` accepts only Pi provider IDs.
- `src/services/insight-run-coordinator.ts` owns Insight revision checks, durable records, cancellation, result validation, and diagnostics, but accepts only `{ model, reasoning }` and hard-wires Pi catalog validation.
- `src/main/electron-main.ts:createInsightCoordinator` always adapts Analysis and Walkthrough to `FlueCliReviewInvoker` and `FlueCliWalkthroughInvoker`.
- `src/main/local-api.ts` exposes the passive `GET /v1/reviews/models` catalog and Insight run bodies without provider selection. `src/main/desktop-bridge.ts` allowlists those routes.
- `src/renderer/src/flows/review-workbench-flow.tsx` owns one transient model/reasoning state for both Insight types. `InsightRunDialog` has no provider selector, confirmation summary, or persisted Insight preference.
- `PatchdeskPaths.preparedDirectory()` is a session-shared preparation directory. The current Insight invocation still carries a patch path and a worktree path; neither may cross the Codex provider boundary.
- `src/main/executable-discovery.ts` currently appends macOS directories after `PATH`. Codex must use a strict inherited-PATH resolver instead of this fallback behavior.
- `InsightRecord` and `InsightStore` schema version 1 retain model/reasoning only for active and failed runs; retained results have no run configuration provenance.

## Scope

In scope:

- Provider-selection domain types, validated persisted Insight provenance, and the explicit v1-to-v2 Insight-record data upgrade.
- Passive provider status, activation-only Codex model discovery, and strict provider-aware run validation.
- Per-run immutable Codex artifact copies and a main-process JSON-RPC app-server adapter.
- Main-process composition, loopback API/bridge transport, renderer contracts, preferences, Insight dialog, and passive Settings status.
- Deterministic fake-app-server, storage/coordinator, API, renderer, and browser-facing test coverage.
- `.agents/PLANS/README.md` and this plan.

Out of scope:

- Changing the normal Review execution provider, `GET /v1/reviews/models`, Flue beta.9, or Pi provider behavior.
- OAuth, embedded login, API-key entry, account discovery, `CODEX_HOME` inspection, executable-path configuration, terminal/shell invocation, or model probing at app startup.
- Codex thread resume, a shared Codex process, tool approval cards, streaming raw provider events, file access beyond prepared artifacts, GitHub writes, or a provider-driven publication action.
- A macOS package or live-account test unless the maintainer separately asks for it.

## Implementation steps

### 1. Define a provider-aware Insight selection and durable provenance

Add a small domain module such as `src/domain/insight-provider.ts` with the two allowed providers: `pi` and `codex-cli-account`. Define one provider/model/reasoning selection type and a safe, bounded reasoning identifier type; Pi continues to advertise its existing `low`, `medium`, and `high` values, while Codex values come only from live `model/list` entries.

Update `src/domain/insight-record.ts` so active runs, failures, and retained Insight results carry immutable `{ provider, model, reasoning }` provenance. Do not add account, path, thread, prompt, or output fields. Thread the selection through `beginInsightRun`, `completeInsightRun`, and `failInsightRun` so completion copies the configuration captured at start rather than reading current UI preference.

Upgrade `src/adapters/storage/insight-store.ts` to schema version 2. Parse schema-version-1 records explicitly as historical Pi provenance and normalize them in memory; write only schema version 2 after a subsequent mutation. Reject invalid provider/model/reasoning combinations and preserve the existing strict ID/timestamp checks. This is an explicit local-data upgrade, not a compatibility alias.

**Verify:** focused domain and store tests cover v2 round trips, v1 normalization to Pi, retained/failed provenance, invalid values, and no account/path/thread field accepted.

### 2. Split passive provider status from activation-only model catalogs

Keep `LocalPiRuntimeModelCatalog` as the Pi implementation; do not add Codex IDs to `PI_AI_CATALOG` or `canonicalModelId`. Introduce an Insight-provider catalog service/interface that can:

- return passive, renderer-safe statuses for Pi and Codex;
- return Pi models without starting an external process;
- on an explicit Codex activation request, resolve only `codex` from the inherited `process.env.PATH`, start a short-lived app server, and return its paginated `model/list` result; and
- validate the exact provider/model/reasoning selection again immediately before a Codex Insight begins.

Give the Codex resolver a strict-PATH mode or dedicated resolver. It must not use `macDesktopPaths`, accept an absolute path, consult shell configuration, or return a path to the renderer. Passive status may state only that Codex is available or unavailable and provide bounded setup guidance. It must not authenticate, list models, read a credential location, or execute Codex.

Map live Codex models to bounded `{ id, label, reasoning[], defaultReasoning? }` entries only after complete pagination and validation. A malformed, empty, timed-out, unavailable, or unauthenticated list is an activation failure with a structured category; it must never fall back to static models.

Expose a new passive Insight-provider endpoint and a separate authenticated `POST` activation endpoint through `src/main/local-api.ts` and `src/main/desktop-bridge.ts`. Leave `GET /v1/reviews/models` intact for ordinary Review settings and Pi-only flows.

**Verify:** catalog tests prove no process call during passive status, strict inherited-PATH-only resolution, no path leakage, successful multi-page list, empty/malformed list rejection, authentication/runtime/timeout classification, and no fallback. Local API and desktop-bridge tests prove capability/origin protection and reject arbitrary provider/path/model input.

### 3. Create immutable Codex run artifacts and prompts

Add a service such as `src/services/codex-prepared-artifacts.ts` and corresponding `PatchdeskPaths` methods. After the coordinator has allocated a unique Insight run ID, copy only the current session's already prepared `context.json` and `review-input.md` plus the represented patch into a new run-owned directory beneath the session's prepared artifact root. Create it atomically, record content hashes in a minimal manifest, and make the app-owned copies read-only. Do not copy `debug.json`, the worktree, repository rules, credentials, or arbitrary files.

Have the Codex prompt builder read only those copied files. Its fixed system instruction must state that Patchdesk owns mapping/publication authority, the run is read-only, and the response must be one JSON value satisfying the existing Analysis or Walkthrough contract. It may embed bounded prepared-artifact contents in the turn input, but it must never give Codex a worktree path, checkout path, shell command, or arbitrary path supplied by the renderer.

Pass the new artifact directory as the app-server working directory. The app-server adapter gets no `worktreePath`; make this unrepresentable in its input type.

**Verify:** artifact tests prove the copied files and manifest match the represented session, paths remain under the owned directory, source/worktree paths never enter adapter input, a second run receives a distinct directory, and invalid/missing source artifacts fail before Codex starts.

### 4. Implement a bounded Codex app-server adapter

Add a main-process-only adapter (for example `src/adapters/codex/codex-app-server-client.ts`) and a provider invoker under `src/services/`. Use direct `spawn(resolvedCodexPath, ["app-server"], { shell: false, cwd: artifactDirectory, stdio: ["pipe", "pipe", "pipe"] })`; do not route the bidirectional protocol through `CommandRunner`.

Implement newline-delimited JSON-RPC with a streaming UTF-8 decoder, bounded input/output/stderr buffers, per-request timeouts, and one cleanup path. The sequence is: `initialize`, `initialized`, live `model/list` validation, `thread/start` with the chosen model and read-only sandbox, then one `turn/start`. Accumulate only the final assistant text needed to parse the existing strict result; any malformed, incomplete, or non-JSON terminal output becomes `invalid_result`.

Handle every inbound server request in the trusted adapter. Reply decline/cancel for command and file-change approvals, reply with an empty permission grant for escalation, and reject unknown requests. Never forward a request, raw provider event, process handle, stdout/stderr, path, or account detail to the renderer. On cancellation, request `turn/interrupt` when the active turn is known, then terminate only that child process. Always terminate the child in `finally`; never cache its process or thread ID.

Classify unavailable CLI, login-required, rate limit/concurrency, timeout, cancelled, invalid result, and execution failure into the existing safe `InsightFailureCategory` values. Record at most one redacted, bounded diagnostic through `ReviewDiagnosticService`; use its existing redaction rules and do not persist a raw RPC line or stderr.

**Verify:** add a deterministic fake `codex app-server` fixture and integration tests covering initialize/model pagination/thread/turn, no model fallback, fresh child and thread per invocation, concurrent Analysis/Walkthrough children, cancellation/interrupt/cleanup, timeout, malformed JSON-RPC, strict JSON result parsing, all approval-denial replies, and stderr/path/token/account redaction.

### 5. Make coordinator dispatch and validation provider-aware

Refactor `InsightRunCoordinator` to accept the provider catalog and a provider-aware invoker factory rather than a Pi-only catalog plus hard-coded type invokers. Add provider to the API input and to `InsightInvocationInput`; validate the provider/model/reasoning pair before beginning the durable record and revalidate Codex through live `model/list` at run start. A failed validation returns a structured unavailable failure; it must not begin an unrelated Pi run or substitute a model.

Keep all existing coordinator authority in place: one active run per Insight type, revision hashing, cancellation, strict `parseModelReviewResult`/Walkthrough normalization, Finding mapping, terminal persistence, publication authorization revocation, and recovery. For Codex, construct run-owned artifacts before dispatch and select the Codex invoker; for Pi, preserve the existing Flue invokers and their input surface. `createInsightCoordinator` in `src/main/electron-main.ts` remains the only production composition point for the Codex process adapter.

**Verify:** expand coordinator tests for Pi preservation, Codex model/reasoning rejection without fallback, frozen provenance, provider dispatch, artifact-only input, strict result parity, revision supersession, cancellation, recovery, and simultaneous Codex Analysis plus Walkthrough.

### 6. Transport provider choice safely through the loopback boundary

Extend the Insight-run body schema, `InsightCoordinatorInput`, local API result mapping, renderer contracts, and the desktop request allowlist with a bounded provider field. Add the passive provider-status and explicit Codex-activation routes from Step 2. Keep all route parsing strict; the renderer sends only provider/model/reasoning/profile/review/type, never executable paths, artifact paths, a thread ID, or a permission decision.

Expose only the provider label/id, bounded model/effort entries, passive availability/guidance, and structured failure categories. Do not add provider diagnostics to `WorkbenchResponse` or the run-poll response. Persisted provider/model/reasoning is provenance, not a new raw diagnostics surface.

**Verify:** `tests/local-api-auth.test.ts`, `tests/desktop-bridge.test.ts`, and `tests/renderer/renderer-contracts.test.ts` cover authentication, malformed/rejected fields, redaction, activation-only behavior, and absence of paths/threads/raw errors.

### 7. Build the per-Insight picker, confirmation, preference, and status UI

Create a renderer-only `insight-run-preferences` module modeled on `review-execution-preferences.ts`. Store separate profile-scoped non-secret preferences for `analysis` and `walkthrough`: provider, model, and reasoning. Validate and ignore corrupt entries. A Pi or Codex model from one Insight must never overwrite the other Insight's preference.

Refactor `InsightsSlot` in `review-workbench-flow.tsx` to load the passive provider catalog without activating Codex. Pass a provider selection and provider-specific model/effort options to `InsightRunDialog`. If Codex is selected, require a deliberate model-load action that calls the activation endpoint; do not activate simply because a saved preference prefilled the dialog. Preserve the selected value for a retryable setup failure and show only bounded guidance to run `codex login` externally or expose `codex` on the app launch `PATH`.

The dialog's final confirmation must visibly repeat **Pi** or **Codex CLI account**, model, and reasoning effort and say that prepared pull-request artifacts will be sent to that provider. Only **Start run** posts the Insight run request. On success, immediately save that Insight type's preference. Settings adds a read-only Codex provider-status row sourced from the passive endpoint; it has no load, login, executable-path, or model-discovery control.

**Verify:** renderer tests cover Pi/Codex selection, no activation during mount/settings/passive refresh, explicit Codex activation, model/effort filtering, final confirmation copy, per-type preference isolation, structured setup/retry guidance, disabled states, and exact provider/model/reasoning run bodies. Keep tests that ensure no raw provider diagnostics render.

### 8. Run the full proof sequence and perform only authorized live checks

Run focused tests from each prior step first. Then run the desktop gate in this order:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
git diff --check
```

Restart the Electron main process before any live check. Use `patchdesk-electron-tester` only for read-only UI verification. Do not activate Codex, invoke a model, or perform a live-account test unless the maintainer explicitly initiates that test. If separately authorized, the manual check must use an externally logged-in CLI, confirm no path/account/credential is displayed, start one disposable read-only Insight, verify an approval request is denied, and make no GitHub write.

## Done criteria

- [ ] Pi behavior and `GET /v1/reviews/models` remain unchanged.
- [ ] Passive renderer/Settings loads never launch Codex or inspect credentials.
- [ ] Codex uses inherited-PATH-only `codex app-server`; no configured/custom path or macOS fallback is accepted.
- [ ] Each Codex run uses a fresh process/thread and an immutable run-owned prepared-artifact directory, never a checkout/worktree.
- [ ] Command, file-change, permission-escalation, and unknown inbound requests are automatically denied in the main process.
- [ ] Codex model and reasoning options originate solely from a successful live `model/list`; start revalidates them and never substitutes.
- [ ] Analysis and Walkthrough retain their existing strict result contracts and may run concurrently.
- [ ] Stored records retain only frozen provider/model/reasoning provenance; renderer/API/logs expose no path, account, credential, thread, prompt, raw JSON-RPC, or raw stderr.
- [ ] Separate Analysis/Walkthrough preferences and final confirmation work for both providers.
- [ ] Fake-app-server coverage passes, then lint, typecheck, unit suite, build, browser suite, and `git diff --check` pass (or unrelated browser failures are documented with exact names and baseline evidence).

## Stop conditions

Stop and ask before proceeding if:

- A current supported Codex app-server protocol cannot provide the required initialize/model/thread/turn/interrupt behavior without expanding the safety contract.
- Codex requires checkout access, an approved tool/file request, an embedded login, a custom executable path, or an unsupported reasoning fallback to generate the strict result.
- The packaged app's inherited `PATH` cannot find Codex. Show setup guidance; do not add hard-coded directories or configuration as a workaround.
- A requested result format cannot pass the existing Analysis or Walkthrough validators without weakening them or creating a Codex-specific path.
- New work would expose credentials, account identity, paths, thread IDs, provider output, or diagnostics to the renderer or durable run record.
- A test indicates that concurrent Codex Insight runs share a process/thread, that a cancellation leaves a child alive, or that an approval request can reach the renderer.
