---
created_at: 2026-08-14
repos:
  - patchdesk
status: superseded
---

# Execute the React Doctor remediation program with one writer at a time

> **Closed 2026-08-14:** Superseded by `.agents/PLANS/2026-08-14-complete-react-doctor-remediation.md`. Plans 009–012 remain completed evidence. The delta plan owns the remaining confirmed fixes, static-reachability decision, package evidence, and final reconciliation.

This ExecPlan is a living implementation spec. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds. The parent agent owns this plan, all delegation, final acceptance, and live Electron verification.

## Purpose / Big Picture

Patchdesk will have a trusted React Doctor signal rather than a score dominated by generated output and a separate Flue runtime. It will first prove current asynchronous Review behavior with direct tests, then remove confirmed render-time ref mutations and two semantic rendering defects without weakening Review authority or GitHub-write controls. It will then address verified dependency advisories and record an evidence-backed disposition for remaining scanner observations.

A user can observe success by running the repository quality checks, the complete calibrated React Doctor scan, and the existing desktop flow. The scan reports only relevant root-source findings; renderer correctness findings are either fixed or explicitly recorded with evidence. Review refresh, diff loading, Insight polling, log polling, keyboard Mermaid interaction, package smoke, and read-only desktop Review use remain working.

## Progress

- [x] 2026-08-14: Read Patchdesk and workspace guidance, current React Doctor plans, and the ExecPlan format rules.
- [x] 2026-08-14: Prepared `patchdesk logs live` and `patchdesk dev live`; the dev app owns CDP port 9233.
- [x] 2026-08-14: Delegated read-only program, renderer-seam, toolchain-seam, and upstream-advisory reconnaissance. No implementation worker has started.
- [x] 2026-08-14: Created this draft ExecPlan. Await user review before any worker delegation.
- [x] 2026-08-14: Milestone 1: Calibrate the root React Doctor signal (Plan 009).
- [x] 2026-08-14: Milestone 2: Add lifecycle and interaction characterization tests (Plan 010).
- [x] 2026-08-14: Milestone 3: Bind scheduled React work to committed values (Plan 011).
- [x] 2026-08-14: Milestone 4: Stabilize Conversation identity and Mermaid control semantics (Plan 012).
- [ ] Milestone 5: Patch verified runtime and build dependency advisories (Plan 013) — TODO: advisory record and package proof are incomplete; production audit is clean but 11 development high advisories remain.
- [ ] Milestone 6: Measure and disposition remaining React Doctor debt (Plan 014) — TODO: false-positive and follow-up references need repair.
- [ ] Complete a portfolio acceptance audit and record the final outcome.
- Observation: The final root production audit is clean (`0` high, `0` critical, `0` moderate, `0` low), while the full audit reports 11 high and 9 moderate development/tool advisories. Direct runtime updates are present in the dirty tree, but Plan 013 lacks a durable per-advisory path and verification record.
  Evidence: `/tmp/patchdesk-audit-prod-final.json`, `/tmp/patchdesk-audit-full-final.json`, and the `pnpm why` paths captured during blocker repair.

- Observation: Reviewer blockers were repaired without source or authority changes. Plan 013 now has `plans/audit-2026-08-14-react-toolchain-advisories.md` with all current high/moderate full-audit IDs classified by path, owner, target, and blocker. Plan 014 now has one-to-one scan-ID reconciliation, the desktop-bridge false positive corrected, and concrete follow-up references.
  Evidence: final scan `/tmp/patchdesk-react-doctor-final-repair.json`; a comparison script found 207 scan IDs and 207 manifest IDs with zero missing or extra IDs.

- Observation: `pnpm package:mac` reached packaging but failed only while downloading the Electron runtime with `ETIMEDOUT 20.205.243.166:443`; `pnpm test:package-smoke` passed against the available packaged artifact. Plans 013 and 014 remain TODO because Plan 013's complete package gate is blocked by network access and Plan 014 depends on Plan 013.
  Evidence: package command output from the repair run; no Flue package or runtime lock changed.

- Observation: The Plan 014 disposition manifest now rejects `src/main/desktop-bridge.ts:221` with evidence and links all former follow-up placeholders to named references.
  Evidence: reviewer report `5083ff8b_reviewer_0_output.md`, `src/main/desktop-bridge.ts`, `src/renderer/src/api-client.ts`, and the repaired manifest.

- Decision: Do not mark Plans 013 or 014 done until their records and required gates are complete.
  Rationale: Status rows must reflect complete criteria, not partial implementation or passing subsets.
  Date/Author: 2026-08-14 / repair worker.

## Surprises & Discoveries

- Observation: The installed root scanner is React Doctor `0.9.11`, but `package.json` runs `npx react-doctor@latest` and there is no root `doctor.config.*` file.
  Evidence: `pnpm exec react-doctor --version` returned `0.9.11`; `package.json` and the root file listing were inspected during preparation.

- Observation: The root production audit currently has no high or critical findings, but it has eight moderate and two low findings. Audit commands can exit nonzero even when the high/critical threshold is zero.
  Evidence: delegated toolchain reconnaissance ran `pnpm audit --prod --audit-level high --json` against the current lock.

