# Plan 014: Measure and disposition remaining React Doctor debt

> **Executor instructions**: Execute only after Plans 009–013. This is a measurement-led cleanup, not a mandate to reach score 100. Confirm impact before performance or architecture changes. Ask before deleting code or functionality that appears intentional. Update only this plan's status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a3813b8..HEAD -- src/renderer src/services src/adapters tests/renderer tests/browser doctor.config.json`

## Status

- **Status**: REJECTED — Superseded by `.agents/PLANS/2026-08-14-complete-react-doctor-remediation.md`; the existing 207-ID audit remains authoritative input to the delta plan.

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plans 009–013
- **Category**: perf
- **Planned at**: commit `a3813b8`, 2026-08-14

## Why this matters

After false-positive calibration and correctness fixes, React Doctor will still report performance and maintainability observations: giant components, repeated collection passes, sequential awaits, unused exports/files, and prop-to-state patterns. Many are not defects. Storage and Review workflows often await sequentially to preserve ordering; Markdown output can legitimately use positional keys; large lifecycle files can be safer than premature extraction. This plan requires evidence for each remaining cluster, fixes only confirmed costs, and records rejections so the same noise is not repeatedly audited.

## Current state

- `src/renderer/src/flows/review-workbench-flow.tsx` is about 2,600 lines and owns projection state, refresh/detection scheduling, commands, diff/Insight coordination, and rendering. Its size is confirmed maintenance debt, but async extraction is high risk.
- `src/renderer/src/flows/settings-flow.tsx` is about 1,200 lines and mixes profile/provider state with rendering.
- `src/renderer/src/hooks/use-review-diff-hydration.ts:145-168` uses bounded batches. Later paths wait for the slowest request in the current batch, but there is no measured latency problem yet and the cap protects the local API.
- `tests/browser/performance.spec.ts` is a real 1,000-file, approximately 10 MB end-to-end baseline with strict per-attempt thresholds. It does not measure render counts or hydration queue latency.
- React Doctor's initial warning clusters included 18 `async-await-in-loop`, 14 `js-combine-iterations`, 19 unused exports, 10 unused files, and 8 giant components. These counts include server/storage code and must not be fixed mechanically.
- Repository policy requires explicit confirmation before removing functionality or code that appears intentional.

## Commands you will need

