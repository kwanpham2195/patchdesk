# Implementation Plans

Updated 2026-08-06. Execute independent plans in priority order. Use the design artifacts named by each plan as structural references; production styling should continue using the existing Base UI/shadcn primitives and Tailwind utilities.

## Execution order and status

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

- The plan is intentionally one slice. Establishing scroll ownership and the reader layout must happen together; splitting them would create intermediate states with competing scroll containers.
- 002 is independent of 001; they touch different surfaces (settings/inbox vs Walkthrough reader).
- 003 is independent of 001 and 002, but its executor must preserve and reconcile the pre-existing dirty PR Overview component before editing.

## Findings considered and rejected

- Replacing the persistent Review draft and Published feedback docks with a new global side panel is out of scope. ADR 0004 requires the Review draft to remain a persistent collapsible bottom dock; this plan only prevents those supporting panels from obscuring the Walkthrough reader.
- Adding sentence-level citation positions to the model schema is deferred. Existing hunk IDs and paths can support a clear section-level evidence index without changing the validated Walkthrough contract.
- Changing Walkthrough generation, persistence, provider behavior, or GitHub write flows is out of scope. This is a renderer/layout pass only.
