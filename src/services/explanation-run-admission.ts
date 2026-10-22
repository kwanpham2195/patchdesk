import {
  parseInsightRunId,
  type ContentHash,
  type ReviewId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import type { InsightProvider } from "#src/domain/insight-provider";
import type { Review } from "#src/domain/review";
import type { ReviewSession } from "#src/domain/review-session";
import { err, ok, type Result } from "#src/domain/result";
import {
  guideResumeFailure,
  type GuideResumeRequest,
} from "./guide-generation-resume";
import type { GuideGenerationStarter } from "./guide-generation-service";
import { guideStartFailure } from "./guide-preparation-runtime";
import type {
  InsightCoordinatorFailure,
  InsightCoordinatorInput,
  InsightRunResponse,
  InsightStartHooks,
} from "./insight-run-coordinator";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

/** Selection and represented inputs resolved under the coordinator's Review lock. */
export type InsightStartResolution = {
  readonly review: Review;
  readonly provider: InsightProvider;
  readonly model: string;
  readonly session: ReviewSession;
  readonly hash: ContentHash;
};

/** Specialized admission releases the Review lock before preparation or generation begins. */
export class ExplanationRunAdmission {
  constructor(
    private readonly guide: GuideGenerationStarter | undefined,
    private readonly operations: ReviewOperationCoordinator,
    private readonly resolveStart: (
      input: InsightCoordinatorInput,
      hooks: InsightStartHooks | undefined,
    ) => Promise<Result<InsightStartResolution, InsightCoordinatorFailure>>,
    private readonly ensureMutableOwned: (
      profileId: WorkspaceProfileId,
      reviewId: ReviewId,
    ) => Promise<Result<void, InsightCoordinatorFailure>>,
  ) {}

  async start(
    input: InsightCoordinatorInput,
    hooks: InsightStartHooks | undefined,
  ): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> {
    if (this.guide === undefined) return err("not_available");
    if (
      (input.provider ?? "pi") !== "pi" ||
      input.reasoning === "minimal" ||
      input.reasoning === "xhigh"
    )
      return err("not_available");
    const admitted = await this.operations.withReviewLock(
      input.profileId,
      input.reviewId,
      () => this.resolveStart(input, hooks),
    );
    if (admitted._tag === "err") return admitted;
    const { review, model, session, hash } = admitted.value;
    const started = await this.guide.start({
      profileId: input.profileId,
      reviewId: input.reviewId,
      revision: review.updatedAt,
      sessionId: session.id,
      expectedHash: hash,
      headSha: session.key.headSha,
      baseSha: session.key.baseSha,
      reasoning: input.reasoning,
      selection: {
        provider: "pi",
        model,
        reasoning: input.reasoning,
        language: input.language,
      },
    });
    if (started._tag === "err") return err(guideStartFailure(started.error));
    const runId = parseInsightRunId(started.value.run.runId);
    if (runId._tag === "err") return err("storage_unavailable");
    // Request linkage cannot strand a run that already has a durable identity.
    await hooks?.started(review, runId.value).catch(() => undefined);
    return ok({ runId: runId.value, type: input.type, status: "queued" });
  }

  /** Resume still checks ownership and terminal Review status before reaching the generation service. */
  async resumeGuide(
    input: GuideResumeRequest,
  ): Promise<Result<void, InsightCoordinatorFailure>> {
    if (this.guide === undefined) return err("not_available");
    const ownership = await this.ensureMutableOwned(
      input.profileId,
      input.reviewId,
    );
    if (ownership._tag === "err") return ownership;
    const resumed = await this.guide.resume(input);
    return resumed._tag === "ok"
      ? resumed
      : err(guideResumeFailure(resumed.error));
  }
}