- Observation: Current immutable IDs exist for all Conversation timeline variants, and current renderer test seams support deferred desktop-bridge responses without production-only test exports.
  Evidence: delegated renderer-seam reconnaissance inspected `src/domain/github-context.ts`, `conversation.tsx`, the lifecycle hooks, and renderer tests.

- Observation: Mermaid `11.16.0` is a confirmed vendor-affected version with `11.16.1` as the known patched release; the current resolved Hono `4.12.30` and node server `2.0.10` are above the known advisory floors researched so far.
- Observation: `pnpm doctor -- --score` does not pass `--score` to this pnpm 8 script. `pnpm run doctor --score` and `pnpm run doctor --scope changed --base <ref>` do pass arguments and use the local React Doctor binary.
- Observation: A deferred scheduled `/v1/reviews/detect-updates` response still invokes the public `onWorkbenchPatch` callback after `ReviewWorkbenchFlow` unmounts. The new deterministic test fails at `tests/renderer/review-workbench-flow.ui.test.tsx:652` with one unexpected patch callback.
  Evidence: parent reran the focused test; an independent reviewer confirmed the test uses the existing bridge, deferred response, timers, and callback seam without testing internals. Cleanup currently removes timers/listeners but does not invalidate in-flight detection.

- Observation: `pnpm doctor -- --score` does not pass `--score` to this pnpm 8 script. `pnpm run doctor --score` and `pnpm run doctor --scope changed --base <ref>` do pass arguments and use the local React Doctor binary.
  Evidence: direct command verification after Plan 009 configuration printed scores `42` and `46`; the double-dash shortcut exited zero without score output.

- Observation: Mermaid `11.16.0` is a confirmed vendor-affected version with `11.16.1` as the known patched release; the current resolved Hono `4.12.30` and node server `2.0.10` are above the known advisory floors researched so far.
  Evidence: delegated upstream-advisory research captured official vendor advisories and release records. A current pnpm graph and audit remain the implementation authority.

## Decision Log

- Decision: Execute the six existing React Doctor plans strictly in numeric order: 009, 010, 011, 012, 013, then 014.
  Rationale: Plan 013 could technically follow Plan 009 independently, but strict serial order avoids concurrent edits to `plans/README.md`, renderer tests, and shared package state. It also matches the current queue’s default order.
  Date/Author: 2026-08-14 / parent agent.

- Decision: Use at most one implementation worker in the shared checkout and at most one read-only reviewer after each milestone.
  Rationale: Patchdesk’s plan portfolio requires one writer for shared state. The checkout is already dirty and must not use isolated worktrees. One independent reviewer gives a fresh check without creating conflicting edits or unlimited review churn.
  Date/Author: 2026-08-14 / user and parent agent.

- Decision: Delegate all future discovery and external research to `scout` or `researcher` subagents. The parent will synthesize evidence, decide scope, review diffs, and run required live verification.
  Rationale: This preserves clear authority while using read-only lanes for bounded evidence gathering.
  Date/Author: 2026-08-14 / user and parent agent.

- Decision: Do not create branches, commit, push, publish, write GitHub data, or use a worktree as part of this program unless the user separately authorizes that action.
- Decision: Keep Plan 009 at `TODO` until the required whole-repository format check passes; its changed scanner config and package script are not enough to meet the plan's done criteria.
- Decision: Do not weaken the Plan 010 unmount assertion or modify production code within this test-only milestone.
- Decision: User authorized the smallest production change in `src/renderer/src/flows/review-workbench-flow.tsx` to invalidate in-flight detector responses on unmount, while retaining the new Plan 010 regression test.
- Decision: User authorized the Plan 012 Mermaid rendered-success control separation early, with its direct renderer and browser accessibility tests. Conversation identity and all other Plan 012 work remain deferred.
  Rationale: A correct Plan 010 characterization test necessarily fails against the existing nested interactive controls; the narrow planned semantic correction removes that circular dependency.
  Date/Author: 2026-08-14 / user and parent agent.

- Decision: Address the Plan 010 reviewer’s commit-loader, hydration, and Insight test gaps within the existing test scope before marking Plan 010 done.
- Decision: Keep Plan 010 at `TODO` until its Mermaid controls have a browser-level interaction and Axe test on the actual built renderer.
  Rationale: The early renderer test reaches the successful Mermaid branch, but the existing browser fixtures do not render Mermaid. A fixture-only route may be added solely to make the required browser proof observable.
  Date/Author: 2026-08-14 / parent agent.

- Decision: Address the Plan 010 reviewer’s commit-loader, hydration, and Insight test gaps within the existing test scope before marking Plan 010 done.
  Rationale: The reviewer found missing observable contracts, not a need for new production seams.
  Date/Author: 2026-08-14 / parent agent.

- Decision: User authorized the smallest production change in `src/renderer/src/flows/review-workbench-flow.tsx` to invalidate in-flight detector responses on unmount, while retaining the new Plan 010 regression test.
  Rationale: The regression test proves a real stale callback after teardown. The change must preserve detector generation, explicit Refresh, callback freshness, and GitHub-write authority.
  Date/Author: 2026-08-14 / user and parent agent.

