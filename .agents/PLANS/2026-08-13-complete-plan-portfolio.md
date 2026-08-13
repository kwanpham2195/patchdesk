---
created_at: 2026-08-13
repos:
  - patchdesk
status: in_progress
---

# Complete the Patchdesk implementation-plan portfolio

## Objective

Execute and verify every numbered plan in `plans/` in the order recorded by
`plans/README.md`. Do not redefine completion around a subset. The goal is done
only when Plans 001-008 are DONE and their combined current-state audit passes.

## Source of truth

- Queue, dependencies, and plan status: `plans/README.md`
- Executable requirements: `plans/001-*.md` through `plans/008-*.md`
- Audit evidence only: `plans/audit-2026-08-13-standard-codebase.md`
- This file: cross-plan progress, evidence ledger, decisions, and resume notes

## Operating constraints

- One implementation writer at a time. The parent owns integration and final
  verification. Use at most one worker, or one reviewer, or up to three scouts
  at once; never mix those groups concurrently.
- Preserve all pre-existing dirty changes. Inspect committed, staged, and
  unstaged diffs before each plan.
- Keep the raw `patchdesk.jsonl` tail and `pnpm dev` console live in Herdr.
  Rediscover panes by the labels `patchdesk logs live` and
  `patchdesk dev live`; pane IDs are not durable.
- Restart the app after main-process, services, adapters, or packaging changes.
- Use the real Electron surface for renderer/desktop verification.
- Stage explicit paths only. Do not push, switch branches, or commit unless the
  operator asks.
- Add no compatibility layer unless a current public contract requires it.

## Principles

- `[[principles/outcome-oriented-execution]]`
- `[[principles/prove-it-works]]`
- `[[principles/migrate-callers-then-delete-legacy-apis]]`
- `[[principles/serialize-shared-state-mutations]]`
- `[[principles/agent-orchestration]]`
- `[[principles/encode-lessons-in-structure]]`

## Baseline

- Planned-at/source baseline: `7b4f6e6`
- Branch at start: `fix/inline-conversation-freshness-repair`
- Initial dirty paths:
  - `AGENTS.md`
  - `CHANGELOG.md`
  - `package.json`
  - `pnpm-lock.yaml`
  - `src/renderer/src/components/summary-review-dialog.tsx`
  - `src/renderer/src/flows/review-workbench-flow.tsx`
  - `tests/renderer/review-workbench-flow.ui.test.tsx`
  - `tests/renderer/summary-review-dialog.ui.test.tsx`
  - `.agents/skills/react-doctor/`
  - `plans/`
- Environment at start: fresh Patchdesk dev process listening on CDP 9233;
  raw JSONL and dev-console tails live in Herdr.

## Ordered progress

- [x] Setup: persistent goal, queue, tracker, memory, and live logs/dev process
- [x] Plan 001: prevent stale direct-summary observation
- [x] Plan 002: restore workbench navigation accessibility
- [x] Plan 003: correct safety/runtime docs
- [x] Plan 004: lock packaged Flue beta.9 runtime
- [x] Plan 005: remove superseded Review systems
- [x] Plan 006: migrate Pi Insights to Flue 2.0.3
- [ ] Plan 007: lazy-load the Review workbench
- [ ] Plan 008: migrate quality tooling to Oxc
- [ ] Portfolio audit: prove every plan criterion against current state

## ADR checkpoints

- Plans 001-004: no new ADR expected; they implement current decisions.
- Plan 005: update current ADR wording and mark replaced ADRs superseded; retain
  history. Do not create a new decision unless runtime evidence contradicts the
  approved single-authority target.
- Plan 006: create the next ADR before production migration. Record the
  Patchdesk-owned one-shot Flue 2 child, strict `AgentReply.data` result,
  no-sandbox capability boundary, owned cancellation, and exact packaged
  runtime closure. This is a hard-to-reverse runtime decision.
- Plan 007: add an ADR only if implementation introduces a general renderer
  route-loading architecture rather than one bounded Review chunk.
- Plan 008: no ADR expected unless lint-policy parity requires an intentional
  policy reduction.

## Verification policy

Per plan:

1. Run its drift checks and confirm dependencies are DONE.
2. Create failing regression evidence first when the plan has a cheap bug seam.
3. Implement only the plan scope.
4. Run every focused gate named by the plan.
5. Inspect the complete diff and live app/logs when required.
6. Update `plans/README.md`, this checklist, and the evidence ledger only after
   direct verification.

