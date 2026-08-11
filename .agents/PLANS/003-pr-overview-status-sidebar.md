---
created_at: "2026-08-06"
repos:
  - patchdesk
status: DONE
spec: .agents/archive/pr-overview-status-sidebar/spec.md
---

# Plan 003: Refine PR Overview into a status-led sidebar

> **Executor instructions:** Follow this plan step by step. Run the named verification before moving on. This is a renderer composition change; do not alter Review identity, represented GitHub state, Insight lifecycle, Review draft ownership, Published feedback ownership, merge authorization, or external-navigation validation.
>
> **Drift check (run first):** `git diff --stat b3a5868..HEAD -- src/renderer/src/components/pr-overview-sheet.tsx src/renderer/src/components/review-workbench.tsx src/renderer/src/components/review-checks.tsx src/renderer/src/components/merge-confirmation-dialog.tsx tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-checks.ui.test.tsx tests/browser/review-workbench.spec.ts`
>
> Also run `git status -sb`. `src/renderer/src/components/pr-overview-sheet.tsx` already has an uncommitted change. Inspect it before editing, preserve intentional work, and reconcile it with this plan rather than resetting, restoring, or overwriting it.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED
- **Depends on:** none
- **Category:** UI direction
- **Implementation state:** Not started. The pre-existing PR Overview edit partially reorders Checks and merge readiness, but removes represented context and reduces check metadata; it is not accepted as the target implementation without reconciliation.
- **Planned at:** commit `b3a5868`, 2026-08-06
- **Spec:** `.agents/archive/pr-overview-status-sidebar/spec.md`
- **Design references:** `.agents/archive/unified-review-workbench/design/design.md` and `concepts/04-pr-overview-overlay.png`

## Why this matters

PR Overview is the Review workbench’s inspection surface for represented GitHub state and merge readiness. Important status currently competes with pull-request narrative and does not use a consistent visual language. A maintainer should be able to scan the sidebar and understand the represented revision, checks, discussion, independent Insight state, current mapped Findings, and the next merge action without losing the full details needed to act safely.

The implementation must make urgent state compact and recognizable while preserving the existing one-Review model. In particular, a prettier sidebar must not silently discard check requirement metadata, hide Published feedback, turn stale data into current data, navigate to outdated evidence, or weaken the SHA-bound confirmation required for a merge.

## Product and architecture decisions

- PR Overview remains the existing right-edge overlay. It must preserve independent scrolling, background inertness, close control, Escape/backdrop close, and focus restoration to the `PR overview` trigger.
- The canonical Review workbench path is the target. The legacy `PullRequestOverviewSheet` is out of scope except for a genuinely shared presentation helper that prevents duplicated check-status behavior.
- The sidebar body order is fixed: Review summary; revision/freshness and compact counts; Checks; Discussion; Review status; Merge readiness and eligible merge entry point; longer pull-request description and other secondary context.
- Summary and revision are immediately visible. Long detail remains available behind disclosures; no existing readable PR description, threads, Published feedback, check evidence, or merge evidence is deleted merely to make the sidebar compact.
- All status rows communicate meaning three ways: an explicit label, an icon, and semantic treatment. Semantic tokens are the only color source: success for passing/current/ready, warning for pending or acknowledgement, destructive for failure/blocked, and muted for skipped/unknown/unavailable. Do not add raw colors, gradients, or a new design system.
- Checks retain the existing full `CheckSummary` contract, including `required`, status/conclusion, duplicate grouping, and validated same-host external URLs. The canonical overview must not project checks down to name/status strings and then recreate a second status mapper.
- Analysis and Walkthrough remain independent Insights. The mapped-Finding count includes only current safely mapped Findings from the represented Review session. A Findings action appears only when that count is nonzero and only routes to existing current Files/Findings navigation.
- Merge readiness continues to be owned by the established policy. The renderer displays human-readable GitHub and Analysis reasons but must not show raw blocker/warning tags. The existing confirmation flow remains the only path that requests a merge.
- A blocked Review displays the merge reason once in PR Overview and does not render a second blocked merge alert. Eligible and acknowledgement-required Reviews retain method selection and explicit confirmation. Merged and closed Reviews are readable but omit unavailable refresh/merge actions.
- Refresh stays explicit. It may update represented state only through the existing action; detected updates never replace the visible content automatically.