- Decision: Do not weaken the Plan 010 unmount assertion or modify production code within this test-only milestone.
  Rationale: The test proves a real lifecycle defect, but Plan 010 expressly forbids production changes. A follow-up implementation scope needs user approval before the plan can complete.
  Date/Author: 2026-08-14 / parent agent.

- Decision: Keep Plan 009 at `TODO` until the required whole-repository format check passes; its changed scanner config and package script are not enough to meet the plan's done criteria.
  Rationale: `pnpm format:check` fails solely on the pre-existing, out-of-scope `brain/index.md`. Reformatting it would modify another agent's dirty work without authorization.
  Date/Author: 2026-08-14 / parent agent.

- Decision: Do not create branches, commit, push, publish, write GitHub data, or use a worktree as part of this program unless the user separately authorizes that action.
  Rationale: The current checkout contains pre-existing work and the task is plan execution, not branch or release work.
  Date/Author: 2026-08-14 / parent agent.

## Outcomes & Retrospective

The program has not started implementation. Preparation established a live application, local scanner version, a serial execution rule, and four evidence packages. The main remaining risk is not scanner count; it is preserving stale-result, generation, cancellation, and write-authority rules while changing renderer code. Completion must therefore be determined by direct observable proof, not a score target.
The program has not started implementation. Preparation established a live application, local scanner version, a serial execution rule, and four evidence packages. The main remaining risk is not scanner count; it is preserving stale-result, generation, cancellation, and write-authority rules while changing renderer code. Completion must therefore be determined by direct observable proof, not a score target.

2026-08-14 — Milestone 1 completed. Added `doctor.config.json`, changed `package.json` to use local React Doctor 0.9.11, and corrected the plan command spelling to `pnpm run doctor`. The reviewer found the exclusions and single script override correctly scoped, with all targeted renderer diagnostics retained. Both baseline and final scans were schema 3, complete, and had no skipped checks; final evidence is `/var/folders/1g/fxyn7wbx7hz0t874dsn560sw0000gn/T/react-doctor.vyYnK3/after-parent.json` (12 errors, 205 warnings). `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `git diff --check` passed after user-authorized formatting of the existing `brain/index.md` change. Residual risk: the remaining root scanner findings require Plans 010–014; none were suppressed globally.
2026-08-14 — Milestone 2 completed. Added deterministic bridge/DOM coverage for detector generations, unmount invalidation, hydration, progressive streams, Insight ownership, log polling, loader freshness, and Mermaid keyboard semantics. User authorized two minimal production exceptions: detector-generation invalidation on unmount and Mermaid’s sibling controls; the latter also has a fixture-only built-renderer Playwright/Axe proof. The independent review identified and the follow-up implementation closed four initial coverage gaps. Focused tests passed, and final `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, full Vitest (108 files, 624 tests), build, full Playwright (36 tests), and `git diff --check` passed. Residual risk: Plan 012 still needs Conversation identity and scanner disposition; Plan 011 owns the remaining render-time-ref refactor.
2026-08-14 — Milestone 3 completed. Added `useLatestCommitted` and migrated only input-mirroring refs; generation, tokens, in-flight guards, cancellation, and timer refs remain imperative. Review found no authority regression, and the full scanner has zero targeted render-time-ref diagnostics. Read-only CDP QA reused the normal development profile at port 9233: an existing Review opened, update detection returned 200, tabs changed and returned without a duplicate detector request, no page/console errors appeared, and no GitHub write was triggered. Existing source-unavailable diff-file 404s were observed again and are pre-existing local data warnings. Residual risk: Plans 012–014 remain.
2026-08-14 — Milestone 4 completed. Conversation entries and replies now use immutable GitHub IDs. Mermaid source disclosure is a sibling of the diagram button in both rendered and loading/failure branches; strict Mermaid sanitization and the visual card remain unchanged. The final fallback fix removed the remaining `html-no-nested-interactive` warning without widening scope. Focused renderer tests (8), accessibility tests (11), full Vitest (109 files, 626 tests), build, full Playwright (36 tests), format, lint, typecheck, targeted React Doctor scan, and `git diff --check` passed. Residual risk: remaining scanner findings are deferred to Plan 014; no Markdown positional keys were changed.

At every completed milestone, add a dated entry here with the actual changed files, review disposition, verification result, and residual risk. At program completion, state the calibrated before/after scanner result for the same version and scope, all evidence-backed rejections, and checks not run.

## Context and Orientation

Patchdesk is an Electron application. The renderer is React code in `src/renderer/src/`. The Electron main process owns the local loopback API, credentials, provider checks, and GitHub authority. The renderer must remain sandboxed. A GitHub write requires an explicit current UI action. All live Electron checks in this program are read-only.

React Doctor is an advisory scanner. It complements Oxfmt, Oxlint, TypeScript, Vitest, Playwright, package smoke, and live Electron QA. It is not a release gate and a higher score is not itself acceptance evidence.

The controlling queue is `plans/README.md`. Detailed plan files are:

- `plans/009-calibrate-react-doctor-signal.md`
- `plans/010-characterize-react-lifecycle-regressions.md`
- `plans/011-restore-committed-render-ref-purity.md`
- `plans/012-stabilize-rendered-identity-and-semantics.md`
- `plans/013-harden-react-toolchain-dependencies.md`
- `plans/014-disposition-remaining-react-doctor-debt.md`

Each plan has its own mandatory drift check, scope, STOP conditions, and verification commands. The plan files require a worker to update only its own `plans/README.md` status row after the plan is fully complete. Do not mark a plan done on partial implementation or a passing subset of checks.

The current root scanner baseline was recorded at commit `a3813b8`: React Doctor 0.9.11 completed a 342-file scan with schema version 3, no skipped checks, score 34, 44 errors, and 215 warnings. Thirty-two errors came from generated output, Node-script environment mismatch, or the isolated `runtime/flue/` package. Eleven renderer errors were `no-ref-current-in-render` findings.

The current checkout is intentionally dirty. Preserve all existing staged, unstaged, and untracked work. At planning time it includes work under `.agents/skills/patchdesk-review-lifecycle/`, `brain/`, and the untracked `plans/` files, including `plans/README.md`. Before every worker launch, the parent must inspect `git status -sb`, `git diff --stat`, `git diff --cached --stat`, and the plan-specific drift check. Never reset, clean, restore, broadly reformat, or absorb unrelated hunks.

The live supporting tabs are `patchdesk logs live` and `patchdesk dev live`. The current dev app has CDP port 9233. Main-process changes require a full restart in the dev tab; renderer-only changes can hot reload. Keep the log tail active and inspect it during live verification.

Key implementation seams are as follows:

- `src/renderer/src/flows/review-workbench-flow.tsx` owns scheduled update detection, snapshot generations, detector de-duplication, refresh invalidation, and workbench patch/replace callbacks.
- `src/renderer/src/hooks/use-review-diff-hydration.ts` owns deduplicated file hydration and generation invalidation.
- `src/renderer/src/hooks/use-progressive-review-diff-stream.ts` owns visible file append batches and old-generation suppression.
- `src/renderer/src/hooks/use-insight-run.ts` owns Insight start, cancellation, polling, terminal reload, and completion callbacks.
- `src/renderer/src/hooks/use-commit-diff.ts` suppresses old commit-diff responses by token.
- `src/renderer/src/components/logs-panel.tsx` owns pause-aware log polling and cursor progression.
- `src/renderer/src/components/conversation.tsx` renders Conversation timeline and reply keys.
- `src/renderer/src/components/pull-request-description.tsx` renders Mermaid diagrams, source disclosure, and the lightbox trigger while keeping Mermaid strict-mode sanitization.
- `src/domain/github-context.ts` supplies required immutable GitHub IDs used for stable Conversation identity.

## Plan of Work

The parent runs one serial milestone at a time. A milestone has this fixed delegation protocol:

1. If the plan needs new current-state or upstream evidence, launch read-only `scout` or `researcher` children first. Their prompts must name the exact plan, files, evidence question, and no-edit boundary.
2. The parent reads the evidence and either resolves ordinary implementation decisions or asks the user about any product, authority, deletion, major-upgrade, or scope decision.
3. Launch exactly one asynchronous `worker` in the shared checkout. The worker receives the whole detailed plan path, this ExecPlan, the exact file scope, current dirty-tree warning, STOP conditions, and acceptance commands. It cannot launch subagents, create a branch, commit, push, install unrelated packages, or change GitHub state.
4. The parent does not edit the checkout while that worker runs. It may prepare a validation checklist or inspect the worker handoff.
5. When the worker reports completion, launch at most one fresh-context, read-only `reviewer`. The reviewer must inspect the real diff and plan acceptance criteria, not trust the worker report. The reviewer returns only evidence-backed blockers or an explicit pass.
6. The parent synthesizes the review. If an accepted fix is needed, launch one worker only after documenting the accepted scope. Do not launch another reviewer for that milestone without updating this ExecPlan and obtaining approval for that process change.
7. The parent checks the final diff, reruns any affected verification not already directly observed, runs live Electron proof where required, updates this ExecPlan’s living sections, and advances only when the detailed plan’s done criteria are met.

A worker must stop and ask the parent rather than improvise when any detailed-plan STOP condition occurs. The parent must ask the user before removing code or functionality that appears intentional, accepting a major dependency migration, changing the approved Flue runtime closure, weakening tests or performance thresholds, changing GitHub-write authority, or changing Review ordering/ownership.

## Milestones

### Milestone 1: Calibrate the root React Doctor signal

Goal: Make root React Doctor results describe root application source rather than generated output, Node-script environment mismatch, or the separately verified Flue runtime.

Work: Execute Plan 009 only. Capture the local 0.9.11 baseline JSON in a fresh temporary directory. Prove schema version 3, complete projects, and no skipped checks. Use React Doctor’s installed rules tooling to generate a supported root `doctor.config.json`; do not guess its shape. Narrowly exclude `out/**`, `release/**`, `test-results/**`, and `runtime/flue/**`. Suppress only `eslint/no-undef` for `scripts/**/*.mjs`; do not globally suppress correctness, effect, identity, accessibility, or async rules. Change `package.json` so `pnpm doctor` uses the installed local binary. Prove that renderer render-time ref diagnostics remain visible.