- Calibrated React Doctor JSON scan from Plan 009.
- `pnpm test:performance`
- `pnpm test -- --run`
- `pnpm build`, `pnpm exec playwright test`
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`
- `git diff --check`

## Scope

**In scope**:

- A new evidence file `plans/audit-<date>-react-doctor-disposition.md`
- Focused tests/fixtures required to measure a confirmed renderer cost
- Pure presentation extraction from `review-workbench-flow.tsx` or `settings-flow.tsx` only after tests prove unchanged lifecycle behavior
- Individual source files for a confirmed performance fix, one cluster at a time
- `doctor.config.json` only for evidence-backed per-rule/per-file disposition after `rules explain`
- `plans/README.md` status row only

**Out of scope**:

- Blanket parallelization of storage, receipt, journal, Refresh, Review preparation, or GitHub operations.
- Bulk deletion of unused files/exports.
- Broad component rewrites or state-library adoption.
- Weakening the 1,000-file performance thresholds.
- Global suppression of correctness rules.
- Changes to GitHub-write authority, explicit Refresh, receipt, or observation-journal protocols.

## Git workflow

- Branch: `refactor/react-doctor-debt`
- Use small commits per independently verified cluster. Examples: `perf: stream bounded diff hydration` or `refactor: extract workbench presentation`.
- Stage explicit paths only. Do not push unless instructed.

## Steps

### Step 1: Build a diagnostic disposition manifest

Run calibrated React Doctor JSON after Plans 009–013. Group by rule and file. For every remaining occurrence, record one outcome in `plans/audit-<date>-react-doctor-disposition.md`:

- confirmed failure;
- rejected with evidence;
- needs measurement;
- intentional ordered operation;
- explicit follow-up plan.

Use `pnpm exec react-doctor why <file:line>` and `rules explain <rule>` for ambiguous items. Do not infer impact from count alone.

**Verify**: every remaining error and warning ID from the scan appears exactly once in the manifest.

### Step 2: Measure hydration before changing concurrency

Add a focused deterministic measurement for `use-review-diff-hydration` that uses delayed requests with one slow item and several fast items. Record current time-to-first/next hydrated item and maximum concurrent requests. Preserve the existing cap.

Only if the batch barrier causes a user-visible delay under representative workload, replace batch barriers with a bounded worker queue that starts the next path when one finishes. Preserve request deduplication, generation invalidation, unavailable-path caching, and stable presentation ordering.

**Verify**:

- focused hydration race tests from Plan 010 pass;
- maximum concurrency never exceeds the existing cap;
- measured completion improves by a predeclared threshold without increasing request count;
- `pnpm test:performance` keeps its original thresholds.

If measurement does not prove a meaningful gain, record a rejection and do not edit production code.

### Step 3: Split presentation before lifecycle ownership

For giant components, extract only cohesive pure presentation sections first. Candidate boundaries include:

- workbench header/status/actions;
- Conversation, Diff, and Insight presentation slots that already receive complete props;
- Settings profile/editor sections with explicit callbacks.

Do not move refresh/detection, pending-review, publication, Insight polling, or merge ownership until characterization tests prove an extraction seam. Keep one writer/owner for each state machine. After each extraction, run focused renderer tests and compare React Doctor output; file length alone is not acceptance evidence.

**Verify**: public behavior tests pass, no callback or effect ownership moves without a named test, and bundle/performance gates do not regress.

### Step 4: Triage sequential awaits and collection passes

For each `async-await-in-loop` or sequential-independent-await warning:

1. identify whether ordering, bounded concurrency, rate limiting, or atomic evidence requires sequence;
2. add a measurement or correctness test;
3. parallelize only independent operations with a bounded concurrency policy;
4. preserve deterministic error classification and cleanup.

For repeated collection passes, optimize only hot paths shown by the performance fixture or a focused benchmark. Prefer clarity for small bounded arrays.

**Verify**: every changed loop has a focused correctness test and, for a performance claim, before/after measurements.

### Step 5: Review dead-code findings with explicit authority

Use import/reference analysis plus build entry points to classify unused exports/files. Generated catalogs, fixture entries, package-smoke runners, lazy entry points, and runtime-loaded modules can appear unused while being intentional.

Before removing any file/export that appears intentional, ask the user. Remove only proven dead public surface, update callers/tests in the same small commit, and run bundle/package gates when an entry point changes.

**Verify**: no removal is based only on React Doctor; each has reference/build evidence and user confirmation when required.

### Step 6: Run full final gates and rescan

Run format, lint, typecheck, full Vitest, build, full Playwright, bundle, and `git diff --check`. Run `pnpm test:performance` separately and preserve its exact thresholds. If packaging-related files changed, also run macOS package and package smoke.

Run calibrated React Doctor with the same version/config as the baseline. Report:

- scanner-reported before/after scores for the same complete scope;
- fixed confirmed findings;
- rejected findings with evidence;
- remaining needs-evidence items;
- checks not run.

## Test plan

- Use Plan 010 race tests as mandatory gates for lifecycle extraction.
- Keep the 1,000-file browser performance test as the real surface proof.
- Add focused measurements only for a named hypothesis; avoid tests that assert render implementation details.
- For each async optimization, test ordering, bounded concurrency, stale completion, failure, and cancellation.

## Done criteria

- [ ] Every post-Plan-013 diagnostic has one evidence-backed disposition.
- [ ] No ordered safety workflow was parallelized mechanically.
- [ ] Every performance change has before/after evidence and unchanged correctness tests.
- [ ] Every architecture extraction preserves one explicit lifecycle owner.
- [ ] Every deletion has reference evidence and required user confirmation.
- [ ] Full repository gates pass; package gates pass when applicable.
- [ ] Final React Doctor report is complete and compared on the same version/scope.

## STOP conditions

- A proposed optimization changes durable write ordering or Review authority.
- A component extraction moves an effect/state owner without a characterization test.
- Removal targets an intentional entry point or functionality without user confirmation.
- Performance improvement requires loosening existing thresholds.

## Maintenance notes

The durable result is not a perfect score. It is a calibrated scanner, protected lifecycle behavior, measured improvements, and a disposition record that prevents repeated low-signal cleanup. When a finding has no measurable or user-visible impact and no clear maintenance gain, record an evidence-backed rejection and continue with independent items; that is not a whole-plan stop. Re-run this plan's manifest reconciliation when React Doctor changes major rule behavior.