## Current state

The following is true at the planned commit, before reconciliation of the dirty component:

- `ReviewWorkbench` creates a `CanonicalReviewOverview` from the already-rendered `WorkbenchResponse`. It has access to the full pull request summary, full `CheckSummary`, comments, Published feedback, commits, revision/freshness, Insights, and merge readiness. No domain, API, persistence, or renderer-contract field is needed for this UI pass.
- `CanonicalReviewOverviewSheet` is the active overlay for the unified Review workbench. The older `PullRequestOverviewSheet` remains a separate legacy path. Keep the redesign constrained to the canonical sheet.
- The canonical overview’s current projection reduces each check to `name`, `status`, and optional `conclusion`, losing `required` and URL data that `ReviewChecks` needs for requirement copy and safe external links. Restore the full data shape before reusing the detailed check surface.
- `ReviewChecks` already owns grouping, status priority, disclosure, required-status screen-reader text, and validated external-link actions. Its result mapping is the source of truth for individual check detail; extract only a small shared presentation helper if the sidebar summary must share it.
- The `ReviewWorkbench` already derives `analysisIsCurrent` and the list of safely mapped Findings. Use that same condition for the sidebar count and navigation; do not derive currentness from a display string.
- `MergeConfirmationDialog` intentionally renders a destructive alert when its readiness is blocked. The sidebar must avoid mounting that blocked branch after it has already rendered equivalent merge readiness evidence.
- The existing workbench-flow test opens PR Overview, proves backdrop/Escape close and focus restoration, and exercises description, Checks, threads, and Published feedback. The browser workbench test proves overlay visibility and no geometry overflow at constrained and desktop widths. Extend these seams instead of creating a mock-only UI path.

## Commands you will need

- `pnpm exec vitest run tests/renderer/review-checks.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx` — focused renderer gate; expected exit 0.
- `pnpm build` — builds Electron main, preload, and renderer; expected exit 0.
- `pnpm test:design` — deterministic visual-browser design gate; expected exit 0.
- `pnpm exec playwright test tests/browser/review-workbench.spec.ts` — browser overlay/geometry gate; expected exit 0.
- `pnpm typecheck` — expected exit 0 with no TypeScript errors.
- `pnpm lint` — expected exit 0 with no warnings or errors.
- `pnpm test -- --run` — full suite; expected exit 0.
- `git diff --check` — expected exit 0.

For live UI verification, the primary agent must delegate development Electron QA to a dedicated `$patchdesk-electron-tester` subagent. It owns the interactive evidence; renderer and browser tests do not replace it.

## Scope

### In scope

- `src/renderer/src/components/pr-overview-sheet.tsx`
  - Rebuild the canonical overview body around the selected status-led order.
  - Add compact semantic status-row and revision/count presentation while retaining all available detailed context through disclosures.
  - Restore the explicit Refresh action and render human-readable Analysis-Finding merge copy.
  - Prevent duplicate blocked merge alerts while preserving merge confirmation when eligible.
- `src/renderer/src/components/review-workbench.tsx`
  - Pass the full represented check context and the existing revision/count/Insight/current-Finding data to the canonical overview.
  - Wire a current-Findings callback that closes the overlay and navigates through the existing Files/Findings state.
- `src/renderer/src/components/review-checks.tsx`
  - Extract or expose the minimum shared typed check-result presentation needed by the summary, while preserving its existing grouping, accessible requirement text, and safe external-link behavior.
- `tests/renderer/review-checks.ui.test.tsx`
  - Cover any extracted shared status mapping through observable check labels and icons.
- `tests/renderer/review-workbench-flow.ui.test.tsx`
  - Replace obsolete canonical overview expectations with status-sidebar behavior, context preservation, refresh, navigation, and merge-state regressions.