Commands, from `/Users/kwanpham/Work/cfw/patchdesk`:

    RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/react-doctor.XXXXXX")"
    pnpm exec react-doctor . --json --blocking none --yes --scope full --no-cache --json-out "$RUN_DIR/before.json"
    jq -e '.schemaVersion == 3 and .ok == true and all(.projects[]; .complete == true and (.skippedChecks | length) == 0)' "$RUN_DIR/before.json"
    pnpm exec react-doctor rules list --configured --json | jq .
    pnpm doctor -- --score
    pnpm exec react-doctor . --json --blocking none --yes --scope full --no-cache --json-out "$RUN_DIR/after.json"
    pnpm format:check
    pnpm lint
    pnpm typecheck
    git diff --check

Expected result: both JSON scans are complete and schema 3; no root diagnostic points to excluded output or Flue; Node scripts no longer report this one false-positive rule; root renderer findings still exist; formatter, linter, typecheck, and diff check pass.

Risk reduction: Later plans can trust a scanner finding without changing production behavior merely to satisfy a mis-scoped tool.

Delegation: one worker. After its handoff, one reviewer checks config scope, diagnostic retention, and no over-broad suppression.

Do not proceed if the installed scanner rejects the documented config controls, exclusion removes renderer analysis, the local version differs without an intentional lock change, or configuration needs a global correctness-rule disable.

### Milestone 2: Characterize lifecycle and interaction behavior before refactoring

Goal: Add deterministic tests that make stale-result, duplicate-request, polling, and interaction contracts observable before production refactoring.

Work: Execute Plan 010 only; it must change tests and the Plan 010 status row, not production code. Use deferred desktop-bridge responses and fake timers. Tests must assert caller-visible requests, callbacks, and DOM behavior rather than private refs, React keys, method spies, or exported private helpers.

Required coverage:

- Review detection: old snapshot completion cannot patch newer projection; focus/visibility events do not duplicate active detection; latest committed callback receives valid current-generation result; unmount clears scheduling and ignores late completion.
- Commit diff: a rerendered latest loader serves the second selected SHA once while first deferred output remains ignored.
- Diff hydration: duplicate path sharing, stale generation rejection, selected-path status ownership, and retry only after generation change.
- Progressive diff stream: one request per visible batch, old batch rejection, and behaviorally bounded concurrency/batches.
- Insight: one owner polls; unmount or Review change suppresses late poll and terminal reload; only latest callback receives terminal completion; old run cannot overwrite newer run; cancellation error remains visible without fabricated completion.
- Logs: pause stops future polling but permits one already in-flight response; resume uses the committed cursor once; unmount suppresses late completion.
- Mermaid: source disclosure and diagram lightbox are independent keyboard controls and do not add serious or critical Axe failures.

Focused commands, from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx
    pnpm test -- --run tests/renderer/use-commit-diff.test.ts
    pnpm test -- --run tests/renderer/use-review-diff-hydration.test.ts tests/renderer/use-progressive-review-diff-stream.test.ts
    pnpm test -- --run tests/renderer/use-insight-run.test.ts
    pnpm test -- --run tests/renderer/logs-panel.ui.test.tsx tests/renderer/pull-request-description.ui.test.tsx
    pnpm build && pnpm exec playwright test tests/browser/accessibility.spec.ts

Then run:

    pnpm format:check
    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm exec playwright test
    git diff --check

Expected result: all focused and full tests pass without test-only production seams or weaker existing thresholds. Record current test totals rather than treating historical counts as a fixed requirement.

Risk reduction: Plans 011 and 012 can now modify real seams while direct tests protect Review freshness, cancellation, and keyboard behavior.

Delegation: one worker. After its handoff, one reviewer checks that no production file changed and every named contract has a test that can fail for its intended defect.

Do not proceed if Plan 009 is not done, a deterministic bridge seam is unavailable without production changes, a test needs a private export, or current behavior contradicts `CONTEXT.md` or ADR-0017 Review freshness rules.

### Milestone 3: Bind scheduled React work to committed values

Goal: Remove render-time input-ref assignments from lifecycle-sensitive renderer code without making scheduled work read stale values after React commits.

Work: Execute Plan 011 only after Milestone 2 is done. Create `src/renderer/src/hooks/use-latest-committed.ts` with one stable ref that updates in `useLayoutEffect`, not during render or only in passive `useEffect`. Add a public-contract test in `tests/renderer/use-latest-committed.test.ts` for stable identity and committed update behavior. Replace only input-mirroring refs in:

- `src/renderer/src/components/logs-panel.tsx`
- `src/renderer/src/flows/review-workbench-flow.tsx`
- `src/renderer/src/hooks/use-commit-diff.ts`
- `src/renderer/src/hooks/use-insight-run.ts`

Do not replace request tokens, generation counters, active-run ownership, timer handles, cancellation state, or in-flight guards. Those are imperative protocol state and preserve safety rules.

