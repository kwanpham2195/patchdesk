# Unified Review Workbench UI Implementation Plan (Archived)

> Completed and archived on 2026-08-03. Do not execute this plan. Use the
> current [combined repair ExecPlan](../2026-08-03-unified-review-spec-and-design-repair.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prepared and completed renderer branches with one diff-first Review workbench containing Files, Findings, Commits, Insights navigation, the PR Overview overlay, and a persistent Review draft slot.

**Architecture:** One `ReviewWorkbenchFlow` owns loopback calls and canonical projection replacement. One `ReviewWorkbench` owns durable view state. Files stays mounted while Insights is selected so diff state, scroll, hydration, and selection survive Insight changes.

**Tech Stack:** React 19, TypeScript, Base UI through existing shadcn/ui components, Pierre diffs, Vitest Testing Library, Playwright.

## Dependencies

Complete [Unified Review Foundation](2026-08-01-unified-review-foundation.md) first. This plan consumes:

- `WorkbenchResponse` with `state: "review"`
- stable `review.id`
- `POST /v1/reviews/load`
- `POST /v1/reviews/detect-updates`
- `POST /v1/reviews/refresh`
- `POST /v1/reviews/commit-diff`
- current Mapped Findings from `insights.analysis.retained`

## Authority and reuse constraints

- The product specification and ADRs are authoritative for behavior, copy, state, and accessibility. The design documents below guide layout and composition only when they agree. Text, labels, and behavior inside screenshots or generated images are not requirements.
- Inspect `components.json` and `src/renderer/src/components/ui/` before renderer work. Compose installed shadcn components on Base UI with their built-in variants and Base UI `render`; do not hand-roll equivalent tabs, sheets, dialogs, confirmations, collapsibles, scroll areas, focus traps, status primitives, or loading states.
- Reuse `ReviewDiffView`, `PierreFileTree`, `useReviewDiffHydration`, and existing diff-data helpers. These remain the rendering and navigation seams for full, commit-scoped, and Finding-focused patches.
- Keep Pierre responsible for diff/tree rendering and navigation through the existing wrappers around `CodeView`, `FileDiff`, `PatchDiff`, `CodeView.getTopForItem`, `FileTree`/`useFileTree`, `selectOnlyPath`, and `scrollToPath`. Do not inspect Pierre DOM, add another scroll synchronization loop, build another file tree, or introduce another diff renderer.
- At plan time the installed versions are `@pierre/diffs@1.2.12`, `@pierre/trees@1.0.0-beta.5`, and `@base-ui/react@1.6.0`. Recheck installed types before implementation. If an existing seam lacks a required capability, document the exact gap and update this plan before custom code or a new dependency.

## Directional visual references

Use these to understand the intended composition after reading the specification. Ignore raster text or behavior that is absent from or conflicts with the specification and ADRs.

- [UI design reference](../../design/design.md)
- [Current UI inventory](../../design/current-ui-inventory.md)
- [Diff-first default](../../design/concepts/01-diff-first.png)
- [Expanded Review draft](../../design/concepts/02-expanded-review-draft.png)
- [Finding focus](../../design/concepts/03-findings-focus.png)
- [PR Overview overlay](../../design/concepts/04-pr-overview-overlay.png)
- [Insights overview](../../design/insights-exploration/04-refined-insight-navigator-overview.png)
- [Commit-specific diff](../../design/commit-states/01-selected-commit.png)

## Current renderer map

- `AppShell` branches on workbench destination and delegates to inbox-owned prepared/completed flows.
- `PreparedReviewFlow` owns model catalog, Analysis start/reconnect, refresh, batch writes, and merge.
- `CompletedReviewFlow` duplicates refresh, batch writes, merge, and Walkthrough wiring.
- `CompletedReviewWorkbench` owns result navigation, Finding focus, PR Overview, Walkthrough takeover, draft actions, and merge UI in one large component.
- `DiffWorkbench` is the prepared-state diff surface.
- `ReviewDiffView` and `useReviewDiffHydration` are the reusable current Pierre diff renderer and immutable-source hydration seam.
- `PierreFileTree` is the reusable file tree. Its wrapper already owns passive selection and reveal through guarded `selectOnlyPath` and `scrollToPath` calls.
- `PullRequestOverviewSheet` already uses the correct right-side sheet primitive and owns checks, threads, local review, and merge.
- The installed shadcn/Base UI set already includes `Tabs`, `Sheet`, `Dialog`, `AlertDialog`, `Collapsible`, `ScrollArea`, `Button`, `Badge`, `Alert`, `Separator`, `Skeleton`, `Spinner`, and the required form controls.
- `routes.ts` keys the workbench by session ID and optional initial section.

## Target component tree

```text
AppShell
  ReviewWorkbenchFlow
    ReviewWorkbench
      ReviewHeader
      Tabs: Files | Insights
      FilesSurface (kept mounted)
        ReviewNavigator
          FilesNavigator
          FindingsNavigator
          CommitsNavigator
        ReviewDiffView
      InsightsWorkbench
      ReviewDraftDockSlot
      PullRequestOverviewSheet
```

The Insights and Review draft internals are supplied by the later plans. This plan creates stable typed slots and fixture states so the shell can ship independently.

## Exact renderer state

```ts
export type ReviewPrimarySurface = "files" | "insights";
export type ReviewNavigatorMode = "files" | "findings" | "commits";

export type ReviewWorkbenchViewState = {
  readonly primarySurface: ReviewPrimarySurface;
  readonly navigatorMode: ReviewNavigatorMode;
  readonly selectedFile?: string;
  readonly selectedFindingId?: string;
  readonly selectedCommitSha?: string;
  readonly prOverviewOpen: boolean;
  readonly draftExpanded: boolean;
};
```

Do not persist `selectedCommitSha`. Reopening Commits always selects the newest commit. Primary surface, file selection, and diff preferences may retain their existing renderer-local behavior.

## Exact component boundary

```ts
export type ReviewWorkbenchActions = {
  readonly detectUpdates: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly loadCommitDiff: (sha: string) => Promise<CommitDiffProjection>;
  readonly reportNavigationState: (
    state: "clear" | "dirty_draft" | "write_pending",
  ) => void;
};

export type ReviewWorkbenchSlots = {
  readonly insights: React.ReactNode;
  readonly draftDock: React.ReactNode;
  readonly publishedFeedback: React.ReactNode;
  readonly mergeAction: React.ReactNode;
};

export function ReviewWorkbench(props: {
  readonly model: WorkbenchResponse;
  readonly actions: ReviewWorkbenchActions;
  readonly slots: ReviewWorkbenchSlots;
}): React.JSX.Element;
```

Later plans compose typed controllers into these four slots. This plan has no model-run, GitHub-write, draft-mutation, or merge interface, so the shell can be implemented and tested without fake no-op business actions.

## Task 1: Add the stable Review route and single flow

**Files:**

- Create: `src/renderer/src/flows/review-workbench-flow.tsx`
- Modify: `src/renderer/src/routes.ts`
- Modify: `src/renderer/src/components/app-shell.tsx`
- Modify: `src/renderer/src/flows/inbox-flow.tsx`
- Modify: `src/renderer/src/app.tsx`
- Modify: `tests/renderer/review-workbench.ui.test.tsx`

**Produces:** one API owner keyed by stable Review ID.

- [ ] Change the route contract:

```ts
export type AppDestination =
  | { readonly kind: "dashboard" }
  | { readonly kind: "workbench"; readonly reviewId: string };

export function destinationKey(destination: AppDestination): string {
  return destination.kind === "workbench"
    ? `workbench:${destination.reviewId}`
    : "dashboard";
}
```

- [ ] Update inbox/open-saved-review navigation. `POST /v1/reviews/open` returns the stable Review projection; navigate with `projection.review.id`. Loading an old session first resolves its stable Review through the foundation controller.

- [ ] Write a flow test that renders a Review, applies a new-session refresh projection, and proves the React destination key remains unchanged.

```tsx
expect(destinationKey(beforeDestination)).toBe(
  destinationKey(afterDestination),
);
expect(afterProjection.session.id).not.toBe(beforeProjection.session.id);
```

- [ ] Implement `ReviewWorkbenchFlow` with one canonical `workbench` state. `detectUpdates()` patches only `revision.freshness` to `updates_available`; `refresh()` replaces the whole projection from the authoritative response.

- [ ] Remove `PreparedReviewFlow` and `CompletedReviewFlow` references from `AppShell`. Do not delete their files until Task 5 moves every remaining behavior.

- [ ] Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx`

Expected: PASS with one stable Review destination.

- [ ] Commit:

```bash
git add src/renderer/src/flows/review-workbench-flow.tsx src/renderer/src/routes.ts src/renderer/src/components/app-shell.tsx src/renderer/src/flows/inbox-flow.tsx src/renderer/src/app.tsx tests/renderer/review-workbench.ui.test.tsx
git commit -m "refactor: route one review workbench"
```

## Task 2: Build the persistent shell and header

**Files:**

- Create: `src/renderer/src/components/review-workbench.tsx`
- Create: `src/renderer/src/components/review-header.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `tests/renderer/review-workbench.ui.test.tsx`
- Modify: `tests/renderer/docked-diff-state.ui.test.tsx`

**Produces:** diff-first shell with Files and Insights semantic tabs.

- [ ] Add a fixture builder in the renderer test:

```ts
function reviewWorkbenchFixture(
  patch: Partial<WorkbenchResponse> = {},
): WorkbenchResponse {
  return {
    state: "review",
    review: {
      id: "github.com__centraldigital__patchdesk__pr-42__abc123",
      status: "open",
    },
    session: fixtureSession,
    revision: {
      reviewedHeadSha: "1".repeat(40),
      currentHeadSha: "1".repeat(40),
      freshness: "fresh",
      refreshedAt: "2026-08-01T00:00:00.000Z",
    },
    fullPatch: fixturePatch,
    commits: [],
    insights: {
      analysis: { status: "not_generated" },
      walkthrough: { status: "not_generated" },
    },
    publishedFeedback: { reviews: [], comments: [], complete: true },
    comments: { threads: [], complete: true },
    checks: { overall: "passing", checks: [] },
    mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
    ...patch,
  };
}
```

- [ ] Write tests for Files default, semantic tab roles, stable Files mount while Insights is selected, preserved file selection after Insight status rerender, and no focus theft on background progress.

- [ ] Implement `ReviewHeader` with PR number/title, repository, base/head branches, short head SHA, last refreshed time, checks summary, `Updates available`, Refresh action, and `PR overview` trigger.

- [ ] Show Refresh as primary only for `updates_available`. Keep it available but secondary for explicit manual refresh in other open states. Remove it for terminal Reviews.

- [ ] Use the installed shadcn/Base UI `Tabs`, `TabsList`, `TabsTrigger`, and `TabsContent` for Files and Insights. Set `keepMounted` on both `TabsContent` panels so the diff does not remount when the active surface changes.

- [ ] Use the same installed Tabs primitive for primary and navigator controls so Base UI owns keyboard behavior. Expose freshness, checks, Finding disposition, draft attention, and merge readiness through visible text plus icons; color is never the only signal.

- [ ] Add one bounded polite live region for meaningful Review status changes. Announce update detection, refresh completion/failure, and terminal state without moving focus or replacing the active panel.

- [ ] At 1280px, allow navigator collapse before reducing code readability. At 1440px, target a 300–320px navigator. Prevent viewport-level horizontal overflow.

- [ ] Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/renderer/docked-diff-state.ui.test.tsx`

Expected: PASS.

- [ ] Commit:

```bash
git add src/renderer/src/components/review-workbench.tsx src/renderer/src/components/review-header.tsx src/renderer/src/styles.css tests/renderer/review-workbench.ui.test.tsx tests/renderer/docked-diff-state.ui.test.tsx
git commit -m "feat: add persistent review shell"
```

## Task 3: Implement Files, Findings, and Commits

**Files:**

- Create: `src/renderer/src/components/review-navigator.tsx`
- Create: `src/renderer/src/hooks/use-commit-diff.ts`
- Modify: `src/renderer/src/components/review-workbench.tsx`
- Modify: `src/renderer/src/components/review-diff-view.tsx`
- Modify: `src/renderer/src/review-diff-data.ts`
- Modify: `tests/renderer/review-workbench.ui.test.tsx`
- Modify: `tests/renderer/review-diff-view.ui.test.tsx`
- Modify: `tests/renderer/review-diff-data.test.ts`

**Produces:** the complete Files surface navigation contract.

- [ ] Write tests with two commits and two Findings: one current Mapped Finding and one unmapped/outdated Finding. Assert only the current Mapped Finding appears.

- [ ] Implement Files navigator by composing the existing `PierreFileTree` and its search behavior with the full PR patch rendered by `ReviewDiffView`. Do not create a second tree, raw file list, or diff surface.

- [ ] Implement Findings navigator rows showing severity, title, file, line, and disposition. Selection must clear commit scope, show the full PR patch, and focus the exact mapped range.

- [ ] Implement dense Commits rows newest first with subject, author, short SHA, relative time, and one HEAD badge. Opening Commits selects index zero. Switching away clears commit selection.

- [ ] When a commit is selected, replace the central diff header with commit subject, author, full SHA copy action, timestamp, and `<position> of <total>`. Pass the commit patch into the existing `ReviewDiffView`; do not create a commit-specific renderer.

- [ ] Implement late-safe commit loading:

```ts
export type CommitDiffState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading"; readonly sha: string }
  | { readonly _tag: "Ready"; readonly projection: CommitDiffProjection }
  | { readonly _tag: "Failed"; readonly sha: string };
```

Use a monotonically increasing request token. Ignore responses whose token or selected SHA no longer matches.

- [ ] Do not add an `All changes` row. Files itself restores the full PR patch.

- [ ] For commit diff inline authoring, call the existing patch mapper against the current full PR patch. Hide the comment affordance unless exactly one current coordinate maps.

- [ ] Preserve the current Pierre ownership boundaries: `ReviewDiffView` remains the only `CodeView` integration, and `PierreFileTree` remains the only `FileTree` integration. Findings and Commits change selection and patch inputs only.

- [ ] Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx tests/renderer/review-diff-data.test.ts`

Expected: PASS for selection, scope restoration, late suppression, Finding filtering, and safe authoring.

- [ ] Commit:

```bash
git add src/renderer/src/components/review-navigator.tsx src/renderer/src/hooks/use-commit-diff.ts src/renderer/src/components/review-workbench.tsx src/renderer/src/components/review-diff-view.tsx src/renderer/src/review-diff-data.ts tests/renderer/review-workbench.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx tests/renderer/review-diff-data.test.ts
git commit -m "feat: add review navigator"
```

## Task 4: Finalize the PR Overview overlay

**Files:**

- Modify: `src/renderer/src/components/pr-overview-sheet.tsx`
- Modify: `src/renderer/src/components/review-workbench.tsx`
- Modify: `src/renderer/src/components/review-checks.tsx`
- Modify: `tests/renderer/review-workbench.ui.test.tsx`

**Produces:** one on-demand PR context and merge surface.

- [ ] Write tests for open/close control, Escape, backdrop close, focus trap, focus restoration to `PR overview`, independent body scroll, and no workbench resize.

- [ ] Use the existing shadcn/Base UI `Sheet`, including `SheetTitle`. Let the primitive own the backdrop, focus trap, Escape behavior, restoration, and stacking; do not add custom overlay or z-index code. Set content to approximately 370px at 1440px and `max-w-[calc(100vw-24px)]` at constrained widths.

- [ ] Keep this content order: Description, Summary/change context, Checks, Existing threads, Published feedback slot, Merge readiness, warnings, merge action.

- [ ] Remove local Review draft editing from the sheet. The feedback plan owns one bottom dock.

- [ ] For terminal Reviews, keep description, checks, threads, Published feedback, and terminal state readable. Remove refresh/write/merge actions.

- [ ] Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/renderer/merge-confirmation-dialog.ui.test.tsx`

Expected: PASS.

- [ ] Commit:

```bash
git add src/renderer/src/components/pr-overview-sheet.tsx src/renderer/src/components/review-workbench.tsx src/renderer/src/components/review-checks.tsx tests/renderer/review-workbench.ui.test.tsx tests/renderer/merge-confirmation-dialog.ui.test.tsx
git commit -m "feat: refine pr overview overlay"
```

## Task 5: Delete the old renderer branches

**Files:**

- Delete: `src/renderer/src/flows/prepared-review-flow.tsx`
- Delete: `src/renderer/src/flows/completed-review-flow.tsx`
- Delete: `src/renderer/src/components/completed-review-workbench.tsx`
- Modify: `src/renderer/src/components/diff-workbench.tsx`
- Modify: `src/renderer/src/review-copy.ts`
- Modify: `tests/renderer/review-workbench.ui.test.tsx`
- Modify: `tests/browser/review-workbench.spec.ts`

**Produces:** no prepared/completed/manual/model/read-only workbench implementation or copy.

- [ ] Move any still-used small helper into `review-workbench.tsx`, `review-navigator.tsx`, or a focused existing module. Do not keep compatibility exports for deleted private renderer components.

- [ ] Keep `DiffWorkbench` only if it is still a focused reusable diff component. Otherwise move its reusable behavior into `ReviewWorkbench` and delete it too.

- [ ] Replace copy:

```text
Run local review                 -> Run Analysis
Generate a read-only walkthrough -> Generate Walkthrough
Open saved review               -> Open Review
No local Patchdesk review       -> Analysis has not been generated
```

- [ ] Run: `rg -n 'PreparedReviewFlow|CompletedReviewFlow|CompletedReviewWorkbench|review_started|read-only review|read-only walkthrough' src/renderer tests/renderer tests/browser`

Expected: no product implementation or copy matches.

- [ ] Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/renderer/docked-diff-state.ui.test.tsx`

- [ ] Run: `pnpm exec playwright test tests/browser/review-workbench.spec.ts`

Expected: PASS.

- [ ] Commit explicit deletions:

```bash
git add src/renderer/src/components/diff-workbench.tsx src/renderer/src/review-copy.ts tests/renderer/review-workbench.ui.test.tsx tests/browser/review-workbench.spec.ts
git add -u src/renderer/src/flows/prepared-review-flow.tsx src/renderer/src/flows/completed-review-flow.tsx src/renderer/src/components/completed-review-workbench.tsx
git commit -m "refactor: remove legacy review modes"
```

## Task 6: UI verification

- [ ] Run: `pnpm lint`
- [ ] Run: `pnpm typecheck`
- [ ] Run: `pnpm test -- --run tests/renderer/review-workbench.ui.test.tsx tests/renderer/docked-diff-state.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx tests/renderer/review-diff-data.test.ts tests/renderer/merge-confirmation-dialog.ui.test.tsx`
- [ ] Run: `pnpm build`
- [ ] Run: `pnpm exec playwright test tests/browser/review-workbench.spec.ts`
- [ ] Run: `git diff --check`

- [ ] Preserve the existing large-diff and streaming performance assertions. Do not raise their thresholds or skip them because the unified shell is slower locally.

- [ ] Review the final renderer imports and component tree. Every diff/tree surface must flow through the existing Pierre wrappers, and every common interaction primitive must use an installed shadcn/Base UI component unless this plan records an approved capability gap.

For live Electron verification, the primary agent must spawn a dedicated tester subagent and direct it to use `$patchdesk-electron-tester`. Verify Files, Findings, Commits, PR Overview, 1280px/1440px layout, keyboard navigation, focus restoration, and diff-state persistence.

## Handoff to later plans

- Insights plan fills `InsightsWorkbench` with Analysis and Walkthrough.
- Feedback plan fills the bottom dock, publication modal, Published feedback, and merge actions.