- `tests/browser/review-workbench.spec.ts`
  - Update the PR Overview assertions and add responsive/overflow coverage for the revised overlay.
- `.agents/PLANS/README.md`
  - Track this plan as TODO initially, then update it to DONE or BLOCKED at closeout.

### Out of scope

- Domain model, service, adapter, storage, local API, desktop bridge, or GitHub query changes.
- Changing explicit refresh semantics, currentness rules, Analysis merge policy, merge readiness calculation, merge-method availability, or exact-head confirmation.
- A merge bypass, automatic merge, or GitHub write during verification.
- New icons, UI primitives, styling frameworks, theme tokens, dependencies, animations, dashboard cards, or broad legacy-sidebar redesign.
- Replacing Files, Findings, Insights, Review draft, Published feedback, or the diff surface.

## Implementation steps

### Step 1: Characterize the sidebar states at the real renderer seam

Before changing production code, extend the existing workbench-flow fixture coverage to describe the target behavior. Use the current unified Review projection, not a custom component-only object.

Add focused cases for:

1. A passing represented Review with branch/SHA/refresh context, commit/file counts, a compact successful Checks row, empty Discussion, independent `not generated` Insight rows, and ready-to-merge copy.
2. A failing/pending check case that preserves requirement metadata and its safe external check action when the Checks disclosure opens.
3. A populated discussion case that reports total and unresolved threads, then reveals threads and Published feedback without presenting that feedback as a Review draft.
4. Current Analysis plus Walkthrough, including a nonzero current mapped-Finding count and a callback action that moves the workbench to existing Findings.
5. Acknowledgement-required and blocked merge states, including a human-readable Analysis-Finding warning, no raw tags, and no duplicate blocked confirmation alert.
6. A terminal Review, where readable status remains but refresh and merge controls are absent.

Assert labels, roles, actions, and observable content. Do not assert private helper output, SVG implementation names, or Tailwind class strings.

**Verify:** `pnpm exec vitest run tests/renderer/review-workbench-flow.ui.test.tsx` — new tests should first fail against the current behavior, then pass after subsequent steps.

### Step 2: Preserve complete represented data in the canonical overview model

Update the canonical overview projection in `ReviewWorkbench` and its local type so presentation has the data it already needs:

1. Pass the full `CheckSummary`, not a reduced list. Preserve `required` and URL fields for detailed Checks.
2. Pass branch names, reviewed/current head, refresh state/time, commit count, and changed-file count as optional represented context. Use only values GitHub or the current immutable commit list already supplies.
3. Pass typed Analysis and Walkthrough state plus the count of current safely mapped Findings. Derive current Findings from the same `analysisIsCurrent` condition that powers Files navigation.
4. Pass a no-write `onViewFindings` callback. It must close PR Overview, select the existing Files/Findings surface, and must not select or expose an outdated Finding.
5. Keep the current safe pull-request reference for external navigation. Do not reconstruct GitHub URLs from display strings.

Keep the view model narrow and renderer-owned. Do not add a new renderer contract, API endpoint, or service projection for values already present in the workbench.

**Verify:** `pnpm typecheck` — expected exit 0. Then run `pnpm exec vitest run tests/renderer/review-workbench-flow.ui.test.tsx` and confirm the new characterization cases can exercise the complete represented data.

### Step 3: Make check status presentation one typed, reusable rule

Refine `ReviewChecks` and the canonical sidebar so a check has one outcome classification rather than two independently maintained mappings.

1. Keep the existing check detail result categories: passed, failed, pending, skipped/other, and unknown.
2. Expose a small typed presentation boundary suitable for the compact sidebar summary: explicit label, semantic treatment, and icon component. Do not expose Tailwind strings from a domain helper or accept arbitrary status strings.
3. Use that same classification in the detailed check rows, preserving required-status screen-reader copy, duplicate grouping, disclosure behavior, and the safe external-link button.
4. In the canonical sidebar, render a compact status row with the result icon, explicit summary text, and a disclosure for detailed `ReviewChecks`. Passing status must not be communicated by green alone; failure/pending status must remain readable without icon recognition.
5. Use existing semantic token classes and installed Lucide icons. Icons inside a `Button` follow the project’s `data-icon` rule; decorative icons are `aria-hidden`.