Commands, from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/renderer/use-latest-committed.test.ts tests/renderer/use-commit-diff.test.ts tests/renderer/use-insight-run.test.ts tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/logs-panel.ui.test.tsx
    pnpm exec react-doctor . --json --blocking none --yes --scope full --no-cache --json-out /tmp/patchdesk-react-doctor.json
    jq -e '[.projects[].diagnostics[] | select(.rule == "no-ref-current-in-render" and (.normalizedFilePath == "src/renderer/src/components/logs-panel.tsx" or .normalizedFilePath == "src/renderer/src/flows/review-workbench-flow.tsx" or .normalizedFilePath == "src/renderer/src/hooks/use-commit-diff.ts" or .normalizedFilePath == "src/renderer/src/hooks/use-insight-run.ts"))] | length == 0' /tmp/patchdesk-react-doctor.json
    pnpm format:check
    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm exec playwright test
    git diff --check

After command verification, the parent uses the read-only `patchdesk-electron-tester` flow against CDP 9233 to open an existing Review, observe background update detection, change tabs and return without duplicate detection, and inspect for new console/page errors. Do not write to GitHub.

Expected result: the targeted four files have zero render-time ref diagnostics, lifecycle race tests remain green, and live Review behavior remains intact.

Risk reduction: this fixes a confirmed correctness category while retaining every stale-result, generation, cancellation, and explicit-Refresh ownership rule.

Delegation: one worker. After its handoff, one reviewer checks that only input-mirroring refs moved and no authority-bearing protocol guard was removed.

Do not proceed if Milestone 2 is incomplete, a callback can be stale between commit and layout effect, an assertion needs weakening, a change alters Review or GitHub-write behavior, or the new hook itself is a version-specific false positive without exact diagnostic evidence.

### Milestone 4: Stabilize Conversation identity and Mermaid semantics

Goal: Use immutable GitHub identity where it exists and make Mermaid source disclosure independently operable without a nested interactive control.

Work: Execute Plan 012 only after Milestone 2 is done. In `src/renderer/src/components/conversation.tsx`, add exhaustive identity selection for issue comment, published review summary, and general thread IDs. Use required comment IDs for replies instead of an index fallback. Do not bulk-change positional Markdown token keys or claim a runtime regression test for stateless rows.

In the successful Mermaid branch of `src/renderer/src/components/pull-request-description.tsx`, make the diagram-opening button and `<details>/<summary>` source disclosure siblings in the same visual card. Keep strict Mermaid configuration, existing SVG containment, accessibility name, lightbox Escape/focus contract, and visible design.

Commands, from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/renderer/conversation.ui.test.tsx tests/renderer/pull-request-description.ui.test.tsx
    pnpm build && pnpm exec playwright test tests/browser/accessibility.spec.ts
    pnpm exec react-doctor . --json --blocking none --yes --scope full --no-cache --json-out /tmp/patchdesk-react-doctor.json
    pnpm format:check
    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm exec playwright test
    git diff --check

Expected result: source activation never opens the image dialog; keyboard diagram activation does; browser Axe has no serious or critical Patchdesk violations; targeted React Doctor findings are absent; remaining index-key findings are recorded rather than mechanically edited.

Risk reduction: this removes concrete reconciliation and keyboard-semantic defects while avoiding a broad Markdown or lightbox rewrite.

Delegation: one worker. After its handoff, one reviewer checks domain ID use, semantic nesting removal, sanitization preservation, and the evidence disposition for remaining index-key warnings.

Do not proceed if any live Conversation variant lacks immutable identity, a renderer DTO or GitHub adapter must change to create it, Mermaid separation changes sanitization/raw injection, or visual preservation needs wider component work.

### Milestone 5: Patch verified dependency advisories

Goal: Patch reachable runtime and build-chain advisories through minimal, evidence-supported dependency changes without an accidental platform migration.

Work: Execute Plan 013 only after Milestone 1 is done; this ExecPlan serializes it after Milestones 3 and 4. First delegate a read-only scout to capture current production and full audit JSON, each `pnpm why` path, current `pnpm outdated` information, Flue-lock presence, and package behavior seams. Delegate research only when current upstream evidence is missing or changed. Classify every candidate as shipped runtime, packaging/build-only, test/tool-only, isolated Flue closure, or unreachable metadata.

Patch a direct package only after current graph and official release evidence establish the exact target. Mermaid `11.16.0` to at least `11.16.1` is the known minimal confirmed candidate and must preserve `securityLevel: "strict"`, lazy rendering, and source behavior. Hono and `@hono/node-server` are already above the researched floors; change them only if current audit/reachability proves a newer applicable target. Keep Electron 43.x, electron-builder 26.x, Vite 7.x, Vitest 3.2.x, Tailwind 4.3.x, and the exact Flue package closure unless separate current evidence and user approval justify a larger migration.

Commands, from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm audit --prod --audit-level high --json
    pnpm audit --audit-level high --json
    pnpm why <affected-package>
    pnpm outdated
    pnpm format:check
    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm test:bundle
    pnpm exec playwright test
    pnpm package:mac
    pnpm test:package-smoke
    git diff --check

