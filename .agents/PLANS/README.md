# Implementation Plans

Updated 2026-08-12. The active implementation plan separates safe PR-metadata
reconciliation from explicit code-revision refresh, then corrects the file-tree theme
and PR Overview merge controls. Production styling continues using the existing
Base UI/shadcn primitives and Tailwind utilities.

## Current active plan

- **2026-08-12 — Separate PR metadata reconciliation from revision refresh and polish the workbench**
  - Priority: P1
  - Effort: M
  - Status: TODO
  - Plan: `.agents/PLANS/2026-08-12-pr-metadata-reconciliation-and-workbench-polish.md`
  - Depends on: ADR-0017 (to be written as Step 1).

## Historical and deferred plans

The entries below are retained context only. They are not active work unless a
maintainer explicitly promotes one back into this section.

### Prior plan status

- **2026-08-11 — Add the Codex CLI account Insight provider**
  - Priority: P1
  - Effort: L
  - Status: DONE (`6d37a45`)
  - Plan: `.agents/PLANS/2026-08-11-codex-cli-account-provider.md`
  - Depends on: ADR-0016 and deterministic fake-app-server coverage.

- **2026-08-10 — Improve review submission recovery and Walkthrough discussion context**
  - Priority: P1
  - Effort: L
  - Status: DONE
  - Plan: `.agents/PLANS/2026-08-10-review-submission-and-walkthrough-context.md`
- **001 — Make the Walkthrough result reader-first with a docked chapter rail**
  - Priority: P1
  - Effort: M/L
  - Depends on: none
  - Status: BLOCKED (post-fix CDP mobile interaction)
  - Plan: `.agents/PLANS/001-walkthrough-result-ui.md`
- **002 — Simplify watchlist, auto-detect profiles, and show provider/model labels**
  - Priority: P1
  - Effort: M
  - Depends on: none
  - Status: TODO
  - Plan: `.agents/PLANS/002-watchlist-profile-model-labels.md`
- **003 — Refine PR Overview into a status-led sidebar**
  - Priority: P1
  - Effort: M
  - Depends on: none
  - Status: DONE (implementation + static gates; live Electron QA delegated separately)
  - Plan: `.agents/PLANS/003-pr-overview-status-sidebar.md`
  - Verification: focused renderer suite 38/38, full suite 852/852, typecheck, lint, build, browser workbench spec 21/21 scope tests, `git diff --check` clean. `pnpm test:design` still fails on pre-existing dock-visibility failures (Review draft dock / Published feedback dock `hidden` since 2a8a038), reproduced identically at baseline b3a5868.

## Dependency notes

- **2026-08-09 — Correct the pending-review inline lifecycle**
  - Priority: P0
  - Effort: L
  - Depends on: reconciling the current uncommitted desktop-bridge allowlist fix
  - Status: DONE (implementation + full gate; live Electron QA read-only pass pending)
  - Plan: `.agents/PLANS/2026-08-09-pending-review-inline-lifecycle.md`
  - Scope: schema-valid AddThread, pending-thread inline feedback, stale-composer removal, and symmetric own-write detection exclusion. It does not authorize GitHub writes.
  - Verification: full suite 1034/1 skipped, typecheck, lint, build clean; playwright 33/33; `git diff --check` clean. The user-owned pending review on cfw-bo-staff-api#717 is untouched; no GitHub write was made.

- **2026-08-09 — Add summary-only GitHub reviews**
  - Priority: P1
  - Effort: M/L
  - Status: IMPLEMENTATION UNDER VALIDATION WAIVER — direct Comment/Approve/Request changes evidence is in `.agents/research/2026-08-10-summary-only-review-direct-submission-spike.md`; the product owner explicitly waived the remaining live validation rows
  - Plan: `.agents/PLANS/2026-08-09-summary-only-review.md`
  - Recommendation: direct immediate summary submission, not an unproven empty pending review.

- The plan is intentionally one slice. Establishing scroll ownership and the reader layout must happen together; splitting them would create intermediate states with competing scroll containers.
- 002 is independent of 001; they touch different surfaces (settings/inbox vs Walkthrough reader).
- 003 is independent of 001 and 002, but its executor must preserve and reconcile the pre-existing dirty PR Overview component before editing.

## Findings considered and rejected

- Replacing the persistent Review draft and Published feedback docks with a new global side panel is out of scope. ADR 0004 requires the Review draft to remain a persistent collapsible bottom dock; this plan only prevents those supporting panels from obscuring the Walkthrough reader.
- Adding sentence-level citation positions to the model schema is deferred. Existing hunk IDs and paths can support a clear section-level evidence index without changing the validated Walkthrough contract.
- Changing Walkthrough generation, persistence, provider behavior, or GitHub write flows is out of scope. This is a renderer/layout pass only.