**Verify:** `pnpm exec vitest run tests/renderer/review-checks.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx` — expected exit 0, with existing duplicate-grouping and safe-link assertions retained.

### Step 4: Compose the status-led canonical PR Overview

Rebuild the body of `CanonicalReviewOverviewSheet` around the specified hierarchy while retaining details:

1. Keep the sticky header and PR identity. Render Review summary first; use the existing retained-Analysis fallback verbatim when no Analysis result exists.
2. Render a compact Revision section with base, head, shortened reviewed SHA, current-head/freshness state when it differs, refresh timestamp, and commit/file counts. Render `Refresh GitHub state` through the existing `onRefresh` callback for active Reviews only.
3. Add visual separators and dense status rows rather than cards for every block. Each row should have a status icon, title, explanatory text/count, and a disclosure affordance only when there is detail to reveal.
4. Render Discussion with an explicit `N threads, M unresolved` summary, supporting incomplete-count wording, and disclosures for existing threads and Published feedback. Preserve the existing read-only Published feedback detail.
5. Render Review status with separate Analysis and Walkthrough rows and their typed state labels. Show mapped Findings only when Analysis is current; show the count and `View findings` only when it can navigate to current evidence.
6. Render Merge readiness with success, warning, destructive, or muted treatment. Include available human-readable GitHub evidence, Analysis warnings, source/availability context when helpful, and safe `Open on GitHub` actions for incomplete evidence. Add explicit friendly copy for `analysis_finding` instead of falling through to a generic warning.
7. Preserve the merge method and confirmation entry point only for an active Review whose readiness is not blocked. Do not mount the blocked branch of `MergeConfirmationDialog` after the sidebar has stated the block. Keep acknowledgement-required confirmation unchanged.
8. Put longer PR description and any remaining secondary context after merge readiness in a disclosure. Do not delete existing material simply because it is below the fold.
9. For merged or closed Reviews, retain the status/readability treatment and remove Refresh/merge controls.

Use the installed `Collapsible`, `Separator`, `Badge`, `Alert`, `Button`, and `Sheet` primitives before creating custom markup. Use `flex flex-col gap-*`, `size-*`, `truncate`, and `cn()` in accordance with the renderer’s shadcn/Base UI conventions.

**Verify:** `pnpm exec vitest run tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-checks.ui.test.tsx` — expected exit 0. Manually inspect the deterministic design route only after focused tests pass; do not use it as a substitute for the renderer assertions.

### Step 5: Preserve overlay accessibility and responsive geometry

Update existing browser coverage for the new hierarchy, then add only behavioral layout proof:

1. The PR Overview dialog opens over a visible Review workbench; checks, discussion, Review status, and merge readiness are reachable by accessible names.
2. Escape and backdrop close continue to return focus to the trigger.
3. At 960px, 1280px, and 1440px widths, opening and expanding the sidebar does not create horizontal viewport overflow or resize the diff’s closed-state layout.
4. The sheet owns its vertical scrolling. Long descriptions and discussion remain reachable without a page-level vertical overflow.
5. A representative blocked state shows one merge-ready explanation and no interactive merge confirmation control; an acknowledgement-required state reaches the existing confirmation dialog.

Use the deterministic renderer fixtures. Do not send a GitHub request, invoke a model, or rely on live remote state.

**Verify:** `pnpm build && pnpm exec playwright test tests/browser/review-workbench.spec.ts` — expected exit 0.

### Step 6: Complete static gates and delegated Electron QA

