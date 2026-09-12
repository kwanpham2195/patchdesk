import { InlineConversationService } from "../../src/services/inline-conversation-service";
import type { InsightRunCoordinator } from "../../src/services/insight-run-coordinator";
import { LabelService } from "../../src/services/label-service";
import { AssigneeService } from "../../src/services/assignee-service";
import { ReviewerService } from "../../src/services/reviewer-service";
import { MergeWriteController } from "../../src/services/merge-write-controller";
import type { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import type { ReviewWorkbenchController } from "../../src/services/review-workbench-controller";
import { ok, type Result } from "../../src/domain/result";
import {
  anchor,
  at,
  expected,
  findingId,
  insightRunId,
  now,
  profileId,
  reviewId,
  threadId,
  values,
  type Recorder,
} from "./review-invariant-fixtures";
import {
  directSummaryService,
  gateway,
  insightRunCoordinator,
  observationService,
  pendingReviewService,
  publishedFeedbackService,
  recentWrites,
  recoveryService,
  refreshService,
  workbenchController,
  writeGate,
} from "./review-lock-invariant-services";

function reviewWriteOperations(track: Recorder) {
  return {
    load: track.stub("reviewWriteOperations.load", ok(undefined)),
    begin: track.stub("reviewWriteOperations.begin", ok(undefined)),
    markOutcomeUnknown: track.stub(
      "reviewWriteOperations.markOutcomeUnknown",
      ok(undefined),
    ),
    confirm: track.stub("reviewWriteOperations.confirm", ok(undefined)),
    reject: track.stub("reviewWriteOperations.reject", ok(undefined)),
    remove: track.stub("reviewWriteOperations.remove", ok(undefined)),
  };
}

/**
 * Every entry point that can touch one Review, and the shape in which each
 * respects the coordinator lock. The three shapes are not a style choice:
 *
 * - `queues` — `withReviewLock`. The operation body does not start; it runs
 *   after release.
 * - `refuses` — `acquire`/`release`. A command caller must not sit behind
 *   another user action, so it returns an immediate typed in-progress result.
 * - `reads` — no Review lock at all, on purpose. The row names the exact
 *   dependency trace the read runs while another caller holds the lock, so
 *   adding a lock here goes red as loudly as widening the read does.
 */

/**
 * What a Review entry point answers with: a `Result` for every service and
 * controller here, or `ReviewRecoveryService`'s own reconciliation tally.
 */
export type LockRowOutcome =
  | Result<unknown, unknown>
  | { readonly recovered: number; readonly failed: number };

type LockRowEntry = {
  readonly name: string;
  readonly build: (
    coordinator: ReviewOperationCoordinator,
    track: Recorder,
  ) => () => Promise<LockRowOutcome>;
  /** Set when the row fails on `main`; names the program item that fixes it. */
  readonly todo?: string;
};

export type LockRow = LockRowEntry &
  (
    | { readonly kind: "queues" }
    /** The exact result a `refuses` row must return while the lock is held. */
    | { readonly kind: "refuses"; readonly refusal: unknown }
    /** Every dependency a `reads` row touches while the lock is held, in order. */
    | { readonly kind: "reads"; readonly unlockedPrefix: ReadonlyArray<string> }
  );

export const REVIEW_WRITE_IN_PROGRESS = {
  _tag: "err",
  error: "review_write_in_progress",
};

/**
 * The controller's two still-red Review entry points. Both touch a durable
 * store before any lock, and the suite docstring names the exact dependency and
 * the `src/` change that turns each green. They share this shape because the
 * row IS the method call.
 */
function controllerRead(
  method: "load" | "detectUpdates",
  todo: string,
  call: (controller: ReviewWorkbenchController) => Promise<LockRowOutcome>,
): LockRow {
  return {
    name: `ReviewWorkbenchController.${method}`,
    kind: "queues",
    todo,
    build: (coordinator, track) => {
      const controller = workbenchController(coordinator, track);
      return () => call(controller);
    },
  };
}

/**
 * `InsightRunCoordinator`'s Review entry points. The row IS the method call, so
 * only the construction is shared. Every row is answered before its run id,
 * finding id or progress reaches storage, so the fixture values only need to be
 * well formed.
 */
function insightBuild(
  call: (coordinator: InsightRunCoordinator) => Promise<LockRowOutcome>,
): LockRow["build"] {
  return (coordinator, track) => {
    const insights = insightRunCoordinator(coordinator, track);
    return () => call(insights);
  };
}

export const lockRows: ReadonlyArray<LockRow> = [
  {
    name: "ReviewWorkbenchController.open",
    kind: "queues",
    build: (coordinator, track) => {
      const controller = workbenchController(coordinator, track);
      return () =>
        controller.open({
          profileId,
          host: values.identity.host,
          owner: values.identity.owner,
          repo: values.identity.repo,
          number: values.identity.prNumber,
        });
    },
  },
  {
    name: "ReviewWorkbenchController.openMerged",
    kind: "queues",
    build: (coordinator, track) => {
      const controller = workbenchController(coordinator, track);
      return () =>
        controller.openMerged({
          profileId,
          host: values.identity.host,
          owner: values.identity.owner,
          repo: values.identity.repo,
          number: values.identity.prNumber,
        });
    },
  },
  controllerRead(
    "load",
    "no program item — reads journals.load then reviews.load before any lock",
    (controller) => controller.load({ profileId, reviewId }),
  ),
  // `observe` is a stub here, so the trace's second entry is that stub, not
  // the real locked `ReviewObservationService.observe`. The finding is the
  // FIRST entry: `recentWrites.load`, read before anything takes the lock.
  controllerRead(
    "detectUpdates",
    "no program item — reads recentWrites.load before delegating to the locked observe",
    (controller) => controller.detectUpdates({ profileId, reviewId }),
  ),
  {
    // Pinned unlocked: `commits.diff` re-validates the Review, the snapshot hash
    // and the session before diffing immutable commit objects, and locking it
    // would fail any user command that landed mid-read. The suite docstring
    // carries the full reasoning.
    name: "ReviewWorkbenchController.commitDiff",
    kind: "reads",
    unlockedPrefix: ["commits.diff"],
    build: (coordinator, track) => {
      const controller = workbenchController(coordinator, track);
      return () =>
        controller.commitDiff({
          profileId,
          reviewId,
          commitSha: values.headSha,
        });
    },
  },
  {
    name: "ReviewRefreshService.refresh",
    kind: "queues",
    build: (coordinator, track) => {
      const service = refreshService(coordinator, track);
      return () => service.refresh({ profileId, reviewId });
    },
  },
  {
    name: "ReviewObservationService.observe",
    kind: "queues",
    build: (coordinator, track) => {
      const service = observationService(coordinator, track);
      return () => service.observe({ profileId, reviewId });
    },
  },
  {
    name: "ReviewObservationService.recover",
    kind: "queues",
    build: (coordinator, track) => {
      const service = observationService(coordinator, track);
      return () => service.recover({ profileId, reviewId });
    },
  },
  {
    name: "PendingReviewService.reconcile",
    kind: "queues",
    build: (coordinator, track) => {
      const service = pendingReviewService(coordinator, track);
      return () => service.reconcile({ profileId, reviewId });
    },
  },
  {
    name: "ReviewRecoveryService.reconcileReview",
    kind: "queues",
    build: (coordinator, track) => {
      const service = recoveryService(coordinator, track);
      return () => service.reconcileReview(profileId, reviewId);
    },
  },
  {
    name: "InsightRunCoordinator.start",
    kind: "queues",
    build: insightBuild((insights) =>
      insights.start({
        profileId,
        reviewId,
        type: "analysis",
        model: "gpt-5-codex",
        reasoning: "high",
      }),
    ),
  },
  {
    name: "InsightRunCoordinator.cancel",
    kind: "queues",
    build: insightBuild((insights) =>
      insights.cancel({
        profileId,
        reviewId,
        type: "analysis",
        runId: insightRunId,
      }),
    ),
  },
  {
    name: "InsightRunCoordinator.dismissFinding",
    kind: "queues",
    build: insightBuild((insights) =>
      insights.dismissFinding({
        profileId,
        reviewId,
        runId: insightRunId,
        findingId,
        reason: "handled elsewhere",
      }),
    ),
  },
  {
    name: "InsightRunCoordinator.updateWalkthroughProgress",
    kind: "queues",
    build: insightBuild((insights) =>
      insights.updateWalkthroughProgress({
        profileId,
        reviewId,
        runId: insightRunId,
        progress: { reviewedSectionIds: [], supportReviewed: false },
      }),
    ),
  },
  {
    name: "InsightRunCoordinator.recover",
    kind: "queues",
    build: insightBuild((insights) =>
      insights.recover({ profileId, reviewId, type: "analysis" }),
    ),
  },
  {
    // Pinned unlocked with `commitDiff`: an atomically written Insight record
    // read back for one run id, so a half-written record is unobservable.
    name: "InsightRunCoordinator.observe",
    kind: "reads",
    unlockedPrefix: ["reviews.load", "insights.load"],
    build: insightBuild((insights) =>
      insights.observe({
        profileId,
        reviewId,
        type: "analysis",
        runId: insightRunId,
      }),
    ),
  },
  {
    // Pinned unlocked: the ownership check is the whole body, and the route is
    // refused before it can write.
    name: "InsightRunCoordinator.addFinding",
    kind: "reads",
    unlockedPrefix: ["reviews.load"],
    build: insightBuild((insights) =>
      insights.addFinding({
        profileId,
        reviewId,
        runId: insightRunId,
        findingId,
      }),
    ),
  },
  {
    name: "PendingReviewService.start",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = pendingReviewService(coordinator, track);
      return () =>
        service.start({ profileId, reviewId, expected, anchor, body: "note" });
    },
  },
  {
    name: "PendingReviewService.addThread",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = pendingReviewService(coordinator, track);
      return () =>
        service.addThread({
          profileId,
          reviewId,
          expected,
          anchor,
          body: "note",
          // SAFETY: a well-formed review node id; this row never reaches it.
          pendingReviewNodeId: "PRR_kwDORJzsQM7e6QwJ" as never,
        });
    },
  },
  {
    name: "PendingReviewService.submit",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = pendingReviewService(coordinator, track);
      return () =>
        service.submit({
          profileId,
          reviewId,
          expected,
          event: "COMMENT",
          summaryBody: "summary",
        });
    },
  },
  {
    name: "PendingReviewService.discard",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = pendingReviewService(coordinator, track);
      return () =>
        service.discard({ profileId, reviewId, expected, confirmation: true });
    },
  },
  {
    name: "DirectSummaryReviewService.submit",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = directSummaryService(coordinator, track);
      return () =>
        service.submit({
          profileId,
          reviewId,
          expected,
          event: "COMMENT",
          body: "summary",
        });
    },
  },
  {
    name: "DirectSummaryReviewService.reconcile",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = directSummaryService(coordinator, track);
      return () => service.reconcile({ profileId, reviewId });
    },
  },
  {
    name: "InlineConversationService.execute",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = new InlineConversationService(
        // SAFETY: recorded stubs; this row refuses before reaching either.
        writeGate(track) as never,
        // SAFETY: this row refuses before the recorded gateway is called.
        gateway(track) as never,
        coordinator,
        now,
        recentWrites(track),
        // SAFETY: this row is refused by the coordinator before operation storage is reached.
        {} as never,
      );
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: { _tag: "Reply", expected, threadId, body: "note" },
        });
    },
  },
  {
    name: "PublishedFeedbackService.editComment",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = publishedFeedbackService(coordinator, track);
      return () =>
        service.editComment({
          profileId,
          reviewId,
          expected,
          commentId: "comment-1",
          body: "edited",
        });
    },
  },
  {
    name: "PublishedFeedbackService.deleteComment",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = publishedFeedbackService(coordinator, track);
      return () =>
        service.deleteComment({
          profileId,
          reviewId,
          expected,
          commentId: "comment-1",
          confirmation: true,
        });
    },
  },
  {
    name: "PublishedFeedbackService.dismissReview",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = publishedFeedbackService(coordinator, track);
      return () =>
        service.dismissReview({
          profileId,
          reviewId,
          expected,
          publishedReviewId: "101",
          message: "stale",
          confirmation: true,
        });
    },
  },
  {
    name: "MergeWriteController.merge",
    kind: "refuses",
    refusal: { _tag: "err", error: { reason: "merge_in_progress" } },
    build: (coordinator, track) => {
      const controller = new MergeWriteController(
        // SAFETY: recorded stubs; this row refuses before reaching any of them.
        gateway(track) as never,
        ["squash"],
        now,
        // SAFETY: this row refuses before the partial operation-store fixture is read.
        {
          begin: track.stub("mergeOperations.begin", ok(undefined)),
          markOutcomeUnknown: track.stub(
            "mergeOperations.markOutcomeUnknown",
            ok(undefined),
          ),
          confirm: track.stub("mergeOperations.confirm", ok(undefined)),
          reject: track.stub("mergeOperations.reject", ok(undefined)),
          removeAfterSessionReceipt: track.stub(
            "mergeOperations.remove",
            ok(undefined),
          ),
        } as never,
        // SAFETY: this row refuses before the recorded write gate is called.
        writeGate(track) as never,
        // SAFETY: recorded stubs; this row refuses before it reads either.
        {
          reviews: {
            load: track.stub("reviews.load", ok(values.review)),
            save: track.stub("reviews.save", ok(undefined)),
          },
          insights: {
            loadTyped: track.stub("insights.loadTyped", ok(undefined)),
          },
        } as never,
        coordinator,
      );
      return () =>
        controller.merge({
          profileId,
          reviewId,
          sessionId: values.session.id,
          expectedHeadSha: values.headSha,
          expectedBaseSha: values.baseSha,
          expectedPatchHash: expected.patchHash,
          expectedRevision: at,
          method: "squash",
          acknowledgedWarnings: {
            revision: {
              headSha: values.headSha,
              baseSha: values.baseSha,
              patchHash: expected.patchHash,
            },
            warningCodes: [],
          },
        });
    },
  },
  {
    name: "LabelService.execute",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = new LabelService(
        // SAFETY: recorded stubs; this row refuses before reaching either.
        writeGate(track) as never,
        // SAFETY: this row refuses before the recorded gateway is called.
        gateway(track) as never,
        coordinator,
        now,
        recentWrites(track),
        reviewWriteOperations(track),
      );
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: { _tag: "AddLabels", labels: [{ id: "LA_1", name: "bug" }] },
        });
    },
  },
  {
    name: "AssigneeService.execute",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = new AssigneeService(
        // SAFETY: recorded stubs; this row refuses before reaching either.
        writeGate(track) as never,
        // SAFETY: this row refuses before the recorded gateway is called.
        gateway(track) as never,
        coordinator,
        now,
        recentWrites(track),
        reviewWriteOperations(track),
      );
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "AddAssignees",
            assignees: [{ id: "U_1", login: "fixture" }],
          },
        });
    },
  },
  {
    name: "ReviewerService.execute",
    kind: "refuses",
    refusal: REVIEW_WRITE_IN_PROGRESS,
    build: (coordinator, track) => {
      const service = new ReviewerService(
        // SAFETY: recorded stubs; this row refuses before reaching either.
        writeGate(track) as never,
        // SAFETY: this row refuses before the recorded gateway is called.
        gateway(track) as never,
        coordinator,
        now,
        recentWrites(track),
        reviewWriteOperations(track),
      );
      return () =>
        service.execute({
          profileId,
          reviewId,
          command: {
            _tag: "RequestReviewers",
            reviewers: [{ id: "U_1", login: "fixture" }],
          },
        });
    },
  },
];
