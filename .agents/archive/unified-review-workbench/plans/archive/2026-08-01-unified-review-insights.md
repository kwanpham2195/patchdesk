# Unified Review Insights Implementation Plan (Archived)

> Completed and archived on 2026-08-03. Do not execute this plan. Use the
> current [combined repair ExecPlan](../2026-08-03-unified-review-spec-and-design-repair.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Analysis and Walkthrough independent, durable, cancellable ways to understand the current Review revision while preserving the last successful result until a replacement succeeds.

**Architecture:** `InsightStore` owns one retained record and at most one active run per `(Review, Insight type)`. Analysis keeps the existing finite Flue workflow and four immutable inspection tools; Walkthrough keeps its tool-free bounded workflow. A run writes only a candidate record. Under a per-Insight lock, the coordinator verifies run token, current Review session, head SHA, and patch hash before atomically replacing the retained record. A failed, cancelled, stale, or superseded candidate never removes the prior result.

**Tech Stack:** TypeScript, Valibot, JSON-file storage, Hono loopback API, Flue, React 19, Base UI through existing shadcn/ui components, Vitest Testing Library.

## Dependencies

Complete these plans first:

- [Unified Review Foundation](2026-08-01-unified-review-foundation.md)
- [Unified Review Workbench UI](2026-08-01-unified-review-ui.md)

This plan consumes stable `ReviewId`, the current immutable Review session, `InsightProjection<T>`, one Review projection, and the `insights` shell slot. It does not implement draft publication, Published feedback, or merge policy; those belong to the feedback plan.

## Authority and reuse constraints

- The product specification and ADRs are authoritative. Design documents guide composition only when they agree; text and behavior shown inside images are directional.
- Use installed shadcn/Base UI components for cards, tabs, controls, selection, alerts, progress, loading, collapsibles, and scroll behavior. Use existing variants and Base UI `render` before custom markup or interaction code.
- Reuse `NarrativeWalkthroughDiff`, `ReviewDiffView`, `useReviewDiffHydration`, and the current diff-data helpers for related hunks and code navigation. Do not render raw code blocks as a substitute, inspect Pierre DOM, or add another diff/hunk renderer.
- Extend the existing Flue workflow, inspector, runner, completion, coordinator, storage, and loopback seams. A custom renderer, UI primitive, or parallel lifecycle owner requires an exact capability gap and a plan update before code.

## Required context

Read these files before editing:

- [Product specification](../../spec.md)
- [No-regression contract](../../research/02-research-core-no-regression-contract.md)
- [UI design reference](../../design/design.md)
- [Model authority ADR](../../../../../docs/adr/0013-keep-model-runs-bounded-and-non-authoritative.md)
- `src/workflows/review-pr.ts`
- `src/workflows/generate-walkthrough.ts`
- `src/services/review-rubric.ts`
- `src/services/model-review-runner.ts`
- `src/services/review-inspector.ts`
- `src/services/review-inspector-tools.ts`
- `src/services/review-execution-service.ts`
- `src/services/review-completion-service.ts`
- `src/services/review-run-coordinator.ts`
- `src/services/narrative-walkthrough-service.ts`
- `src/services/flue-cli-review-invoker.ts`
- `src/services/flue-cli-walkthrough-invoker.ts`

## Existing model boundary to preserve

- Trusted Patchdesk policy precedes repository-authored criteria and prepared evidence. Repository text remains untrusted evidence, never instructions.
- Analysis receives one prepared context, one immutable patch, and exactly four tools: `list_changed_files`, `search_files`, `read_file_range`, and `git_show`.
- Analysis snapshots regular Git blobs only, at most 512 KiB per file and 4 MiB total. It has no shell, checkout mutation, credentials, GitHub writer, thread writer, publication, or merge capability.
- Walkthrough reads only the prepared context and patch, uses no tools, accepts at most 512 KiB of context and 2 MiB of patch, and validates bounded structured output.
- Both workflows use the model and reasoning level selected from the runtime catalog. Exact prompt prose and defaults are tuning details, not persisted product contracts.
- Patchdesk validates output, maps Findings, decides freshness and replacement, and owns every draft, publication, and merge decision.

## Exact durable contracts

Create `src/domain/insight-record.ts`:

```ts
export type InsightType = "analysis" | "walkthrough";

export type InsightRevision = {
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly patchHash: ContentHash;
};

export type InsightRun = {
  readonly id: InsightRunId;
  readonly type: InsightType;
  readonly revision: InsightRevision;
  readonly token: number;
  readonly model: string;
  readonly reasoning: "low" | "medium" | "high";
  readonly status: "queued" | "running" | "cancelling";
  readonly startedAt: IsoTimestamp;
};

export type RetainedAnalysis = {
  readonly runId: InsightRunId;
  readonly revision: InsightRevision;
  readonly generatedAt: IsoTimestamp;
  readonly result: ReviewResult;
  readonly dismissals: ReadonlyArray<{
    readonly findingId: FindingId;
    readonly reason: string;
    readonly dismissedAt: IsoTimestamp;
  }>;
};

export type RetainedWalkthrough = {
  readonly runId: InsightRunId;
  readonly revision: InsightRevision;
  readonly generatedAt: IsoTimestamp;
  readonly result: NarrativeWalkthrough;
  readonly readingProgress: {
    readonly readSectionIds: ReadonlyArray<string>;
  };
};

export type InsightFailure = {
  readonly runId: InsightRunId;
  readonly reason: "cancelled" | "failed" | "invalid_result" | "superseded";
  readonly incidentId?: string;
  readonly retryable: boolean;
  readonly failedAt: IsoTimestamp;
};

export type InsightRecord<T> = {
  readonly schemaVersion: 1;
  readonly reviewId: ReviewId;
  readonly type: InsightType;
  readonly nextToken: number;
  readonly retained?: T;
  readonly activeRun?: InsightRun;
  readonly replacementFailure?: InsightFailure;
  readonly updatedAt: IsoTimestamp;
};
```

Store the records at:

```text
data/profiles/<profile-id>/workbenches/<review-id>/insights/analysis.json
data/profiles/<profile-id>/workbenches/<review-id>/insights/walkthrough.json
```

`InsightRunId` is generated from Review ID, type, token, and revision. `nextToken` is monotonic. A later token always wins even if an earlier process finishes later.

## Exact run and completion contracts

```ts
export type AnalysisCompletionAction =
  | { readonly _tag: "SaveAsReviewDraft" }
  | { readonly _tag: "OpenPreviewWhenComplete" };

export type StartInsightRequest = {
  readonly profileId: string;
  readonly reviewId: string;
  readonly model: string;
  readonly reasoning: "low" | "medium" | "high";
  readonly completionAction?: AnalysisCompletionAction;
};

export type CancelInsightRequest = {
  readonly profileId: string;
  readonly reviewId: string;
  readonly runId: string;
};

export type InsightRunResponse = {
  readonly runId: string;
  readonly type: InsightType;
  readonly status:
    "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
};
```

Only Analysis accepts `completionAction`. The feedback plan implements `SaveAsReviewDraft` and adds `PublishWhenComplete` after it introduces draft merging and durable publication authorization. This plan records the choice but does not mutate a draft or call GitHub.

## Task 1: Add strict Insight storage and lifecycle transitions

**Files:**

- Create: `src/domain/insight-record.ts`
- Create: `src/adapters/storage/insight-store.ts`
- Modify: `src/domain/ids.ts`
- Modify: `src/adapters/storage/patchdesk-paths.ts`
- Create: `tests/domain/insight-record.test.ts`
- Create: `tests/storage/insight-store.test.ts`

**Produces:** durable one-result/one-active-run records with transactional replacement.

- [ ] Write failing tests for an empty record, first run, same-type concurrency rejection, different-type concurrency, retained-result preservation during replacement, success replacement, failure preservation, cancellation preservation, late-result suppression, malformed JSON rejection, and cross-Review path rejection.

- [ ] Implement these pure transitions:

```ts
beginInsightRun(record, input): Result<InsightRecord<unknown>, "already_running">;
requestInsightCancellation(record, runId, at): Result<InsightRecord<unknown>, "not_active">;
completeInsightRun(record, runId, retained, at): Result<InsightRecord<unknown>, "superseded">;
failInsightRun(record, runId, failure, at): Result<InsightRecord<unknown>, "superseded">;
```

`completeInsightRun()` clears `replacementFailure`; `failInsightRun()` clears only `activeRun` and leaves `retained` byte-for-byte unchanged.

- [ ] Implement `InsightStore.load/save/mutate()` with strict Valibot parsing, atomic JSON writes, and a per `(profileId, reviewId, type)` promise lock. The store must reload after every successful save before returning.

- [ ] Run: `pnpm test -- --run tests/domain/insight-record.test.ts tests/storage/insight-store.test.ts`

Expected: PASS.

- [ ] Commit:

```bash
git add src/domain/ids.ts src/domain/insight-record.ts src/adapters/storage/patchdesk-paths.ts src/adapters/storage/insight-store.ts tests/domain/insight-record.test.ts tests/storage/insight-store.test.ts
git commit -m "feat: persist review insights"
```

## Task 2: Enforce the Analysis authority and inspection budget

**Files:**

- Modify: `src/services/review-inspector.ts`
- Modify: `src/services/review-inspector-tools.ts`
- Modify: `src/services/model-review-runner.ts`
- Modify: `src/services/review-rubric.ts`
- Modify: `src/workflows/review-pr.ts`
- Modify: `tests/services/review-inspector.test.ts`
- Modify: `tests/services/review-inspector-tools.test.ts`
- Modify: `tests/services/model-review-runner.test.ts`
- Modify: `tests/services/review-rubric.test.ts`

**Produces:** the prompt's eight-call limit as a runtime invariant, not a request to the model.

- [ ] Add one budget shared by all four tool methods:

```ts
export const MAX_ANALYSIS_INSPECTION_CALLS = 8;

export type InspectorDenied = {
  readonly _tag: "InspectorDenied";
  readonly reason: "invalid_input" | "outside_snapshot" | "budget_exhausted";
};
```

Every attempted tool call, including `listChangedFiles()`, consumes one unit. The ninth and later calls return `budget_exhausted` without reading a file or invoking Git. The model-facing tool output remains `{ denied: true }`; the reason stays main-process-only.

- [ ] Prove the four-tool set by exact names and prove there is no generic command, write, network, GitHub, publication, or merge tool.

- [ ] Prove trusted policy appears before labeled untrusted repository criteria and prepared evidence. Add adversarial fixtures whose `AGENTS.md`, diff, and source text ask the model to ignore Patchdesk policy or publish to GitHub; assert they remain quoted evidence and do not alter the tool set.

- [ ] Preserve the existing snapshot caps and strict `modelReviewResultSchema`. Add tests for oversized file omission, total-cap cutoff, symlink/path escape denial, invalid revision denial, and schema rejection.

- [ ] Preserve incremental Analysis binding to exact base/head comparison, incremental patch, and tokenized prior-Finding evidence. Prove `resolved` requires comparison evidence and that a full Analysis rejects prior-Finding assessments.

- [ ] Keep the agent instruction concise and refer to the enforced budget. Do not persist prompt text or expose it through renderer contracts or diagnostics.

- [ ] Run: `pnpm test -- --run tests/services/review-inspector.test.ts tests/services/review-inspector-tools.test.ts tests/services/model-review-runner.test.ts tests/services/review-rubric.test.ts`

Expected: PASS.

- [ ] Commit:

```bash
git add src/services/review-inspector.ts src/services/review-inspector-tools.ts src/services/model-review-runner.ts src/services/review-rubric.ts src/workflows/review-pr.ts tests/services/review-inspector.test.ts tests/services/review-inspector-tools.test.ts tests/services/model-review-runner.test.ts tests/services/review-rubric.test.ts
git commit -m "fix: enforce bounded analysis inspection"
```

## Task 3: Unify cancellable Analysis and Walkthrough execution

**Files:**

- Create: `src/services/insight-run-coordinator.ts`
- Modify: `src/services/review-workflow-starter.ts`
- Modify: `src/services/flue-cli-review-invoker.ts`
- Modify: `src/services/flue-cli-walkthrough-invoker.ts`
- Modify: `src/services/narrative-walkthrough-service.ts`
- Modify: `src/services/review-run-coordinator.ts`
- Modify: `src/services/review-run-registry.ts`
- Create: `tests/services/insight-run-coordinator.test.ts`
- Modify: `tests/services/review-workflow-starter.test.ts`
- Modify: `tests/services/flue-cli-review-invoker.test.ts`
- Modify: `tests/services/narrative-walkthrough-service.test.ts`

**Produces:** one durable coordinator with real cancellation and no process-memory walkthrough source of truth.

- [ ] Change both invoker options to accept an `AbortSignal`:

```ts
type InsightInvokeOptions = {
  readonly signal: AbortSignal;
  readonly onActivity?: (
    step: Exclude<ReviewActivityStep, "complete" | "failed">,
  ) => void;
};
```

Pass `signal` into `CommandRunner.runJson/runText`. Map an aborted process to `cancelled`, distinct from provider failure.

- [ ] Implement `InsightRunCoordinator.start/cancel/observe`. It owns an `AbortController` only while the process is live; durable ownership, token, status, and retained output live in `InsightStore`.

- [ ] Start sequence under the store lock:

1. Load Review and its current session.
2. Reject a terminal Review or same-type active run.
3. Verify the requested model against the runtime catalog.
4. Hash the immutable session patch.
5. Persist `activeRun` before starting the process.
6. Invoke Analysis or Walkthrough with the exact current session artifacts.

- [ ] Completion sequence under the store lock:

1. Parse and normalize the candidate output.
2. Reload Review, session, record, and patch hash.
3. Require matching run ID, token, session ID, head SHA, and patch hash.
4. Atomically replace `retained` and clear `activeRun`.
5. If any identity differs, record `superseded` without touching the retained result.

- [ ] Cancellation persists `cancelling` before aborting. A cancelled process ends as `cancelled`; an already-completed process returns the completed projection idempotently. Restart recovery turns durable `queued`, `running`, or `cancelling` records with no owned process into retryable failure while preserving retained content.

- [ ] Delete `NarrativeWalkthroughService.records`, `tokens`, and `commitLocks`; make it a compatibility-free adapter over the coordinator or delete it after moving all callers. Delete the process-local `ReviewRunRegistry` if no remaining route consumes it.

- [ ] Run: `pnpm test -- --run tests/services/insight-run-coordinator.test.ts tests/services/review-workflow-starter.test.ts tests/services/flue-cli-review-invoker.test.ts tests/services/narrative-walkthrough-service.test.ts`

Expected: PASS for cancellation, restart recovery, concurrency, different-type parallelism, late suppression, and retained-result preservation.

- [ ] Commit:

```bash
git add src/services/insight-run-coordinator.ts src/services/review-workflow-starter.ts src/services/flue-cli-review-invoker.ts src/services/flue-cli-walkthrough-invoker.ts src/services/narrative-walkthrough-service.ts src/services/review-run-coordinator.ts src/services/review-run-registry.ts tests/services/insight-run-coordinator.test.ts tests/services/review-workflow-starter.test.ts tests/services/flue-cli-review-invoker.test.ts tests/services/narrative-walkthrough-service.test.ts
git commit -m "feat: coordinate cancellable insight runs"
```

## Task 4: Persist validated Analysis without mutating the Review draft

**Files:**

- Modify: `src/services/review-completion-service.ts`
- Modify: `src/services/review-workbench-projection.ts`
- Modify: `src/domain/review-result.ts`
- Modify: `tests/services/review-completion-service.test.ts`
- Modify: `tests/services/review-workbench-projection.test.ts`
- Create: `tests/domain/review-result.test.ts`

**Produces:** Analysis retention and Finding lifecycle independent from editable feedback.

- [ ] Remove `createReviewBatch()` from `ReviewCompletionService`. Completion must validate the strict model result, compute Patchdesk-owned Finding mapping, and hand the candidate to `InsightRunCoordinator`; it must not edit, replace, or discard the current Review draft.

- [ ] Persist dismissals only. Require a trimmed dismissal reason of 1–500 characters. Project disposition as `dismissed` when the current Analysis contains a dismissal, otherwise `added` when the current Review draft contains a linked item for that Analysis run and Finding ID, otherwise `open`. Removing the draft copy therefore makes the Finding available again without a cross-store transition. `added` does not remove the Finding or clear its merge-policy effect.

- [ ] A replacement Analysis creates a fresh disposition set. Do not carry dismissals or added state by ID, title, file, or semantic similarity.

- [ ] Project current/outdated status by comparing retained revision to `Review.currentSessionId`, current head, and patch hash. Outdated Findings remain in the shared Analysis body but do not appear in the Files > Findings navigator and cannot seed inline comments or affect merge policy.

- [ ] Preserve general/unmapped Findings in the retained Analysis body without an `unmapped` label. Patchdesk maps only exact current Findings into file navigation or inline draft items.

- [ ] Run: `pnpm test -- --run tests/services/review-completion-service.test.ts tests/services/review-workbench-projection.test.ts tests/domain/review-result.test.ts`

Expected: PASS with no draft mutation during completion.

- [ ] Commit:

```bash
git add src/services/review-completion-service.ts src/services/review-workbench-projection.ts src/domain/review-result.ts tests/services/review-completion-service.test.ts tests/services/review-workbench-projection.test.ts tests/domain/review-result.test.ts
git commit -m "refactor: retain analysis independently"
```

## Task 5: Add strict Insight APIs

**Files:**

- Modify: `src/main/local-api.ts`
- Modify: `src/renderer/src/renderer-contracts.ts`
- Modify: `tests/local-api-auth.test.ts`
- Modify: `tests/renderer/renderer-contracts.test.ts`

**Produces:** Review-owned start, cancel, observe, and disposition routes.

- [ ] Add these routes behind existing origin and capability middleware:

```text
POST /v1/reviews/insights/analysis/run
POST /v1/reviews/insights/analysis/cancel
POST /v1/reviews/insights/walkthrough/run
POST /v1/reviews/insights/walkthrough/cancel
GET  /v1/reviews/insights/runs/:runId?profileId=<id>&reviewId=<id>
POST /v1/reviews/insights/analysis/findings/:findingId/add
POST /v1/reviews/insights/analysis/findings/:findingId/dismiss
```

The add route returns a command accepted by the feedback plan's draft controller once that plan exists. Until then it returns `409 draft_unavailable` without mutating the Finding. Do not retain the legacy session-only walkthrough routes or generic `/v1/runs/:runId` ownership fallback.

- [ ] Map invalid input to 400, ownership mismatch to 403, missing Review/run to 404, same-type active run or stale requested revision to 409, and workflow/catalog/storage unavailability to 503.

- [ ] Strictly parse renderer projections. Reject local paths, prompt text, hidden reasoning, provider events, raw command output, credentials, and raw failure details.

- [ ] Run: `pnpm test -- --run tests/local-api-auth.test.ts tests/renderer/renderer-contracts.test.ts`

Expected: PASS for origin, capability, Review ownership, and redaction.

- [ ] Commit:

```bash
git add src/main/local-api.ts src/renderer/src/renderer-contracts.ts tests/local-api-auth.test.ts tests/renderer/renderer-contracts.test.ts
git commit -m "feat: expose review insight lifecycle"
```

## Task 6: Build the Insights overview and Analysis reader

**Files:**

- Create: `src/renderer/src/components/insights-workbench.tsx`
- Create: `src/renderer/src/components/analysis-reader.tsx`
- Create: `src/renderer/src/hooks/use-insight-run.ts`
- Modify: `src/renderer/src/flows/review-workbench-flow.tsx`
- Modify: `src/renderer/src/styles.css`
- Create: `tests/renderer/insights-workbench.ui.test.tsx`
- Create: `tests/renderer/analysis-reader.ui.test.tsx`

**Produces:** the approved two-card overview and persistent Analysis reader.

- [ ] Use the directional visual references below only after applying the specification and ADRs. Ignore copy or behavior that exists only inside an image:

- [Insights overview](../../design/insights-exploration/04-refined-insight-navigator-overview.png)
- [Analysis running](../../design/analysis-states/01-running.png)
- [Current Analysis](../../design/analysis-states/02-current.png)
- [Outdated Analysis](../../design/analysis-states/03-outdated.png)
- [Failed Analysis](../../design/analysis-states/04-failed.png)
- [Replacement Analysis](../../design/analysis-states/05-replacement-running.png)

- [ ] Build the overview from installed shadcn/Base UI `Card`, `Badge`, `Button`, `Select`, `ToggleGroup`, `Alert`, `Spinner`, and `ScrollArea` components as applicable. It shows Analysis and Walkthrough status, generated revision, generated time, and Run/Open/Regenerate action. Run opens model, reasoning, and the `Save as Review draft` or `Open preview when complete` choice. Default completion choice is `Open preview when complete`; the feedback plan adds authorized auto-publication.

- [ ] `useInsightRun()` owns one polling loop per active run, suppresses late responses by run ID, and stops on unmount or terminal status. Polling may update only the matching Insight projection; it must not replace the Review's GitHub snapshot.

- [ ] The Analysis reader renders the deterministic shared body, Findings, Verdict, verification, and human callouts. Finding actions are Add to Review and Dismiss. Keep Files mounted in the hidden Files panel while reading Analysis.

- [ ] A replacement run displays progress above the retained result. Failure or cancellation leaves that result visible. Outdated state removes code-navigation, draft-add, publication, and merge-policy actions but keeps prose readable.

- [ ] On outdated content, show the original revision and make `Run for latest revision` the primary action. Keep old evidence navigation disabled.

- [ ] When Updates available appears during a run, keep the run active and show a bounded warning that its result may be outdated. Do not move focus or replace the active reader.

- [ ] Focus the Insight heading after open and restore focus to the invoking card after close. Do not steal focus for background progress or completion.

- [ ] Announce queued, running, completed, failed, and cancelled state through one polite bounded live region. Status text remains visible on the card/reader and is never communicated by color alone.

- [ ] Run: `pnpm test -- --run tests/renderer/insights-workbench.ui.test.tsx tests/renderer/analysis-reader.ui.test.tsx tests/renderer/review-workbench.ui.test.tsx`

Expected: PASS.

- [ ] Commit:

```bash
git add src/renderer/src/components/insights-workbench.tsx src/renderer/src/components/analysis-reader.tsx src/renderer/src/hooks/use-insight-run.ts src/renderer/src/flows/review-workbench-flow.tsx src/renderer/src/styles.css tests/renderer/insights-workbench.ui.test.tsx tests/renderer/analysis-reader.ui.test.tsx tests/renderer/review-workbench.ui.test.tsx
git commit -m "feat: add durable analysis experience"
```

## Task 7: Build the Walkthrough reader

**Files:**

- Modify: `src/renderer/src/components/narrative-walkthrough.tsx`
- Modify: `src/renderer/src/components/narrative-walkthrough-diff.tsx`
- Modify: `src/renderer/src/hooks/use-walkthrough-controller.ts`
- Modify: `src/renderer/src/components/insights-workbench.tsx`
- Modify: `tests/renderer/narrative-walkthrough.ui.test.tsx`
- Modify: `tests/renderer/narrative-walkthrough-diff.test.tsx`
- Modify: `tests/renderer/insights-workbench.ui.test.tsx`

**Produces:** the approved outline-and-document reader with directly visible related hunks.

- [ ] Use the directional visual references below only after applying the specification and ADRs. Ignore copy or behavior that exists only inside an image:

- [Current Walkthrough](../../design/walkthrough-states/01-current.png)
- [Outdated Walkthrough](../../design/walkthrough-states/02-outdated.png)
- [Walkthrough outline reader](../../design/walkthrough-exploration/02-outline-document-reader.png)

- [ ] Keep the left chapter outline and continuous document body. Each section renders its related hunks directly beneath the explanation through the existing `NarrativeWalkthroughDiff` -> `ReviewDiffView` Pierre path; users do not have to switch to Files. Keep support for unreferenced mechanical hunks. Do not add a raw `<pre>` hunk renderer or another Pierre integration.

- [ ] Persist read-section IDs in the retained Walkthrough record using compare-and-set updates. Reading progress belongs to this result only and never means Review completion or publication.

- [ ] A current Walkthrough may navigate to full Files context. An outdated Walkthrough remains readable but disables old code navigation. Replacement, failure, cancellation, focus, and last-success behavior match Analysis.

- [ ] Remove all user-visible `read-only walkthrough` copy. Preserve the actual read-only capability boundary.

- [ ] Run: `pnpm test -- --run tests/renderer/narrative-walkthrough.ui.test.tsx tests/renderer/narrative-walkthrough-diff.test.tsx tests/renderer/insights-workbench.ui.test.tsx`

Expected: PASS.

- [ ] Commit:

```bash
git add src/renderer/src/components/narrative-walkthrough.tsx src/renderer/src/components/narrative-walkthrough-diff.tsx src/renderer/src/hooks/use-walkthrough-controller.ts src/renderer/src/components/insights-workbench.tsx tests/renderer/narrative-walkthrough.ui.test.tsx tests/renderer/narrative-walkthrough-diff.test.tsx tests/renderer/insights-workbench.ui.test.tsx
git commit -m "feat: add retained walkthrough reader"
```

## Task 8: Insights verification

- [ ] Run: `pnpm lint`
- [ ] Run: `pnpm typecheck`
- [ ] Run: `pnpm test -- --run tests/domain/insight-record.test.ts tests/storage/insight-store.test.ts tests/services/review-inspector.test.ts tests/services/review-inspector-tools.test.ts tests/services/model-review-runner.test.ts tests/services/review-rubric.test.ts tests/services/insight-run-coordinator.test.ts tests/services/review-completion-service.test.ts tests/services/review-workbench-projection.test.ts tests/local-api-auth.test.ts tests/renderer/renderer-contracts.test.ts tests/renderer/insights-workbench.ui.test.tsx tests/renderer/analysis-reader.ui.test.tsx tests/renderer/narrative-walkthrough.ui.test.tsx tests/renderer/narrative-walkthrough-diff.test.tsx`
- [ ] Run: `pnpm build`
- [ ] Run: `git diff --check`
- [ ] Confirm `rg -n 'read-only walkthrough|read-only review|prompt:|contextPath|patchPath|provider' src/renderer/src` has no unsafe user-visible model internals.

For live Electron verification, the primary agent must spawn a dedicated tester subagent and direct it to use `$patchdesk-electron-tester`. Verify Analysis and Walkthrough can run concurrently, same-type duplicates are rejected, cancel preserves the last result, replacement swaps only on success, related hunks appear directly in Walkthrough, and keyboard focus restores correctly.

## Handoff to feedback plan

- Feedback consumes current retained Analysis and Finding dispositions.
- Feedback implements Add to Review, deterministic Review-body rendering, completion choices, authorization, publication, and Analysis merge policy.
- If remote activity appears while an Insight runs, Foundation updates freshness and Feedback revokes publication authorization. This plan does not cancel the Insight process.