Run the complete static sequence in this order:

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test -- --run`
4. `pnpm build`
5. `pnpm test:design`
6. `git diff --check`

Then delegate live development-app QA to a dedicated `$patchdesk-electron-tester` subagent. Use an isolated profile and deterministic fixture route. The tester must inspect the open sidebar in passing, blocked, and acknowledgement-required states and record:

- desktop screenshots at 1280px and 1440px plus a constrained-width screenshot;
- visible text plus icon redundancy for each status family;
- keyboard disclosure operation, focus trap, Escape/backdrop close, and trigger focus return;
- independent sidebar scrolling and no viewport overflow;
- safe external-link intent only, no GitHub/model writes;
- browser console and page-error results.

If live QA finds clipped controls, status communicated only by color, focus regression, or viewport overflow, stop and fix the focused renderer/browser regression before claiming completion.

## Test plan

- **Primary seam:** `ReviewWorkbenchFlow` with deterministic unified Review fixtures. Verify user-observable summary, represented revision, checks, discussion, Insights, Findings navigation, merge copy/action availability, refresh, terminal treatment, and overlay accessibility.
- **Shared check seam:** retain and extend `ReviewChecks` tests for grouped detail, required metadata, status labels, and validated external link behavior.
- **Browser seam:** use the real renderer route to prove Sheet behavior, focus, independent scroll, action reachability, and geometry at constrained and desktop widths.
- **Live seam:** a dedicated Electron tester validates the actual development surface. Unit, renderer, and browser tests cannot stand in for that proof.

## Done criteria

- [ ] Canonical PR Overview leads with Review summary and represented revision context, then Checks, Discussion, Review status, merge readiness, and secondary detail.
- [ ] Base/head, SHA, freshness/refresh timestamp, commits, and changed-file count use only represented data and handle absence truthfully.
- [ ] Refresh is available for an active Review and remains absent for a terminal Review.
- [ ] Checks use one typed result classification, retain required metadata and safe check URLs, and communicate every status with icon plus text.
- [ ] Discussion reports total/unresolved counts and retains readable threads and Published feedback.
- [ ] Analysis and Walkthrough display independent status. Mapped Findings count/actions exist only for current safely mapped evidence.
- [ ] Merge readiness uses friendly reason copy, including Analysis-Finding policy warnings, never raw tags; blocked state has no duplicate merge alert.
- [ ] Merge confirmation, acknowledgement, exact-head safety, and terminal-action removal remain unchanged.
- [ ] PR Overview still traps focus, closes through every existing method, restores trigger focus, overlays rather than resizes the workbench, and scrolls independently.
- [ ] Focused renderer tests, browser overlay tests, design gate, typecheck, lint, full suite, build, and diff check pass.
- [ ] Dedicated Electron QA supplies screenshots and a clean console/page-error report without GitHub or model writes.
- [ ] `.agents/PLANS/README.md` records this plan as DONE or BLOCKED with the actual verification/blocker.

## STOP conditions

Stop and report rather than improvising if:

- The dirty PR Overview change cannot be reconciled without deleting intentional behavior or overlapping another agent’s work.
- Complete check detail cannot be restored without changing the renderer contract, GitHub adapter, or validated external-link boundary.
- Current mapped-Finding navigation requires a new API, navigation state owner, or access to outdated Analysis evidence.
- A visual change would alter explicit refresh, merge-readiness calculation, merge confirmation, or any GitHub write gate.
- A blocked merge cannot be rendered once without changing the existing merge dialog’s safety behavior; preserve safety and report the composition conflict.
- Focus trapping, Escape/backdrop close, trigger restoration, or semantic labels regress in existing overlay tests.
- The browser or live surface shows horizontal viewport overflow, a non-scrollable long sidebar, hidden merge controls, console/page errors, or a status that relies on color alone.
- Full-suite failures are unrelated to this scope or are not reproducible in the focused test set.

## Maintenance notes

- Keep typed state classification renderer-local and close to its existing consumer. Do not turn semantic color/icon choices into domain fields.
- If a later feature adds an Insight type, extend the Review-status presentation through a typed status row; do not add a new Review workbench mode.
- If GitHub exposes new merge reasons, add safe human-readable mapping and tests before displaying the raw value.
- The sheet must remain an inspection surface. Any future action that writes to GitHub needs the existing explicit confirmation and freshness/ownership gates; do not add a shortcut because the status row is visually prominent.
