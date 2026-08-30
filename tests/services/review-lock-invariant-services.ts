import { DirectSummaryReviewService } from "../../src/services/direct-summary-review-service";
import { PendingReviewService } from "../../src/services/pending-review-service";
import { PublishedFeedbackService } from "../../src/services/published-feedback-service";
import { ReviewLifecycleGate } from "../../src/services/review-lifecycle-gate";
import { ReviewObservationService } from "../../src/services/review-observation-service";
import type { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { ReviewRecoveryService } from "../../src/services/review-recovery-service";
import { ReviewRefreshService } from "../../src/services/review-refresh-service";
import { ReviewWorkbenchController } from "../../src/services/review-workbench-controller";
import { err, ok } from "../../src/domain/result";
import { now, values, type Recorder } from "./review-invariant-fixtures";

/**
 * The dependency stubs and service constructions `review-lock-invariants.test.ts`
 * shares. Every stub is a recorder: calling one is what "the entry point
 * began" means, so a service that touched a dependency while another caller
 * held the Review lock is visible as a non-empty `touched` list.
 *
 * The values each stub answers with are deliberately shallow. Each row asserts
 * WHEN a service starts, not what it computes; the flow's own suite owns the
 * outcome.
 */

/** The gateway every write row shares; no row reaches a real GitHub call. */
export function gateway(track: Recorder) {
  return {
    getPullRequest: track.stub(
      "getPullRequest",
      ok(values.snapshot.pullRequest),
    ),
    getPullRequestDiff: track.stub("getPullRequestDiff", ok("")),
    getPullRequestComments: track.stub(
      "getPullRequestComments",
      ok(values.snapshot.comments),
    ),
    getPullRequestCommits: track.stub("getPullRequestCommits", ok([])),
    getPullRequestChecks: track.stub(
      "getPullRequestChecks",
      ok(values.snapshot.checks),
    ),
    getPullRequestPublishedFeedback: track.stub(
      "getPullRequestPublishedFeedback",
      ok({ reviews: [], comments: [], complete: true }),
    ),
    getReviewThreadTarget: track.stub(
      "getReviewThreadTarget",
      ok({ found: false }),
    ),
    getReviewCommentTarget: track.stub(
      "getReviewCommentTarget",
      ok({ found: false }),
    ),
    getMergePolicy: track.stub(
      "getMergePolicy",
      err({ _tag: "GitHubReadFailed" }),
    ),
    loadConversation: track.stub(
      "loadConversation",
      ok(values.snapshot.conversation),
    ),
    resolveAuthenticatedAccount: track.stub(
      "resolveAuthenticatedAccount",
      err({ _tag: "GitHubReadFailed" }),
    ),
    getRepositoryPermission: track.stub(
      "getRepositoryPermission",
      err({ _tag: "GitHubReadFailed" }),
    ),
    listAssignableUsers: track.stub(
      "listAssignableUsers",
      ok({ users: [], totalCount: 0 }),
    ),
    getPullRequestReviewers: track.stub(
      "getPullRequestReviewers",
      ok({
        requested: [],
        candidates: [],
        candidatesTotalCount: 0,
        complete: true,
      }),
    ),
    listRepositoryLabels: track.stub(
      "listRepositoryLabels",
      ok({ labels: [], totalCount: 0 }),
    ),
    getViewerPendingReview: track.stub(
      "getViewerPendingReview",
      ok({ _tag: "Unavailable" }),
    ),
    getViewerDirectSummaryReviews: track.stub(
      "getViewerDirectSummaryReviews",
      err({ _tag: "GitHubReadFailed" }),
    ),
    mergePullRequest: track.stub(
      "mergePullRequest",
      err({
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "unused",
      }),
    ),
  };
}

/** The write gate every write row shares; refusing rows never reach it. */
export function writeGate(track: Recorder) {
  return {
    requireFresh: track.stub(
      "requireFresh",
      ok({
        profile: values.profile,
        review: values.review,
        session: values.session,
        snapshot: values.snapshot,
      }),
    ),
    requireCurrentSession: track.stub(
      "requireCurrentSession",
      ok({
        profile: values.profile,
        review: values.review,
        session: values.session,
      }),
    ),
  };
}

export function sessionStore(track: Recorder) {
  return {
    load: track.stub("sessions.load", ok(values.session)),
    save: track.stub("sessions.save", ok(undefined)),
  };
}

export function recentWrites(track: Recorder) {
  return {
    append: track.stub("recentWrites.append", ok(undefined)),
    clear: track.stub("recentWrites.clear", ok(undefined)),
    prune: track.stub("recentWrites.prune", ok(undefined)),
    load: track.stub("recentWrites.load", ok([])),
  };
}

export function workbenchController(
  coordinator: ReviewOperationCoordinator,
  track: Recorder,
): ReviewWorkbenchController {
  // SAFETY: recorded partial dependencies expose lock timing; each service's own suite covers its result behavior.
  return new ReviewWorkbenchController(
    {
      prepare: track.stub(
        "prepare",
        err({ _tag: "SessionStorageUnavailable" }),
      ),
    } as never,
    {} as never,
    {
      reviews: {
        load: track.stub("reviews.load", err({ reason: "not_found" })),
        save: track.stub("reviews.save", ok(undefined)),
      },
      sessions: { load: track.stub("sessions.load", ok(values.session)) },
      artifacts: {
        quarantineIfPresent: track.stub("quarantineIfPresent", ok(undefined)),
        quarantineReview: track.stub("quarantineReview", ok(undefined)),
      },
      remote: { load: track.stub("remote.load", ok(values.snapshot)) },
      journals: { load: track.stub("journals.load", ok(undefined)) },
      recentWrites: { load: track.stub("recentWrites.load", ok([])) },
      refresh: {
        refreshUnlocked: track.stub(
          "refreshUnlocked",
          err({ reason: "storage" }),
        ),
      },
      observation: {
        observe: track.stub("observe", err({ reason: "storage" })),
        recover: track.stub("recover", err({ reason: "storage" })),
        recoverUnlocked: track.stub(
          "recoverUnlocked",
          err({ reason: "storage" }),
        ),
      },
      coordinator,
      commits: {
        list: track.stub("commits.list", ok([])),
        diff: track.stub("commits.diff", err({ reason: "not_found" })),
      },
    } as never,
  );
}

export function observationService(
  coordinator: ReviewOperationCoordinator,
  track: Recorder,
): ReviewObservationService {
  // SAFETY: recorded partial dependencies expose lock timing; each service's own suite covers its result behavior.
  return new ReviewObservationService({
    profiles: { load: track.stub("profiles.load", ok(values.profile)) },
    reviews: {
      load: track.stub("reviews.load", err({ reason: "not_found" })),
      save: track.stub("reviews.save", ok(undefined)),
    },
    sessions: sessionStore(track),
    remote: {
      load: track.stub("remote.load", ok(values.snapshot)),
      saveCandidate: track.stub("remote.saveCandidate", err({ reason: "io" })),
    },
    journals: {
      load: track.stub("journals.load", ok(undefined)),
      save: track.stub("journals.save", ok(undefined)),
      remove: track.stub("journals.remove", ok(undefined)),
    },
    recentWrites: recentWrites(track),
    github: gateway(track),
    pendingReview: { adoptObservedState: () => ({}) },
    coordinator,
    now,
  } as never);
}

export function refreshService(
  coordinator: ReviewOperationCoordinator,
  track: Recorder,
): ReviewRefreshService {
  // SAFETY: recorded partial dependencies expose lock timing; each service's own suite covers its result behavior.
  return new ReviewRefreshService({
    profiles: { load: track.stub("profiles.load", ok(values.profile)) },
    reviews: {
      load: track.stub("reviews.load", err({ reason: "not_found" })),
      save: track.stub("reviews.save", ok(undefined)),
    },
    sessions: sessionStore(track),
    remote: {
      load: track.stub("remote.load", ok(values.snapshot)),
      saveCandidate: track.stub("remote.saveCandidate", err({ reason: "io" })),
    },
    github: gateway(track),
    preparation: {
      prepare: track.stub(
        "prepare",
        err({ _tag: "SessionStorageUnavailable" }),
      ),
    },
    now,
    pendingReview: {
      reconcileWithinReviewLock: track.stub(
        "reconcileWithinReviewLock",
        err({ reason: "storage" }),
      ),
    },
    recentWrites: recentWrites(track),
    operationCoordinator: coordinator,
  } as never);
}

export function recoveryService(
  coordinator: ReviewOperationCoordinator,
  track: Recorder,
): ReviewRecoveryService {
  // SAFETY: recorded partial dependencies expose lock timing; each service's own suite covers its result behavior.
  return new ReviewRecoveryService(
    {
      list: track.stub("profiles.list", ok([])),
      load: track.stub("profiles.load", ok({})),
    } as never,
    {
      scanSessionEntries: track.stub(
        "scanSessionEntries",
        ok({ sessions: [], invalidEntries: [] }),
      ),
    } as never,
    now,
    {
      lifecycleGate: new ReviewLifecycleGate(),
      operationCoordinator: coordinator,
      reviews: {
        load: track.stub("reviews.load", err({ reason: "not_found" })),
        save: track.stub("reviews.save", ok(undefined)),
      },
      mergeOperations: {
        listPending: track.stub("mergeOperations.listPending", ok([])),
        removeAfterSessionReceipt: track.stub(
          "mergeOperations.remove",
          ok(undefined),
        ),
      },
      github: {
        getMergeOutcome: track.stub(
          "getMergeOutcome",
          err({ _tag: "GitHubReadFailed" }),
        ),
      },
    } as never,
  );
}

export function pendingReviewService(
  coordinator: ReviewOperationCoordinator,
  track: Recorder,
): PendingReviewService {
  // SAFETY: recorded partial dependencies expose lock timing; each service's own suite covers its result behavior.
  return new PendingReviewService(
    writeGate(track) as never,
    sessionStore(track),
    gateway(track) as never,
    now,
    coordinator,
    recentWrites(track),
  );
}

export function directSummaryService(
  coordinator: ReviewOperationCoordinator,
  track: Recorder,
): DirectSummaryReviewService {
  // SAFETY: recorded partial dependencies expose lock timing; each service's own suite covers its result behavior.
  return new DirectSummaryReviewService(
    writeGate(track) as never,
    sessionStore(track),
    gateway(track) as never,
    now,
    coordinator,
    recentWrites(track),
  );
}

export function publishedFeedbackService(
  coordinator: ReviewOperationCoordinator,
  track: Recorder,
): PublishedFeedbackService {
  // SAFETY: recorded partial dependencies expose lock timing; each service's own suite covers its result behavior.
  return new PublishedFeedbackService(
    writeGate(track) as never,
    gateway(track) as never,
    coordinator,
    now,
    recentWrites(track),
    {
      load: track.stub("reviewWriteOperations.load", ok(undefined)),
      begin: track.stub("reviewWriteOperations.begin", ok(undefined)),
      markOutcomeUnknown: track.stub(
        "reviewWriteOperations.markOutcomeUnknown",
        ok(undefined),
      ),
      confirm: track.stub("reviewWriteOperations.confirm", ok(undefined)),
      reject: track.stub("reviewWriteOperations.reject", ok(undefined)),
      remove: track.stub("reviewWriteOperations.remove", ok(undefined)),
    },
  );
}
