# Unified Review Workbench Program Plan (Archived)

> Completed and archived on 2026-08-03. This plan records the original
> implementation program. Do not execute it. Use the current
> [combined spec and design repair ExecPlan](../2026-08-03-unified-review-spec-and-design-repair.md).

> **For agentic workers:** This is the program index, not an executable task list. Implement the four linked plans in order. Each child plan is independently executable and contains exact files, contracts, tests, commands, and commit boundaries.

**Goal:** Replace Patchdesk's prepared/completed split with one stable Review workspace that follows the latest pull-request code through manual refresh, optional retained Insights, local drafting, GitHub publication, Published feedback, and merge.

## Authoritative requirements

Read these before implementation:

- [Product specification](../../spec.md)
- [UI design reference](../../design/design.md)
- [Current UI inventory](../../design/current-ui-inventory.md)
- [Core no-regression contract](../../research/02-research-core-no-regression-contract.md)
- [Model authority ADR](../../../../../docs/adr/0013-keep-model-runs-bounded-and-non-authoritative.md)

The specification and ADRs own product behavior and domain contracts. The no-regression contract owns current safety boundaries. Design documents may guide layout and interaction composition only when they agree with those sources. Text, labels, and behavior shown inside screenshots or generated images are directional only. If a plan step conflicts with the specification or an ADR, update the plan before code; do not silently choose a different contract.

## Reuse-first implementation

- Use the installed shadcn components on Base UI before custom renderer markup or interaction primitives. Compose existing variants and use Base UI `render`; do not recreate tabs, sheets, dialogs, confirmations, collapsibles, scroll areas, focus traps, badges, alerts, loading states, or form controls.
- Reuse Patchdesk's `ReviewDiffView`, `PierreFileTree`, `NarrativeWalkthroughDiff`, `useReviewDiffHydration`, and diff-data helpers. Files, Findings, Commits, and Walkthrough must supply data and selection state to those seams rather than create another diff, tree, or hunk renderer.
- Preserve Pierre ownership of diff rendering, tree selection, scrolling, and focus. The verified plan-time seams are `CodeView`, `FileDiff`, `PatchDiff`, `CodeView.getTopForItem`, `FileTree`/`useFileTree`, `selectOnlyPath`, and `scrollToPath`. Recheck the installed `@pierre/diffs` and `@pierre/trees` types before implementation.
- Extend existing domain, service, adapter, storage, loopback, and GitHub owners before creating a parallel path. A custom primitive, alternate renderer, or new dependency requires exact evidence that the existing seam cannot implement the specification and a plan update before code.

## Execution order

### 1. Foundation

[Unified Review Foundation](2026-08-01-unified-review-foundation.md)

Creates the stable Review aggregate, one strict projection, explicit manual refresh, update detection, total draft carry-forward, and revision-safe commit data.

Gate before continuing:

- A Review ID excludes head SHA and remains stable across new commits.
- The renderer receives only `state: "review"`; no prepared/completed projection remains.
- Detection changes only the update indicator.
- Explicit refresh atomically advances the same Review to a new immutable session.
- Every draft item survives refresh; unsafe anchors become Needs attention.
- Commits and commit diffs are verified against the current immutable session.

### 2. Unified UI

[Unified Review Workbench UI](2026-08-01-unified-review-ui.md)

Builds the single diff-first route and shell, Files/Findings/Commits navigation, persistent view state, typed feature slots, and PR Overview right-side overlay.

Gate before continuing:

- One stable Review destination survives session changes.
- Files is the default surface and stays mounted while Insights is open.
- Findings shows only current exact Mapped Findings.
- Commits selects newest first and Files restores the full PR patch.
- PR Overview overlays the workbench instead of resizing it.
- Old prepared/completed renderer branches and read-only mode copy are gone.

### 3. Insights

[Unified Review Insights](2026-08-01-unified-review-insights.md)

Makes Analysis and Walkthrough independent, durable, cancellable, bounded features with last-success retention and transactional replacement.

Gate before continuing:

- One Analysis and one Walkthrough may run concurrently; a duplicate type may not.
- A replacement never removes the last successful result until it validates and commits.
- Cancellation, failure, restart, or a late result preserves retained content.
- Analysis has exactly four immutable inspection tools and an enforced eight-call budget.
- Walkthrough remains tool-free and renders related hunks directly in its reader.
- Patchdesk, not the model, owns Finding mapping, dispositions, draft creation, publication, and merge authority.

### 4. Feedback, publication, merge, and migration

[Unified Review Feedback and Merge](2026-08-01-unified-review-feedback.md)

Completes the bottom Review draft, deterministic Analysis body, Finding-to-comment mapping, three per-run completion choices, exact publication preview, receipt-backed GitHub writes, Published feedback, configurable Analysis merge policy, and idempotent migration.

Final gate:

- Analysis produces one structured GitHub Review body plus inline comments only for current Mapped Findings.
- General Findings remain in the shared Review body without an unmapped label.
- A non-empty draft is never silently replaced.
- Auto-publication is authorized for one Analysis run and revoked on every freshness, identity, draft, or validation change.
- Published feedback is remote-owned and changes only after explicit refresh or a confirmed mutation followed by refresh.
- Inline published comments may be edited/deleted only with proven permission; review dismissal remains a distinct confirmed action.
- Analysis policy never weakens GitHub, freshness, check, write-recovery, or exact-SHA merge blockers.
- Existing sessions, drafts, receipts, and retained Analysis migrate without deletion or duplication.
- The full lint, typecheck, Vitest, build, Playwright, diff-check, and required live Electron gates pass.

## Cross-plan invariants

All plans must preserve these rules:

- Review identity: one profile plus GitHub host, owner, repository, and pull-request number.
- Revision identity: one immutable session, head SHA, and patch hash.
- Remote consistency: GitHub state on screen changes only after explicit Refresh. Lightweight detection may show Updates available but must not replace visible data.
- Write safety: publication, published-feedback mutation, thread mutation, and merge stop whenever freshness is unavailable or updates are known.
- Local readability: stale or failed remote operations never make the stored patch, draft, Analysis, or Walkthrough unreadable.
- Draft ownership: user edits are durable local work. Model completion cannot silently rewrite them.
- Insight retention: only a validated current candidate may replace a retained result.
- Model authority: prompts and tools may produce structured evidence only. They cannot write to GitHub, mutate a checkout, create a draft, authorize publication, dismiss a Finding, or decide merge eligibility.
- Publication authority: every GitHub write is explicitly confirmed or covered by one immutable per-run authorization.
- Terminal Reviews: merged and closed Reviews remain readable; refresh, draft write, publication, mutation, and merge actions disappear.
- Renderer safety: no local paths, credentials, prompt text, hidden reasoning, raw provider output, command argv, stack trace, or unbounded diagnostic reaches UI or GitHub content.

## Shared ownership boundaries

- `ReviewStore`: stable PR lifecycle and current session pointer.
- `ReviewSessionStore`: immutable revision evidence, attempt artifacts, current draft, and remote-write receipts.
- `InsightStore`: retained Analysis/Walkthrough, active run identity, replacement failure, and Walkthrough reading progress.
- `PublicationAuthorizationStore`: one Analysis-run authorization and revocation evidence.
- `ReviewRefreshService`: the only owner that replaces represented GitHub state or advances the Review to a new session.
- `InsightRunCoordinator`: the only owner that starts, cancels, and commits Insight candidates.
- `ReviewBatchController`: the only owner of local draft edits.
- `ReviewWriteController`: the only owner of publication operations.
- `PublishedFeedbackService`: the only owner of published-comment mutation and review dismissal.
- `MergeService`: the only owner of exact-head merge revalidation and write.

The renderer calls these boundaries through the protected loopback API. It never imports a storage adapter, GitHub adapter, Flue invoker, or filesystem path.

## Acceptance coverage index

The specification's acceptance contract is divided as follows:

- Stable Review, manual refresh, update indicator, changed-head session creation, draft carry-forward, and commit safety: Foundation Tasks 1–5.
- One route, Files/Findings/Commits, PR Overview overlay, view-state retention, responsive layout, keyboard navigation, and old-flow deletion: UI Tasks 1–6.
- Analysis output validation, model boundary, prompt/evidence isolation, tool budget, run concurrency, cancellation, last-success retention, outdated state, Finding disposition, and Walkthrough reading: Insights Tasks 1–8.
- Deterministic Review body, draft seeding/replacement, per-run completion choices, authorization revocation, exact preview, two-stage publication, unknown-outcome recovery, Published feedback, edit/delete/dismiss permissions, Analysis merge policy, migration, and complete seeded browser journey: Feedback Tasks 1–9.

No specification acceptance category is intentionally deferred. Future Insight types remain out of scope, but the shared `InsightProjection` and slot architecture allow them without adding another workbench mode.

## Implementation discipline

- Start each child plan from a coherent checkpoint. The checkout may already be dirty; stage and commit only explicit files from the active task.
- Follow the test-first order written in each task. Do not batch all tests at the end.
- After a task passes its focused proof, make the listed scoped commit before continuing.
- Run the child plan's complete gate before starting the next plan.
- Do not add compatibility aliases for private prepared/completed renderer APIs. Migrate callers, then delete the old path.
- Do not weaken existing safety or performance assertions to make the migration pass.
- For any live app, browser, or packaged Electron verification, the primary agent must spawn a dedicated tester subagent and direct it to use `$patchdesk-electron-tester`.
- If implementation discovers a missing contract, stop that slice and amend the relevant child plan plus specification/ADR before continuing.

## Completion definition

The program is complete only after all four child plans are implemented in order, their focused commits and gates pass, the final seeded journey passes through the protected loopback API, live Electron evidence is recorded by the required tester, and the resulting renderer contains one Review concept rather than parallel prepared/completed/manual/model/read-only modes.