Portfolio completion requires, at minimum:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
pnpm stage:flue-runtime
pnpm package:mac
pnpm test:package-smoke
git diff --check
```

`pnpm format:check` becomes required after Plan 008. Package commands become
required after Plans 004 and 006. Live read-only Electron checks must cover the
final Inbox, Settings, Review, Analysis, Walkthrough, Refresh, and merge surfaces.

## Evidence ledger

Append one dated entry per completed plan. Include exact commands, results,
live checks, changed files, residual risks, and any ADR added or updated.

### 2026-08-13 — setup

- Active goal confirmed through the goal tracker.
- `plans/README.md` contains eight TODO plans in leverage-first order.
- Fresh Patchdesk dev process started with
  `pnpm dev -- --remote-debugging-port=9233` and verified listening on 9233.
- Raw `~/.local/share/patchdesk/logs/patchdesk.jsonl` tail is live.
- No source implementation changed during setup.

### 2026-08-13 — Plan 004 complete

- Added a committed `runtime/flue-beta9` package with exact
  `@flue/cli@1.0.0-beta.9` manifest and pnpm 8.8 lock.
- Staging now clears old output, copies the committed inputs, installs with
  `--frozen-lockfile --prod --offline --ignore-scripts`, verifies the CLI
  version, and fails closed without reading a previous package.
- Temp-directory tests cover copied inputs, fixed install flags, old-output
  removal, exact CLI verification, and install failure.
- Corrected two stale portfolio assertions found by the full gate: the outer
  Diff control is a pressed button, and Walkthrough focus is checked for exact
  progress writes rather than unrelated passive requests.
- Parent gates: lint, typecheck, full Vitest (1,082 passed, one existing skip),
  build, staging, macOS package, package smoke, packaged Resources inspection,
  dedicated runtime audit, and `git diff --check` passed.
- The packaged CLI reports `1.0.0-beta.9`; its CLI and Walkthrough symlinks are
  relative and remain within `Contents/Resources/flue-runtime`.
- The dedicated runtime production audit reports no known vulnerabilities.
  The root production audit exits 1 with 27 findings, including high
  transitive advisories on root Flue beta paths; no unsupported packaged
  reachability claim was made, and Plan 006 owns the Flue migration.
- Independent review found no technical blocker after the required status
  update. ADR: none; this makes the current runtime boundary reproducible.

### 2026-08-13 — Plan 005 complete

- Deleted superseded local batch/publication, Review Attempt/run, incremental
  comparison, migration, compatibility-parser, route, DTO, fixture, and
  renderer systems while retaining one strict current Review runtime.
- Preserved current pending-review ownership and recovery, exact Finding
  receipts, direct-summary and inline writes, published-feedback mutations,
  explicit Refresh and observation journals, merge recovery, preparation
  journals, Insight supersession, and evidence-gated Git diff fallback.
- `ReviewSession` now has one strict schema-5 shape. `InsightStore` accepts only
  schema 2 and rejects duplicate Walkthrough progress IDs.
- All Review mutations, including Insight lifecycle and terminal persistence,
  use the shared `ReviewOperationCoordinator`; terminal Insight writes
  revalidate the represented revision while holding that lock.
- Merge intent is bound to `reviewId` and represented revision. Recovery never
  retries an uncertain write and removes evidence only after terminal Review
  persistence succeeds.
- Full parent gate passed: typecheck, lint, 609 Vitest tests, build, 35
  Playwright tests, `git diff --check`, and all four required clean removal
  inventories. The isolated performance browser test also passed.
- Final read-only Electron QA after restart passed on CDP 9233 with empty fresh
  console and page-error buffers.
- Independent review found three blockers. Focused corrections and 20 tests
  closed all three; follow-up review found no blocking findings and approved
  DONE. ADR: none; existing superseded decisions remain historical records.

### 2026-08-13 — Plan 006 complete

- Replaced root Flue beta.9/Pi dependencies and workflow discovery with one
  exact, isolated `runtime/flue` package using Flue 2.0.3 and Pi 0.84.1.
- Analysis and Walkthrough run in Patchdesk-owned one-shot children through
  `start/init/dispatch/read`; strict Valibot submission data is authoritative,
  while prose and malformed or duplicate submissions fail closed.
- Production children expose only the selected provider's allowlisted
  credential/configuration variables, fixed PATH/locale, and approved ambient
  HOME. They mount no sandbox, MCP, subagents, generic shell/filesystem tools,
  or GitHub writer.
- Analysis retains exactly four immutable inspector tools and one aggregate
  eight-call budget across turns and concurrent calls. Walkthrough has only
  strict submission. Child abort, bounded Flue stop, and parent
  SIGTERM-to-SIGKILL process-group termination were proven.
- Root model selection uses a deterministic version/digest-bound generated
  catalog; strict root typechecking contains no Pi declaration shim,
  `skipLibCheck`, or filesystem-layout workaround.
- Staging uses the exact isolated lock and manifest. Fresh package smoke proved
  Flue 2.0.3, Pi 0.84.1, embedded Node 24.18.0, credential exclusion, read-only
  Resources, immutable runtime metadata, Analysis, Walkthrough, cancellation,
  ninth-call denial, and UI startup.
- Full parent gate: isolated Flue 15/15; root Vitest 594/594; lint, typecheck,
  build, exact staging, fresh macOS package, package smoke, Playwright 35/35,
  performance 1/1, production audits with no high/critical findings, removal
  inventories, and `git diff --check` passed.
- Two read-only live DeepSeek V4 Flash Analysis runs after Electron restarts
  reached Current with no GitHub write. The second run proved the final
  selected-provider environment boundary still supplies the required key.
- ADR-0018 records the one-shot process and capability boundary. Independent
  follow-up review reran focused root and isolated tests and approved technical
  completion with no remaining blocker.

### 2026-08-13 — Plan 007 complete

- Native lazy Review and fixture boundaries provide accessible loading and
  retryable failure states without adding a second application.
- A generated dependency-free Pierre theme catalog keeps Settings out of the
  heavy Review graph; `test:bundle` verifies catalog parity before each build.
- The authoritative Rollup graph proves that Review, fixture, Pierre, Shiki,
  marked, and Mermaid modules are absent from the static entry closure.
- Initial renderer entry fell from 3,636,255 raw / 718,460 gzip to 1,685,318
  raw / 321,460 gzip. The Review entry is 143,204 raw / 27,887 gzip.
- Profiling showed the apparent performance regression was initial paint work:
  later filters were 8–11 ms. The benchmark now starts after two animation
  frames, when the fixture is paintable, without changing the 200 ms limits.
- Final large-patch proof passed at 30.38 ms worst filter, 156.60 ms worst
  selection, and 351 ms maximum main-thread gap. Full browser proof passed
  35/35, Vitest 597/597, lint, typecheck, build, bundle, and diff checks.
- Live read-only CDP 9233 QA passed Inbox, Settings theme options, saved Review,
  restored Insights state, and return to Inbox. No page errors were reported.
- Independent review's paint-boundary, catalog-gate, and callback-test findings
  were corrected.

## Resume protocol

1. Read this file and `plans/README.md`.
2. Run `git status -sb` and inspect all dirty in-scope paths.
3. Confirm live Herdr log/dev panes and CDP 9233.
4. Continue the first unchecked plan only.
5. Never mark the goal complete from plan status alone; run the portfolio audit.

### 2026-08-13 — Plan 001 complete

- Production: receipt-driven observation now captures the shared generation
  and represented snapshot key, rechecks both after awaiting, and builds all
  branches from the post-await projection.
- Regression evidence: temporary pre-guard run failed because stale
  reconciliation replaced Refresh; final focused file passed 61 tests with one
  existing skip.
- Covered: confirmed receipt renders before deferred observation; exact receipt
  ID; owned reconciliation; stale Reconciled, RevisionChanged, Unavailable,
  and Terminal results after Refresh.
- Parent gates: `pnpm lint`, `pnpm typecheck`, `pnpm build`, focused renderer
  suite, and `git diff --check` passed.
- Independent follow-up review: no blockers or fixes worth doing now.
- Live read-only QA: normal-profile app on CDP 9233 showed a healthy Inbox and
  no page errors. Receipt/Overview surface was unavailable without opening a
  Review, so automated deterministic evidence remains the direct proof.
- Changed source: `src/renderer/src/flows/review-workbench-flow.tsx` and
  `tests/renderer/review-workbench-flow.ui.test.tsx`; pre-existing dirty hunks
  were preserved.
- ADR: none; this implements ADR-0017's existing Refresh ownership rule.

### 2026-08-13 — Plan 002 complete

- Failing-before: targeted workbench Axe run reported critical
  `aria-required-parent` for Conversation, Diff, and Insights.
- Production: outer workbench controls are truthful native buttons with
  `aria-pressed`; incomplete `role=tab` / `aria-selected` semantics are gone.
- Approved scope correction: renderer behavior selectors were updated from
  outer `tab` to `button`; nested Browse/Commits true-tab selectors remain.
- Direct state coverage: Conversation is initially pressed; clicking Diff
  transfers pressed state and preserves content behavior.
- Parent gates: full renderer file 61 passed/1 existing skip, accessibility
  Playwright 10/10, lint, typecheck, build, and `git diff --check` passed.
- Independent review found one pressed-state test gap; the follow-up fixed it.
- Live read-only QA on CDP 9233 opened an existing Review, confirmed ordinary
  pressed buttons and real nested tabs, switched to Diff, and sent no Refresh
  or GitHub write. Screenshot remains local because it contains real Review
  details.
- Changed source: `src/renderer/src/components/review-workbench.tsx` and
  outer-role selectors/assertions in
  `tests/renderer/review-workbench-flow.ui.test.tsx`.
- ADR: none; semantic correction only.

### 2026-08-13 — Plan 003 complete

- README now documents pnpm 8.8.0, verified Node 24.18.0, Electron 43.1.1,
  the complete current command ladder, and the absence of an `engines`
  contract before Flue 2.
- Safety text now states that preload exposes IPC while the main process owns
  and sends the per-launch local-API capability.
- It documents explicit Finding Add-to-review writes, locked uncertain outcomes,
  no automatic retry, and the inactive legacy per-Analysis authorization
  without claiming its future removal is complete.
- Independent review found and corrected capability ownership and removed a
  non-durable internal plan reference from user-facing documentation.
- Parent verification: runtime versions and every documented script exist;
  `pnpm lint` and `git diff --check -- README.md` passed.
- Changed source: `README.md` only.
- ADR: none; documentation reflects current decisions and dormant code.