The first four commands can legitimately return a nonzero status when findings or outdated packages exist. Capture their JSON/text and classify it; do not discard it or interpret the exit status alone as an implementation failure. Run package and smoke gates whenever a packaging path changes. Inspect runtime manifest/digests if the isolated runtime lock changes.

Expected result: production audit has zero high and critical findings; each high/moderate direct or packaging advisory has a path and disposition; all modified dependencies have upstream compatibility evidence; package, bundle, smoke, renderer, and test gates pass; no unapproved Flue upgrade occurs.

Risk reduction: package health is based on reachability and actual distribution proof, not scanner heuristics or blanket latest upgrades.

Delegation: one worker. After its handoff, one reviewer checks the lock diff, every advisory path/disposition, runtime versus build classification, unchanged Flue versions, and package-smoke evidence.

Do not proceed if a fix requires a major Electron, Vite, or Flue migration; an override breaks an upstream range; package smoke/security tests regress; an intentional dependency must be removed; or the fix changes provider or GitHub-write capabilities.

### Milestone 6: Measure and disposition remaining React Doctor debt

Goal: Produce a complete, durable explanation for every remaining post-remediation React Doctor diagnostic and change production only where measurement or direct behavior proves a benefit.

Work: Execute Plan 014 only after the preceding milestones are done. Run the calibrated scan at the same version and scope. Create `plans/audit-<date>-react-doctor-disposition.md` and assign every remaining error or warning ID exactly one outcome: confirmed failure, rejected with evidence, needs measurement, intentional ordered operation, or an explicit follow-up plan.

Use `pnpm exec react-doctor why <file:line>` and `pnpm exec react-doctor rules explain <rule>` when a rule is unclear. For diff hydration, add deterministic measurement before changing its bounded batching. Only replace batch barriers with a bounded worker queue if a representative workload shows a predeclared, user-visible gain without increased request count or broken generation/deduplication behavior. For large renderer files, extract only cohesive pure presentation after tests prove lifecycle ownership remains in one place. For sequential awaits and repeated collection passes, preserve ordered writes, rate limits, cleanup, and deterministic error handling unless a focused measurement proves independence and benefit.

Do not delete unused exports, files, entry points, fixtures, generated catalogs, or runtime-loaded modules merely from scanner output. Gather import/reference/build evidence. Ask the user before removal if the target appears intentional.

Commands, from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm exec react-doctor . --json --blocking none --yes --scope full --no-cache --json-out /tmp/patchdesk-react-doctor-final.json
    pnpm test:performance
    pnpm format:check
    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm exec playwright test
    pnpm test:bundle
    git diff --check

Run `pnpm package:mac` and `pnpm test:package-smoke` too if a package-related file changed. Preserve the existing 1,000-file browser performance thresholds exactly.

Expected result: every remaining diagnostic is in the disposition artifact exactly once; each performance change has before/after evidence; no ordered safety workflow was parallelized mechanically; no lifecycle owner moved without coverage; no intentional code was removed without approval; final scan is complete and comparable to the calibrated baseline.

Risk reduction: the durable outcome is a trusted measurement and disposition record, not arbitrary score chasing.

Delegation: one worker. After its handoff, one reviewer checks one-to-one diagnostic coverage, performance claims, ordering/authority preservation, deletion evidence, and final verification coverage.

Do not proceed if an optimization changes durable write ordering or Review authority, extraction moves an effect/state owner without characterization coverage, removal needs ungranted user approval, or performance improvement requires weaker thresholds.

## Concrete Steps

All commands run from `/Users/kwanpham/Work/cfw/patchdesk` unless a command says otherwise.

Before every milestone:

    git status -sb
    git diff --stat
    git diff --cached --stat
    git diff --stat a3813b8..HEAD -- <the plan’s listed drift paths>

Expected result: the parent can identify all existing dirty paths and detect new committed drift in the plan’s scope. If unrelated changes now overlap allowed files, stop and ask the user or the owning agent rather than merging edits by assumption.

Before each worker launch:

1. Re-read this ExecPlan and the complete detailed plan.
2. Use `subagent` agent discovery and select an executable `worker` only.
3. Include exact scope, current dirty-tree warning, no-branch/no-commit/no-push boundary, full STOP conditions, validation contract, and required handoff in the worker prompt.
4. Keep the worker asynchronous. The parent makes no simultaneous source edits.
5. When needed, use only read-only `scout` and `researcher` children for fresh evidence before the worker. Give each a distinct question and no-edit authority.

After each worker:

1. Inspect its changed-file list, command results, and residual risks.
2. Run exactly one fresh-context read-only `reviewer` against the real diff and milestone acceptance criteria.
3. Synthesize the review. If a fix is accepted, start only one worker to apply it. If the reviewer finds an unapproved decision, ask the user rather than fixing.
4. Inspect `git diff --check`, final scope, plan status row, and relevant artifacts. Run the required live check for Milestone 3.
5. Update this ExecPlan’s `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` before launching the next milestone.

## Validation and Acceptance

Program acceptance requires all of the following:

