# Unified Review Feedback and Merge Implementation Plan (Archived)

> Completed and archived on 2026-08-03. Do not execute this plan. Use the
> current [combined repair ExecPlan](../2026-08-03-unified-review-spec-and-design-repair.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the unified Review with one persistent draft, deterministic Analysis-to-GitHub content, explicit or per-run automatic publication, refreshed Published feedback, safe comment mutation, Analysis-aware merge policy, and a no-loss migration from current sessions.

**Architecture:** The Review draft stays local and current-session-owned. Analysis may seed an empty draft or prepare an explicit replacement preview, but it never silently changes non-empty human work. Publication is a two-stage, receipt-backed state machine bound to one Review, immutable session, head SHA, patch hash, draft revision, event, and Analysis run. Published feedback is reloaded from GitHub on explicit refresh. Merge readiness combines non-configurable GitHub/write-safety blockers with a profile-level Analysis policy evaluated only from current retained Findings.

**Tech Stack:** TypeScript, Valibot, JSON-file storage, Hono loopback API, GitHub REST/GraphQL through argv-array `gh`, React 19, Base UI through existing shadcn/ui components, Vitest, Playwright.

## Dependencies

Complete these plans first:

- [Unified Review Foundation](2026-08-01-unified-review-foundation.md)
- [Unified Review Workbench UI](2026-08-01-unified-review-ui.md)
- [Unified Review Insights](2026-08-01-unified-review-insights.md)

This is the final executable plan. Its full verification is the release gate for the program.

## Authority and reuse constraints

- The product specification and ADRs are authoritative for draft, publication, Published feedback, merge behavior, copy, and confirmation. Design documents guide composition only when they agree; screenshot and generated-image text is directional.
- Compose the installed shadcn/Base UI primitives before custom UI: `Collapsible` for the dock, `Dialog` for publication and edit flows, `AlertDialog` for destructive confirmation, `Sheet` for PR Overview, and existing `Button`, `Badge`, `Alert`, `Checkbox`, `Select`, `ToggleGroup`, `Textarea`, `DropdownMenu`, `ScrollArea`, `Separator`, `Spinner`, and form components as applicable.
- Reuse the existing `ReviewBatchPanel` behavior while migrating it into the one draft dock, and keep `PullRequestOverviewSheet` as the PR Overview owner. Do not run two editors, create another overlay/focus implementation, or duplicate publication state locally.
- Extend the existing draft controller, submission service, write gate, GitHub adapter, receipt store, merge service, profile service, and loopback routes. A custom primitive, alternate owner, or new dependency requires an exact missing capability and a plan update before code.

## Required context

Read these files before editing:

- [Product specification](../../spec.md)
- [No-regression contract](../../research/02-research-core-no-regression-contract.md)
- [UI design reference](../../design/design.md)
- [Draft carry-forward ADR](../../../../../docs/adr/0002-preserve-review-drafts-across-revisions.md)
- [Analysis-body ADR](../../../../../docs/adr/0009-structure-the-analysis-review-body.md)
- [Publication ADR](../../../../../docs/adr/0010-choose-an-analysis-completion-action-per-run.md)
- [Merge-policy ADR](../../../../../docs/adr/0011-make-analysis-merge-policy-configurable.md)
- [Published-feedback ADR](../../../../../docs/adr/0006-separate-draft-and-published-feedback.md)
- `src/domain/review-batch.ts`
- `src/services/review-batch-controller.ts`
- `src/services/review-submission-service.ts`
- `src/services/review-write-controller.ts`
- `src/adapters/github/github-adapter.ts`
- `src/domain/merge-readiness.ts`
- `src/services/merge-service.ts`
- `src/domain/workspace-profile.ts`
- `src/adapters/storage/review-session-store.ts`

## Exact draft additions

Extend `ReviewBatchItem` with non-line-specific feedback:

```ts
| {
    readonly _tag: "GeneralComment";
    readonly id: LocalReviewItemId;
    readonly provenance: ReviewItemProvenance;
    readonly source: "finding" | "manual";
    readonly findingId?: FindingId;
    readonly body: string;
    readonly include: boolean;
    readonly carriedFrom?: ReviewItemCarryForward;
  }
```

Add these local draft commands:

```ts
export type ReviewBatchUpdate =
  | { readonly _tag: "UpdateBody"; readonly body: string }
  | { readonly _tag: "SetSuggestedEvent"; readonly event: GitHubReviewEvent }
  | {
      readonly _tag: "SetItemIncluded";
      readonly itemId: LocalReviewItemId;
      readonly include: boolean;
    }
  | {
      readonly _tag: "ConvertInlineToGeneral";
      readonly itemId: LocalReviewItemId;
    }
  | {
      readonly _tag: "RepairInlineAnchor";
      readonly itemId: LocalReviewItemId;
      readonly anchor: ReviewAnchor;
      readonly fingerprint: ReviewAnchorFingerprint;
    }
  | ReviewBatchUpdateExistingCommands;
```

Every command remains serialized and compare-and-set against `ReviewBatch.updatedAt`. Body and item text are trimmed only at the GitHub write boundary, not during editing. An empty local draft is legal; publication requires a non-empty rendered body or at least one included operation.

## Deterministic Analysis body

Create `renderAnalysisReviewBody()` in `src/services/analysis-review-body.ts`. The model supplies structured fields, not Markdown layout. Escape code-sensitive user text and produce sections in this exact order:

```text
# Review Scope
Diff: <base-short>...<head-short> (<commit-count> commits, <file-count> files, +<additions>/-<deletions>)

# Pull Request Overview
<result.changeSummary>

# Reviewed Changes
- `<path>` (+<additions>/-<deletions>)

# Verification
- <each validationPlan item>

# Findings
<all Findings grouped P0 through P3; general Findings stay in this body>

# Verdict
<Approve|Comment|Request changes>. <result.summary>

# Human Reviewer Callouts
<callouts, unresolvedItems, and assumptions; omit the heading if all are empty>
```

Omit Verification when `validationPlan` is empty. Omit Human Reviewer Callouts when callouts, unresolved items, and assumptions are all empty. Do not add `unmapped`, provider, prompt, model, local path, or hidden-reasoning text. The inline comment set contains only current exact Mapped Findings. The GitHub review body therefore remains useful even when a Finding cannot map to an inline location.

## Exact publication authorization

Create `src/domain/publication-authorization.ts`:

```ts
export type AnalysisCompletionAction =
  | { readonly _tag: "SaveAsReviewDraft" }
  | { readonly _tag: "OpenPreviewWhenComplete" }
  | {
      readonly _tag: "PublishWhenComplete";
      readonly event: GitHubReviewEvent;
      readonly authorizationId: PublicationAuthorizationId;
    };

export type PublicationAuthorization = {
  readonly schemaVersion: 1;
  readonly id: PublicationAuthorizationId;
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly patchHash: ContentHash;
  readonly analysisRunId: InsightRunId;
  readonly expectedDraftRevision: IsoTimestamp;
  readonly event: GitHubReviewEvent;
  readonly createdAt: IsoTimestamp;
  readonly state:
    | { readonly _tag: "Armed" }
    | { readonly _tag: "Revoked"; readonly reason: PublicationRevocationReason }
    | { readonly _tag: "Consumed"; readonly consumedAt: IsoTimestamp };
};

export type PublicationRevocationReason =
  | "updates_available"
  | "refresh"
  | "revision_changed"
  | "draft_changed"
  | "draft_not_empty"
  | "analysis_failed"
  | "analysis_cancelled"
  | "validation_failed"
  | "needs_attention"
  | "authorization_mismatch";
```

Store one authorization beside the Analysis record. Authorization is per run, never a persistent profile preference. Any draft command changes `updatedAt` and revokes a matching armed authorization.

## Exact publication preview

```ts
export type PublicationPreview = {
  readonly authorizationId?: PublicationAuthorizationId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly draftRevision: IsoTimestamp;
  readonly event: GitHubReviewEvent;
  readonly body: string;
  readonly inlineComments: ReadonlyArray<{
    readonly itemId: LocalReviewItemId;
    readonly path: RepoRelativePath;
    readonly startLine: number;
    readonly line: number;
    readonly side: "new" | "old";
    readonly body: string;
  }>;
  readonly threadActions: ReadonlyArray<{
    readonly itemId: LocalReviewItemId;
    readonly action: "reply" | "resolve" | "reopen";
    readonly body?: string;
  }>;
  readonly warnings: ReadonlyArray<
    "no_inline_comments" | "github_decision_changed"
  >;
};
```

The preview is built main-process-side from the durable draft immediately before confirmation. The confirmation request supplies only identity plus `expectedDraftRevision`; the server does not trust a renderer-returned preview payload.

## Task 1: Complete the Review draft domain and editor controller

**Files:**

- Modify: `src/domain/review-batch.ts`
- Modify: `src/services/review-batch-controller.ts`
- Modify: `src/services/review-workbench-controller.ts`
- Modify: `src/services/review-refresh-service.ts`
- Delete: `src/domain/review-draft.ts`
- Create: `tests/domain/review-batch.test.ts`
- Modify: `tests/services/review-batch-controller.test.ts`
- Modify: `tests/services/review-workbench.test.ts`
- Modify: `tests/services/review-refresh-service.test.ts`

**Produces:** one draft model with body, event, inclusion, general feedback, anchor repair, and no duplicate legacy draft type.

- [ ] Write failing tests for every new command, CAS conflict, invalid empty item body, conversion preserving ID/provenance/Finding link, exact repair clearing Needs attention, edit rejection after publication starts, and serialized concurrent edits.

- [ ] Add `GeneralComment` to strict parsing, carry-forward, receipt planning, and renderer projection. General comments never receive GitHub coordinates; `renderReviewBody()` appends included general comments under `## Additional feedback`.

- [ ] Add `createEmptyReviewBatch(sessionId, now)`. Ensure every open Review's current session has one local attempt-free batch on open, migration, and new-session refresh. An absent legacy batch is treated as empty and created before the first projection or command; never use a renderer-only virtual draft.

- [ ] `ConvertInlineToGeneral` replaces the item atomically and keeps its body, inclusion, provenance, carry-forward source, and optional Finding ID. `RepairInlineAnchor` accepts only a coordinate whose fingerprint can be recomputed exactly from the current immutable patch.

- [ ] Remove the unused `ReviewDraft` domain and migrate all remaining imports to `ReviewBatch`. Do not keep a compatibility export.

- [ ] Run: `pnpm test -- --run tests/domain/review-batch.test.ts tests/services/review-batch-controller.test.ts tests/services/review-workbench.test.ts tests/services/review-refresh-service.test.ts`

Expected: PASS.

- [ ] Commit:

```bash
git add src/domain/review-batch.ts src/services/review-batch-controller.ts src/services/review-workbench-controller.ts src/services/review-refresh-service.ts tests/domain/review-batch.test.ts tests/services/review-batch-controller.test.ts tests/services/review-workbench.test.ts tests/services/review-refresh-service.test.ts
git add -u src/domain/review-draft.ts
git commit -m "feat: complete the review draft domain"
```

## Task 2: Seed or replace a draft from current Analysis

**Files:**

- Create: `src/services/analysis-review-body.ts`
- Create: `src/services/analysis-draft-service.ts`
- Modify: `src/services/review-workbench.ts`
- Modify: `src/main/local-api.ts`
- Create: `tests/services/analysis-review-body.test.ts`
- Create: `tests/services/analysis-draft-service.test.ts`
- Modify: `tests/services/review-workbench.test.ts`

**Produces:** predictable GitHub-shaped content and explicit no-loss seed, merge, or replacement.

- [ ] Write golden tests for zero Findings, grouped Findings, general/unmapped Findings in the body, mapped inline comments, validation, assumptions, callouts, Markdown escaping, and the exact specification-defined section order.

- [ ] `AnalysisDraftService.seed()` requires current retained Analysis. If the current draft is empty, set the deterministic body, suggested event, and one included inline item per current Mapped Finding. If the draft is non-empty, return `409 draft_not_empty` with both merge and replacement previews; make no mutation.

- [ ] Define empty as blank body plus zero included items plus no receipts. Excluded items still make the draft non-empty because replacement would remove local work.

- [ ] `replace()` requires the current draft revision plus `acknowledgement: true`. Its preview lists the exact body and items removed. On success, replace in one store transaction. Do not carry human content into the generated replacement.

- [ ] Implement `previewMerge()` and `merge()` for a non-empty draft. The merged body is deterministic:

```text
# Maintainer notes
<the current Review body, unchanged>

<the generated Analysis body, unchanged>
```

Preserve every manual inline comment and thread action. Add only current Mapped Finding comments whose `findingId` is not already represented by an existing model-provenance draft item. Do not deduplicate by prose, path, or title. Preview the exact merged body, added items, and preserved items before applying it with the expected draft revision.

- [ ] Adding one Finding from the Analysis reader creates an independent editable item. Mapped becomes `InlineComment`; general/unmapped becomes `GeneralComment`. The projection derives `added` from that linked draft item; removing the item automatically projects the Finding as `open` again. A later Analysis run never rewrites an existing copied item.

- [ ] Add strict routes:

```text
POST /v1/reviews/draft/seed-analysis
POST /v1/reviews/draft/replace-preview
POST /v1/reviews/draft/replace
POST /v1/reviews/draft/merge-preview
POST /v1/reviews/draft/merge
POST /v1/reviews/draft/findings/:findingId/add
```

- [ ] Run: `pnpm test -- --run tests/services/analysis-review-body.test.ts tests/services/analysis-draft-service.test.ts tests/services/review-workbench.test.ts tests/local-api-auth.test.ts`

Expected: PASS with no silent draft loss.

- [ ] Commit:

```bash
git add src/services/analysis-review-body.ts src/services/analysis-draft-service.ts src/services/review-workbench.ts src/main/local-api.ts tests/services/analysis-review-body.test.ts tests/services/analysis-draft-service.test.ts tests/services/review-workbench.test.ts tests/local-api-auth.test.ts
git commit -m "feat: generate deterministic review drafts"
```

## Task 3: Add per-run completion choices and immutable authorization

**Files:**

- Create: `src/domain/publication-authorization.ts`
- Create: `src/adapters/storage/publication-authorization-store.ts`
- Create: `src/services/analysis-completion-service.ts`
- Modify: `src/services/insight-run-coordinator.ts`
- Modify: `src/services/review-refresh-service.ts`
- Modify: `src/services/review-batch-controller.ts`
- Modify: `src/main/local-api.ts`
- Create: `tests/domain/publication-authorization.test.ts`
- Create: `tests/storage/publication-authorization-store.test.ts`
- Create: `tests/services/analysis-completion-service.test.ts`

**Produces:** Keep result, Open preview, and authorized Publish when complete.

- [ ] Extend the Analysis run request with the final `AnalysisCompletionAction`. For `PublishWhenComplete`, create and persist `Armed` authorization before starting the run. Bind it to the expected empty draft revision and all immutable fields above.

- [ ] On successful current Analysis:

- `SaveAsReviewDraft`: seed an empty draft. If local work exists, prepare the merge/replace choice and do not mutate until the maintainer accepts a preview.
- `OpenPreviewWhenComplete`: seed and preview an empty draft, or return the merge/replace previews for existing work; set renderer-safe `completion: "preview_ready"`.
- `PublishWhenComplete`: seed only an empty unchanged draft, rebuild and verify the authorization, then invoke the same publication service as manual confirmation.

- [ ] Revoke authorization durably on update detection, any refresh, session/head/patch change, any draft command, failed/cancelled/invalid Analysis, Needs attention, or identity mismatch. Revocation never cancels the Analysis run and never discards its validated result.

- [ ] If auto-publication is revoked after Analysis validates, retain the result and route it to the same safe local seed or merge/replace preview as `SaveAsReviewDraft`; never drop the completed output.

- [ ] New remote activity detected during the process updates only Foundation freshness plus authorization state. The process may finish and retain Analysis, but it cannot write to GitHub.

- [ ] Run: `pnpm test -- --run tests/domain/publication-authorization.test.ts tests/storage/publication-authorization-store.test.ts tests/services/analysis-completion-service.test.ts tests/services/insight-run-coordinator.test.ts tests/services/review-refresh-service.test.ts tests/services/review-batch-controller.test.ts`

Expected: PASS for all three choices and every revocation condition.

- [ ] Commit:

```bash
git add src/domain/publication-authorization.ts src/adapters/storage/publication-authorization-store.ts src/services/analysis-completion-service.ts src/services/insight-run-coordinator.ts src/services/review-refresh-service.ts src/services/review-batch-controller.ts src/main/local-api.ts tests/domain/publication-authorization.test.ts tests/storage/publication-authorization-store.test.ts tests/services/analysis-completion-service.test.ts tests/services/insight-run-coordinator.test.ts tests/services/review-refresh-service.test.ts tests/services/review-batch-controller.test.ts
git commit -m "feat: authorize analysis completion actions"
```

## Task 4: Harden preview, confirmation, and receipt-backed publication

**Files:**

- Create: `src/services/publication-preview-service.ts`
- Modify: `src/services/review-submission-service.ts`
- Modify: `src/services/review-write-controller.ts`
- Modify: `src/domain/review-batch.ts`
- Modify: `src/main/local-api.ts`
- Create: `tests/services/publication-preview-service.test.ts`
- Modify: `tests/services/review-submission-service.test.ts`
- Create: `tests/services/review-write-controller.test.ts`

**Produces:** one manual/automatic publication path with exact preview and safe uncertain-outcome recovery.

- [ ] Add strict routes:

```text
POST /v1/reviews/publication/preview
POST /v1/reviews/publication/confirm
POST /v1/reviews/publication/recover
```

- [ ] Preview calls the Foundation `ReviewWriteGate`, then verifies current Review/session/head/patch, editable local draft, no included Needs attention item, and complete publication payload. Return 409 for any stale identity or draft revision.

- [ ] Confirmation rebuilds the preview under the Review write lock, compares `expectedDraftRevision`, persists intent before the first GitHub call, applies inline and thread operations with receipts, then submits the pending review decision. Keep the existing two-stage GitHub API sequence.

- [ ] Never clear draft content until every intended operation and the submitted review are confirmed. After success, mark the old batch `Submitted`, retain its receipts as evidence, create a new empty local batch, and wait for explicit refresh to populate Published feedback.

- [ ] A known rejection returns to an editable local state only when no remote operation succeeded. A partial or unknown outcome freezes conflicting retries, preserves intent plus receipts, and requires `recover()` to read GitHub state before deciding whether to resume or mark confirmed. Never blindly replay a receipted operation.

- [ ] Run: `pnpm test -- --run tests/services/publication-preview-service.test.ts tests/services/review-submission-service.test.ts tests/services/review-write-controller.test.ts tests/local-api-auth.test.ts`

Expected: PASS for exact payload, head race, partial failure, unknown outcome, restart recovery, and idempotency.

- [ ] Commit:

```bash
git add src/services/publication-preview-service.ts src/services/review-submission-service.ts src/services/review-write-controller.ts src/domain/review-batch.ts src/main/local-api.ts tests/services/publication-preview-service.test.ts tests/services/review-submission-service.test.ts tests/services/review-write-controller.test.ts tests/local-api-auth.test.ts
git commit -m "feat: confirm review publication safely"
```

## Task 5: Load and mutate Published feedback through GitHub

**Files:**

- Modify: `src/domain/github-context.ts`
- Modify: `src/adapters/github/github-adapter.ts`
- Create: `src/services/published-feedback-service.ts`
- Modify: `src/services/review-refresh-service.ts`
- Modify: `src/services/review-workbench-projection.ts`
- Modify: `src/main/local-api.ts`
- Modify: `tests/adapters/github-adapter.test.ts`
- Create: `tests/services/published-feedback-service.test.ts`
- Modify: `tests/services/review-refresh-service.test.ts`

**Produces:** remote-owned review bodies and inline comments, with safe edit/delete/dismiss actions.

- [ ] Add strict projection types:

```ts
export type PublishedReview = {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly event: "APPROVED" | "COMMENTED" | "CHANGES_REQUESTED" | "DISMISSED";
  readonly submittedAt: IsoTimestamp;
  readonly canDismiss: boolean;
};

export type PublishedReviewComment = GitHubComment & {
  readonly reviewId?: string;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
};
```

- [ ] Extend `GitHubReader` to list submitted pull-request reviews and review comments during explicit refresh. Bound and paginate results; set `complete: false` rather than presenting a truncated list as complete.

- [ ] Determine edit/delete capability from authenticated account plus repository `viewerPermission` of `WRITE`, `MAINTAIN`, or `ADMIN`. Determine dismiss capability only from proven `ADMIN` permission or an exact match in branch-protection dismissal restrictions, including verified team membership. If permission evidence is unavailable or incomplete, project `false`; do not guess.

- [ ] Extend the explicit writer boundary:

```ts
updateReviewComment(...): Promise<Result<void, GitHubWriteFailure>>;
deleteReviewComment(...): Promise<Result<void, GitHubWriteFailure>>;
dismissReview(...): Promise<Result<void, GitHubWriteFailure>>;
```

Use GitHub's review-comment PATCH/DELETE endpoints and the review-dismissal endpoint. Delete and dismiss require explicit confirmation. Review dismissal requires a non-empty message. Do not expose delete for the submitted review record.

- [ ] `PublishedFeedbackService` calls the Foundation `ReviewWriteGate`, rechecks current PR head before every mutation, verifies the projected capability, calls GitHub, and then forces a feedback refresh. A failed refresh after a confirmed write keeps a renderer-safe `refresh_required` notice instead of pretending the local copy is authoritative.

- [ ] Add routes:

```text
POST /v1/reviews/published-comments/edit
POST /v1/reviews/published-comments/delete
POST /v1/reviews/published-reviews/dismiss
```

- [ ] Run: `pnpm test -- --run tests/adapters/github-adapter.test.ts tests/services/published-feedback-service.test.ts tests/services/review-refresh-service.test.ts tests/services/review-workbench-projection.test.ts tests/local-api-auth.test.ts`

Expected: PASS for refreshed ownership, permitted edit, confirmed delete, dismissal distinction, stale blocking, permission denial, and incomplete pagination.

- [ ] Commit:

```bash
git add src/domain/github-context.ts src/adapters/github/github-adapter.ts src/services/published-feedback-service.ts src/services/review-refresh-service.ts src/services/review-workbench-projection.ts src/main/local-api.ts tests/adapters/github-adapter.test.ts tests/services/published-feedback-service.test.ts tests/services/review-refresh-service.test.ts tests/services/review-workbench-projection.test.ts tests/local-api-auth.test.ts
git commit -m "feat: manage published review feedback"
```

GitHub references:

- [Pull request reviews](https://docs.github.com/en/rest/pulls/reviews)
- [Pull request review comments](https://docs.github.com/en/rest/pulls/comments?apiVersion=2022-11-28)

## Task 6: Add profile Analysis merge policy

**Files:**

- Modify: `src/domain/workspace-profile.ts`
- Modify: `src/services/profile-service.ts`
- Modify: `src/domain/merge-readiness.ts`
- Modify: `src/services/merge-service.ts`
- Modify: `src/services/review-workbench-projection.ts`
- Modify: `src/renderer/src/components/settings-modal.tsx`
- Modify: `tests/renderer/profile-settings.test.tsx`
- Modify: `tests/domain/merge-readiness.test.ts`
- Modify: `tests/services/merge-service.test.ts`

**Produces:** Advisory, Require acknowledgement, and Block without weakening GitHub safety.

- [ ] Add required profile field:

```ts
export type AnalysisMergePolicy =
  "advisory" | "require_acknowledgement" | "block";

type WorkspaceProfileConfig = {
  // existing fields
  readonly analysisMergePolicy: AnalysisMergePolicy;
};
```

New profiles default to `require_acknowledgement`. Migration of old profiles also sets it explicitly.

- [ ] Compute Analysis effect from current retained Analysis only:

- `advisory`: current open/added P0/P1 are warnings only.
- `require_acknowledgement`: current open/added P0/P1 require one merge-dialog acknowledgement for the current Analysis run.
- `block`: current open/added P0/P1 block merge.
- Dismissed Findings never affect policy.
- Missing Analysis does not block or warn.
- Outdated Analysis never affects policy.

- [ ] Extend `MergeReadiness` with typed Analysis blockers/warnings. Keep stale/unrefreshed state, closed/draft/conflict, incomplete policy evidence, failed required checks, GitHub review rules, and unresolved write/publication recovery as non-configurable blockers evaluated first.

- [ ] Bind merge acknowledgement to current Review, session, head, and Analysis run. `MergeService` calls the Foundation `ReviewWriteGate`, re-evaluates policy, and rechecks GitHub head immediately before the exact-SHA merge write. Never trust the renderer's readiness object.

- [ ] Add a simple Settings radio group with plain-language descriptions and `Require acknowledgement` selected by default.

- [ ] Run: `pnpm test -- --run tests/renderer/profile-settings.test.tsx tests/domain/merge-readiness.test.ts tests/services/merge-service.test.ts tests/services/review-workbench-projection.test.ts`

Expected: PASS for the complete policy matrix.

- [ ] Commit:

```bash
git add src/domain/workspace-profile.ts src/services/profile-service.ts src/domain/merge-readiness.ts src/services/merge-service.ts src/services/review-workbench-projection.ts src/renderer/src/components/settings-modal.tsx tests/renderer/profile-settings.test.tsx tests/domain/merge-readiness.test.ts tests/services/merge-service.test.ts tests/services/review-workbench-projection.test.ts
git commit -m "feat: configure analysis merge policy"
```

## Task 7: Build the Review draft, publication, and Published feedback UI

**Files:**

- Create: `src/renderer/src/components/review-draft-dock.tsx`
- Create: `src/renderer/src/components/publication-preview-dialog.tsx`
- Create: `src/renderer/src/components/published-feedback.tsx`
- Create: `src/renderer/src/hooks/use-review-draft.ts`
- Create: `src/renderer/src/hooks/use-publication.ts`
- Modify: `src/renderer/src/components/review-workbench.tsx`
- Modify: `src/renderer/src/components/pr-overview-sheet.tsx`
- Modify: `src/renderer/src/components/insights-workbench.tsx`
- Delete: `src/renderer/src/components/review-batch-panel.tsx`
- Create: `tests/renderer/review-draft-dock.ui.test.tsx`
- Create: `tests/renderer/publication-preview-dialog.ui.test.tsx`
- Create: `tests/renderer/published-feedback.ui.test.tsx`
- Modify: `tests/renderer/review-workbench.ui.test.tsx`

**Produces:** one bottom dock, one exact confirmation surface, and remote feedback in PR Overview.

- [ ] Use the directional visual references below only after applying the specification and ADRs. Ignore copy or behavior that exists only inside an image:

- [Expanded Review draft](../../design/concepts/02-expanded-review-draft.png)
- [Ready to publish](../../design/publication-states/01-ready.png)
- [Publishing](../../design/publication-states/02-publishing.png)
- [Confirmed](../../design/publication-states/03-confirmed.png)
- [Needs confirmation](../../design/publication-states/04-needs-confirmation.png)

- [ ] Build the bottom dock with the installed shadcn/Base UI `Collapsible` and existing form primitives. Keep it visible throughout an open Review. Its summary shows included item count, proposed decision, and Needs attention count in text. Expanded state edits body, event, item inclusion, comment text, thread actions, and Needs attention repair/conversion. The dock is not a page footer and does not resize the right-side PR Overview `Sheet`.

- [ ] Use the installed `Dialog` for publication preview and edit flows, and `AlertDialog` for destructive confirmation. Let Base UI own focus trapping, Escape, restoration, and stacking. Publication preview is not a second editor. Show exact body, inline comments, thread actions, event, current head, warnings, and confirmation button. Restore focus to Preview after close.

- [ ] Analysis run options show `Save as Review draft`, `Open preview when complete`, and `Publish when complete` with Comment, Approve, or Request changes. Auto-publication requires the exact event choice and a clear one-run authorization statement; it is never remembered as a profile default.

- [ ] When generated Analysis meets a non-empty draft, offer Merge and Replace previews. Merge visibly preserves current text under Maintainer notes and appends the generated body; Replace visibly lists everything removed. Neither action mutates until confirmed.

- [ ] Keep PR Overview in the existing `PullRequestOverviewSheet`. Render Published feedback separately from the local draft. Use the installed `DropdownMenu` for permitted actions. Inline comment menus show Edit/Delete only when capability is true; delete uses `AlertDialog`. Review record menus show Dismiss only when capability is true; dismissal uses `Dialog`. Updates available disables all Published feedback writes.

- [ ] Make every dock, preview, feedback, and merge control keyboard operable. Use visible text plus icons for publication, attention, permission, and merge state. Announce publication progress and recovery through a bounded polite live region without moving focus.

- [ ] Remove `ReviewBatchPanel` after moving every behavior. Do not keep both draft editors.

- [ ] Run: `pnpm test -- --run tests/renderer/review-draft-dock.ui.test.tsx tests/renderer/publication-preview-dialog.ui.test.tsx tests/renderer/published-feedback.ui.test.tsx tests/renderer/review-workbench.ui.test.tsx tests/renderer/insights-workbench.ui.test.tsx`

Expected: PASS for dock persistence, exact preview, focus, action permissions, and update blocking.

- [ ] Commit:

```bash
git add src/renderer/src/components/review-draft-dock.tsx src/renderer/src/components/publication-preview-dialog.tsx src/renderer/src/components/published-feedback.tsx src/renderer/src/hooks/use-review-draft.ts src/renderer/src/hooks/use-publication.ts src/renderer/src/components/review-workbench.tsx src/renderer/src/components/pr-overview-sheet.tsx src/renderer/src/components/insights-workbench.tsx tests/renderer/review-draft-dock.ui.test.tsx tests/renderer/publication-preview-dialog.ui.test.tsx tests/renderer/published-feedback.ui.test.tsx tests/renderer/review-workbench.ui.test.tsx tests/renderer/insights-workbench.ui.test.tsx
git add -u src/renderer/src/components/review-batch-panel.tsx
git commit -m "feat: complete review feedback surfaces"
```

## Task 8: Migrate current Review sessions without losing work

**Files:**

- Create: `src/services/unified-review-migration.ts`
- Modify: `src/adapters/storage/review-session-store.ts`
- Modify: `src/services/profile-service.ts`
- Modify: `src/main/local-api.ts`
- Create: `tests/services/unified-review-migration.test.ts`

**Produces:** idempotent lazy adoption into stable Reviews and explicit new profile policy.

- [ ] On first profile load, group valid schema-v4 sessions by `(profile, host, owner, repo, PR number)`. For each group, create one stable Review if absent.

- [ ] Select `currentSessionId` by terminal state first, otherwise greatest `updatedAt` with deterministic session-ID tie-break. Preserve every session directory, attempt artifact, `visibleResult`, batch, receipts, comparison evidence, and submitted-review evidence. Never rewrite immutable patch or attempt files.

- [ ] If the selected session has `visibleResult`, create the Analysis retained record bound to that session and patch hash with no dismissals. If a valid legacy Walkthrough artifact is present, strictly parse it, verify its session/head/patch identity, and preserve it as retained Walkthrough. Do not synthesize one when absent: the known current service keeps Walkthrough only in process memory, which is not recoverable after restart.

- [ ] Keep current `batchContent` as the selected session's Review draft, including partial failures and receipts. Do not merge drafts from older sessions. Older sessions remain available as migration evidence and may be surfaced by recovery tooling.

- [ ] If a session, draft, Insight candidate, or remote-write record cannot be parsed safely, leave its source files untouched, record a bounded `migration_recovery_required` projection with no raw path or payload, and continue migrating unrelated Reviews. Cleanup must not delete this evidence.

- [ ] Add `analysisMergePolicy: "require_acknowledgement"` to profiles that lack it. Save only after all new Review/Insight records for that profile are valid. Write a migration marker last.

- [ ] Make migration restart-safe: rerunning after any interrupted step must produce the same IDs, reuse valid records, never duplicate receipts/items, and never delete source files.

- [ ] Keep cleanup profile-owned, canonical-path checked, serialized, idempotent, and limited to non-running sessions. Add a regression case proving the migration does not broaden cleanup eligibility.

- [ ] Run: `pnpm test -- --run tests/services/unified-review-migration.test.ts tests/storage/review-session-store-begin-attempt.test.ts tests/renderer/profile-settings.test.tsx`

Expected: PASS for empty profile, one session, multiple heads, completed Analysis, local draft, partial publication, terminal Review, invalid source quarantine, interrupted migration, and idempotent rerun.

- [ ] Commit:

```bash
git add src/services/unified-review-migration.ts src/adapters/storage/review-session-store.ts src/services/profile-service.ts src/main/local-api.ts tests/services/unified-review-migration.test.ts
git commit -m "feat: migrate sessions into unified reviews"
```

## Task 9: End-to-end acceptance and full gate

**Files:**

- Modify: `fixtures/github/argv/get-comments.json`
- Modify: `fixtures/github/payloads/get-comments.json`
- Create: `fixtures/github/argv/get-reviews.json`
- Create: `fixtures/github/payloads/get-reviews.json`
- Modify: `tests/browser/review-workbench.spec.ts`
- Modify: `tests/browser/protected-loopback-workflow.spec.ts`
- Create: `CHANGELOG.md`

- [ ] Extend fixtures with two commits, one submitted Review body, one editable published inline comment, checks, threads, a new-head refresh, and terminal merged state.

- [ ] In `tests/browser/review-workbench.spec.ts`, prove one seeded journey:

1. Open one stable Review.
2. Navigate Files, current Findings, Commits, and Insights.
3. Run Analysis and retain its structured body.
4. Seed and edit the Review draft.
5. Detect updates without changing visible content.
6. Refresh to a new head in the same destination.
7. Repair or convert a Needs attention anchor.
8. Preview and confirm one GitHub Review with body plus inline Finding comments.
9. Explicitly refresh and see Published feedback.
10. Confirm edit/delete/dismiss actions respect permissions and freshness.
11. Apply Analysis merge policy and complete an exact-SHA merge.
12. Keep the terminal Review readable with writes removed.

- [ ] In the protected loopback test, prove wrong origin, missing capability, cross-profile Review ID, cross-Review run ID, renderer-supplied paths, stale draft revision, and stale head cannot cross the API boundary.

- [ ] Update the changelog with one concise user-facing entry for the unified Review workbench, retained Insights, Review draft, publication, and Published feedback.

- [ ] Run the full gate in order:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm run test:a11y
pnpm run test:performance
pnpm exec playwright test
git diff --check
```

Expected: every command passes. Report baseline or environment failures separately; do not weaken retained assertions.

- [ ] For live Electron acceptance, the primary agent must spawn a dedicated tester subagent and direct it to use `$patchdesk-electron-tester`. Verify the complete journey above at 1280px and 1440px, keyboard-only focus flow, manual refresh semantics, overlay behavior, related Walkthrough hunks, and non-destructive cancellation/recovery.

- [ ] Commit:

```bash
git add fixtures/github/argv/get-comments.json fixtures/github/payloads/get-comments.json fixtures/github/argv/get-reviews.json fixtures/github/payloads/get-reviews.json tests/browser/review-workbench.spec.ts tests/browser/protected-loopback-workflow.spec.ts CHANGELOG.md
git commit -m "test: prove the unified review journey"
```

## Completion criteria

The program is complete only when all four plans are implemented in order, the full gate passes, live Electron acceptance is recorded by the required tester subagent, no user-visible prepared/completed/model-review/manual-review/read-only modes remain, and migration proves existing drafts and write evidence are preserved.
