# Implementation Plans

Generated 2026-08-05 for the Walkthrough result UI pass. Execute in the order below. The wireframe under `.agents/tasks/unified-review-workbench/design/` is the structural reference; production styling should continue using the existing Base UI/shadcn primitives and Tailwind utilities.

## Execution order and status

- **001 — Make the Walkthrough result reader-first with a docked chapter rail**
- **002 — Simplify watchlist, auto-detect profiles, and show provider/model labels**
  - Priority: P1
  - Effort: M
  - Depends on: none
  - Status: TODO
  - Plan: `.agents/PLANS/002-watchlist-profile-model-labels.md`
  - Priority: P1
  - Effort: M/L
  - Depends on: none
  - Status: BLOCKED (post-fix CDP mobile interaction)
  - Plan: `.agents/PLANS/001-walkthrough-result-ui.md`

## Dependency notes

- The plan is intentionally one slice. Establishing scroll ownership and the reader layout must happen together; splitting them would create intermediate states with competing scroll containers.
- 002 is independent of 001; they touch different surfaces (settings/inbox vs walkthrough reader).

## Findings considered and rejected

- Replacing the persistent Review draft and Published feedback docks with a new global side panel is out of scope. ADR 0004 requires the Review draft to remain a persistent collapsible bottom dock; this plan only prevents those supporting panels from obscuring the Walkthrough reader.
- Adding sentence-level citation positions to the model schema is deferred. Existing hunk IDs and paths can support a clear section-level evidence index without changing the validated Walkthrough contract.
- Changing Walkthrough generation, persistence, provider behavior, or GitHub write flows is out of scope. This is a renderer/layout pass only.