- Plans 009 through 014 have their detailed done criteria met and their individual `plans/README.md` rows marked `DONE` only after complete proof.
- The calibrated root scan uses local React Doctor 0.9.11 or a deliberately updated, recorded version; it is schema 3, complete, and has no skipped checks.
- Root generated output, root Node-script false positives, and the isolated Flue runtime do not pollute the root scan, while meaningful root renderer checks remain enabled.
- Deferred tests prove stale detector, hydration, stream, Insight, commit-diff, and log work cannot violate their named ownership rules.
- The four targeted renderer files have no `no-ref-current-in-render` findings and still pass direct race tests.
- Conversation uses required immutable GitHub IDs; Mermaid source and lightbox controls work independently through keyboard interaction without serious or critical Axe violations.
- Every dependency change has a current graph path, upstream compatibility evidence, focused behavior proof, and appropriate package/distribution checks.
- Every remaining scanner diagnostic has a one-to-one evidence disposition. No score target is required.
- Format, lint, typecheck, unit/integration tests, renderer build, browser tests, performance test, and package checks when applicable pass without weaker thresholds.
- Read-only Electron QA proves the changed code runs in the live app and creates no GitHub write.

## Idempotence and Recovery

React Doctor scan output belongs in a fresh `mktemp` directory or `/tmp`; it must never be committed. Scans, focused tests, format checks, lint, typecheck, builds, browser tests, and rescan queries are safe to repeat. Always capture audit output even if pnpm returns nonzero for findings.

Do not use `git reset --hard`, `git clean`, `git restore`, broad stashes, force-add, or broad stage commands. Stage explicit files only if a future user-approved commit is requested. Never overwrite existing dirty hunks; re-read the exact in-scope hunk and stop on ambiguity.

If a worker stops under a detailed-plan STOP condition, leave its partial diff intact, record the condition in `Surprises & Discoveries`, mark no downstream plan done, and ask the parent/user for the missing decision. If a worker times out after a tool call, first inspect the changed files and command state before resuming or replacing it.

If main-process code changes, restart the existing dev app in `patchdesk dev live` with `pnpm dev -- --remote-debugging-port=9233`, then verify the dev log shows the local API and CDP listener. Renderer-only code may hot reload, but live QA still uses the running app and log tail. Do not use static tests as a substitute for the required live Milestone 3 check.

If package smoke needs a fresh package, let `pnpm package:mac` complete before `pnpm test:package-smoke`. If a lock or runtime digest changes unexpectedly, stop and classify it before continuing.

## Artifacts and Notes

Plan 009 configuration is implemented but not complete: `doctor.config.json` excludes only generated artifacts and the isolated Flue package, and `package.json` now uses the local React Doctor 0.9.11 binary. Its scan has 12 errors and 205 warnings, down from 44 errors and 215 warnings; exclusions and the Node-script override removed the intended noise while all 11 renderer render-time-ref diagnostics remain. A reviewer found no scope/configuration defect, but the milestone remains blocked because `pnpm format:check` reports `brain/index.md`, an existing out-of-scope dirty file. Correct the plan command spelling to use `pnpm run doctor`, not the pnpm shortcut plus an extra double dash.

This plan was informed by read-only delegated reports stored under `.pi/subagents/artifacts/outputs/`:

- `3bb4bf63/context.md`: execution order, detailed-plan dependencies, dirty-tree and gate contract.
- `94b483b9/context.md`: renderer seams, test patterns, and lifecycle/semantic invariants.
- `3a982132/context.md`: scanner and dependency graph facts, package smoke seam, and current audit evidence.
- `2af91548/research.md`: official advisory and release evidence for Plan 013 candidates.

These reports are supporting evidence, not implementation authority. The current repository, package manager graph, detailed plan STOP conditions, and user decisions override them when execution starts.

Record each milestone’s worker handoff, reviewer result, focused test output, full-gate output, scan JSON location, and live QA note in this section or in an explicitly linked artifact. Do not add credentials, provider values, or full environment output.

## Interfaces and Dependencies

The root toolchain uses pnpm 8.8.0 and Node `>=22.19.0`. Root React Doctor is `0.9.11` before execution. Root quality authority is Oxfmt `0.63.0`, Oxlint `1.78.0`, TypeScript, Vitest, Playwright, and package smoke; direct ESLint or Prettier is not a Patchdesk tool contract.

`doctor.config.json` is the planned root scanner configuration. It must use only schema/config fields verified by the installed React Doctor rules tooling. Its purpose is root scan scope only; it must not weaken production or Flue runtime testing.

The root loopback API uses Hono. Mermaid is lazy-loaded in the pull-request description and must keep strict security settings. `runtime/flue/` is a separately packaged exact closure whose current runtime versions are `@flue/runtime` 2.0.3 and `@earendil-works/pi-ai` 0.84.1; Plan 013 must not change them without separate approved evidence.

The central renderer contracts are tokens, generations, active-run identity, in-flight guards, cancellation, and current callbacks. Input-mirroring refs may become committed-value refs in Milestone 3. Protocol refs must remain imperative and owned by their current lifecycle state machine. Conversation identity comes from required GitHub IDs in `src/domain/github-context.ts`. Mermaid keeps sanitized SVG rendering separate from its interactive disclosure and lightbox controls.
