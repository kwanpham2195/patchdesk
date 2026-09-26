import { minLength, pipe, string, strictObject } from "valibot";

import type { InsightStore } from "../adapters/storage/insight-store";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import {
  findAgentRunRequest,
  putAgentRunRequest,
  type AgentRunRequest,
} from "../domain/agent-run-request";
import { definedProps } from "../domain/defined-props";
import type { FailureKinds } from "../domain/failure-kind";
import type {
  AgentRunRequestId,
  InsightRunId,
  IsoTimestamp,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import type { InsightType } from "../domain/insight-record";
import { err, ok, type Result } from "../domain/result";
import {
  isLocalReview,
  reviewRequestSchema,
  setAgentRunRequests,
  type Review,
} from "../domain/review";
import type { LocalReviewSource } from "../domain/review-source";
import type { AppLogService } from "./app-log-service";
import {
  postDesktopNotification,
  type DesktopNotifier,
} from "./desktop-notifier";
import type {
  InsightCoordinatorFailure,
  InsightCoordinatorInput,
  InsightRunCoordinator,
  InsightRunResponse,
} from "./insight-run-coordinator";
import { localReviewNotificationSubject } from "./local-review-notification-subject";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

export type AgentRunRequestFailure = {
  readonly reason:
    | "not_found"
    /** A pull request Review, which an agent never asks to run on. */
    | "not_applicable"
    /** The session named is not the Review's current one. */
    | "stale_session"
    /** Decline names a request that is not awaiting approval, or that the Review's move dropped. */
    | "request_not_awaiting"
    | "in_progress"
    | "terminal"
    | "storage";
};

/** How each agent run request refusal is classified (ADR 0052 "Error model"). */
export const agentRunRequestFailureKinds = {
  not_found: "not_found",
  not_applicable: "conflict",
  stale_session: "conflict",
  request_not_awaiting: "conflict",
  in_progress: "conflict",
  terminal: "conflict",
  storage: "unavailable",
} as const satisfies FailureKinds<AgentRunRequestFailure["reason"]>;

/** The wire form of `decline`'s request. */
export const agentRunDeclineRequestSchema = strictObject({
  ...reviewRequestSchema.entries,
  requestId: pipe(string(), minLength(1)),
});

/**
 * What `run_insight` answers: the request, or `running` with the run's id
 * when a run of that type is already active on the session and no agent
 * asked for it.
 */
export type AgentRunRequestReply = {
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly type: InsightType;
  readonly status: AgentRunRequest["status"] | "running";
  readonly requestId?: AgentRunRequestId;
  readonly runId?: InsightRunId;
};

type AgentRunRequestDependencies = {
  readonly reviews: Pick<ReviewStore, "load" | "save">;
  readonly insights: Pick<InsightStore, "load">;
  readonly profiles: Pick<ProfileStore, "list">;
  readonly coordinator: Pick<
    ReviewOperationCoordinator,
    "acquire" | "release" | "withReviewLock"
  >;
  readonly notifier?: DesktopNotifier;
  readonly logs?: Pick<AppLogService, "write">;
  readonly now: () => IsoTimestamp;
  readonly createRequestId: () => AgentRunRequestId;
};

/**
 * Records, approves, and declines a coding agent's Insight run requests
 * (ADR 0052 "Per-run approval in the app"). A request never starts a run by
 * itself: approval starts it through `InsightRunCoordinator.start`, with the
 * Run button's revalidation, Review lock, and one-run-per-type rule.
 */
export class AgentRunRequestService {
  constructor(private readonly dependencies: AgentRunRequestDependencies) {}

  /**
   * An agent's `run_insight`. A request already awaiting, approved with its
   * run still active, or declined is answered as it stands and posts
   * nothing; otherwise a new request is recorded and one notification posted.
   */
  async request(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly sessionId: ReviewSessionId;
    readonly type: InsightType;
    readonly clientName?: string;
  }): Promise<Result<AgentRunRequestReply, AgentRunRequestFailure>> {
    // `recorded` is the Review a new request was saved on, which the notification names.
    const recorded = await this.withLocalReview<{
      readonly reply: AgentRunRequestReply;
      readonly recorded?: Review<LocalReviewSource>;
    }>(input, async (review) => {
      if (input.sessionId !== review.currentSessionId)
        return err({ reason: "stale_session" });
      const activeRun = await this.activeRunOn(input);
      if (activeRun._tag === "err") return activeRun;
      const reply = {
        reviewId: review.id,
        sessionId: input.sessionId,
        type: input.type,
      };
      const existing = findAgentRunRequest(
        review.agentRunRequests,
        input.sessionId,
        input.type,
      );
      // An approved request whose run settled may be asked again, which needs a new approval.
      if (
        existing !== undefined &&
        (existing.status !== "approved" || existing.runId === activeRun.value)
      )
        return ok({ reply: { ...reply, ...requestReply(existing) } });
      if (activeRun.value !== undefined)
        return ok({
          reply: { ...reply, status: "running", runId: activeRun.value },
        });
      const request: AgentRunRequest = {
        requestId: this.dependencies.createRequestId(),
        sessionId: input.sessionId,
        type: input.type,
        requestedAt: this.dependencies.now(),
        status: "awaiting_approval",
        ...definedProps({ clientName: input.clientName }),
      };
      const saved = await this.save(
        review,
        putAgentRunRequest(review.agentRunRequests, request),
      );
      if (saved._tag === "err") return saved;
      return ok({
        reply: { ...reply, ...requestReply(request) },
        recorded: saved.value,
      });
    });
    if (recorded._tag === "err") return recorded;
    if (recorded.value.recorded !== undefined)
      await this.notify(recorded.value.recorded, input.type);
    return ok(recorded.value.reply);
  }

  /**
   * Run on the Insights tab. The start approves the session's awaiting
   * request of that type, so `run_insight`, `get_insight`, and the Agent
   * requests bar agree; with `requestId` it is refused unless that request
   * still awaits. The check and the link run inside the start's Review lock,
   * so a Decline cannot land between them.
   */
  async startRun(
    runs: Pick<InsightRunCoordinator, "start">,
    input: InsightCoordinatorInput & { readonly requestId?: AgentRunRequestId },
  ): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> {
    const { requestId, ...start } = input;
    return runs.start(start, {
      admit: (review) =>
        requestId === undefined ||
        awaitingRequestOf(review, input.type)?.requestId === requestId
          ? undefined
          : "request_not_awaiting",
      started: async (review, runId) => {
        const request = awaitingRequestOf(review, input.type);
        if (request === undefined || !isLocalReview(review)) return;
        const linked = await this.save(
          review,
          putAgentRunRequest(review.agentRunRequests, {
            ...request,
            status: "approved",
            runId,
          }),
        ).catch(() => err({ reason: "storage" as const }));
        // The run has already begun, so a failed link is logged rather than refused.
        if (linked._tag === "err")
          this.dependencies.logs?.write({
            process: "main",
            level: "warn",
            topic: "agent-run-request",
            message: "Started run was not linked to its agent run request",
            profileId: input.profileId,
            sessionId: review.currentSessionId,
            meta: {
              reviewId: input.reviewId,
              requestId: request.requestId,
              runId,
              reason: linked.error.reason,
            },
          });
      },
    });
  }

  /** Decline on the Agent requests bar: final for the request's session. */
  async decline(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly requestId: AgentRunRequestId;
  }): Promise<
    Result<{ readonly request: AgentRunRequest }, AgentRunRequestFailure>
  > {
    return this.withLocalReview(input, async (review) => {
      const request = awaitingRequest(review, input);
      if (request === undefined) return err({ reason: "request_not_awaiting" });
      const declined: AgentRunRequest = { ...request, status: "declined" };
      const saved = await this.save(
        review,
        putAgentRunRequest(review.agentRunRequests, declined),
      );
      return saved._tag === "ok" ? ok({ request: declined }) : saved;
    });
  }

  /** Runs `write` on the loaded local Review while holding its lock, refused rather than waiting. */
  private async withLocalReview<T>(
    input: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
    },
    write: (
      review: Review<LocalReviewSource>,
    ) => Promise<Result<T, AgentRunRequestFailure>>,
  ): Promise<Result<T, AgentRunRequestFailure>> {
    const key = `${input.profileId}:${input.reviewId}`;
    if (!this.dependencies.coordinator.acquire(key))
      return err({ reason: "in_progress" });
    try {
      const loaded = await this.dependencies.reviews.load(
        input.profileId,
        input.reviewId,
      );
      if (loaded._tag === "err")
        return err({
          reason: loaded.error.reason === "not_found" ? "not_found" : "storage",
        });
      if (!isLocalReview(loaded.value))
        return err({ reason: "not_applicable" });
      return await write(loaded.value);
    } finally {
      this.dependencies.coordinator.release(key);
    }
  }

  /** The id of the run of this type active on the session, if any. */
  private async activeRunOn(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly sessionId: ReviewSessionId;
    readonly type: InsightType;
  }): Promise<Result<InsightRunId | undefined, AgentRunRequestFailure>> {
    const record = await this.dependencies.insights.load(
      input.profileId,
      input.reviewId,
      input.type,
    );
    if (record._tag === "err")
      return record.error.reason === "not_found"
        ? ok(undefined)
        : err({ reason: "storage" });
    const run = record.value.activeRun;
    return ok(run?.revision.sessionId === input.sessionId ? run.id : undefined);
  }

  private async save(
    review: Review<LocalReviewSource>,
    requests: ReadonlyArray<AgentRunRequest>,
  ): Promise<Result<Review<LocalReviewSource>, AgentRunRequestFailure>> {
    const next = setAgentRunRequests(review, requests, this.dependencies.now());
    if (next._tag === "err") return err({ reason: "terminal" });
    const saved = await this.dependencies.reviews.save(
      next.value,
      review.updatedAt,
    );
    return saved._tag === "ok" ? ok(next.value) : err({ reason: "storage" });
  }

  private async notify(
    review: Review<LocalReviewSource>,
    insightType: InsightType,
  ): Promise<void> {
    const subject = await localReviewNotificationSubject(
      this.dependencies.profiles,
      review,
    );
    postDesktopNotification(this.dependencies.notifier, {
      _tag: "AgentRunRequested",
      reviewId: review.id,
      insightType,
      ...subject,
    });
  }
}

function requestReply(
  request: AgentRunRequest,
): Pick<AgentRunRequestReply, "status" | "requestId" | "runId"> {
  return {
    status: request.status,
    requestId: request.requestId,
    ...definedProps({
      runId: request.status === "approved" ? request.runId : undefined,
    }),
  };
}

/** The current session's request of `type`, while it awaits approval. */
function awaitingRequestOf(
  review: Review,
  type: InsightType,
): AgentRunRequest | undefined {
  const request = isLocalReview(review)
    ? findAgentRunRequest(
        review.agentRunRequests,
        review.currentSessionId,
        type,
      )
    : undefined;
  return request?.status === "awaiting_approval" ? request : undefined;
}

function awaitingRequest(
  review: Review,
  input: { readonly requestId: AgentRunRequestId },
): AgentRunRequest | undefined {
  return review.agentRunRequests?.find(
    (request) =>
      request.requestId === input.requestId &&
      request.status === "awaiting_approval",
  );
}
