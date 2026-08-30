import type { GitSha } from "../domain/ids";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { InsightStore } from "../adapters/storage/insight-store";
import type { ReviewRemoteStore } from "../adapters/storage/review-remote-store";
import type { BriefEvidence } from "../domain/brief";
import { definedProps } from "../domain/defined-props";
import {
  parseContentHash,
  parseInsightRunId,
  parseIsoTimestamp,
  type ContentHash,
  type FindingId,
  type InsightRunId,
  type IsoTimestamp,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import {
  beginInsightRun,
  dismissInsightFinding,
  requestInsightCancellation,
  sameInsightRevision,
  updateWalkthroughProgress,
  type InsightRevision,
  type InsightType,
  type WalkthroughProgress,
} from "../domain/insight-record";
import type {
  InsightProvider,
  InsightReasoning,
} from "../domain/insight-provider";
import { parseReviewResult } from "../domain/review-result";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  canonicalModelId,
  type PiRuntimeModelCatalog,
} from "../adapters/pi/pi-runtime-model-catalog";
import type { BriefReachComputer } from "./brief-reach-service";
import type { InsightProviderCatalog } from "./insight-provider-catalog";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import { contentHash } from "./review-artifact-hash";
import { err, ok, type Result } from "../domain/result";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import { InsightRecovery } from "./insight-recovery";
import { InsightRunExecutor } from "./insight-run-executor";

export type InsightInvocationInput = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly runId: InsightRunId;
  readonly type: InsightType;
  readonly expectedHeadSha: GitSha;
  readonly contextPath: string;
  readonly reviewInputPath?: string;
  readonly patchPath: string;
  readonly worktreePath: string;
  /**
   * The pull request body and commits a Brief may cite. Present only for the
   * `brief` type: no other Insight resolves a citation against them, and
   * reading the represented remote snapshot costs a file read per run.
   */
  readonly briefEvidence?: BriefEvidence;
  readonly provider: InsightProvider;
  readonly model: string;
  readonly reasoning: InsightReasoning;
};
export type InsightInvoker = {
  invoke(
    input: InsightInvocationInput,
    options: { readonly signal: AbortSignal },
  ): Promise<
    Result<
      unknown,
      {
        readonly reason: string;
        readonly phase?: string;
        readonly stderr?: string;
      }
    >
  >;
};
export type InsightRunResponse = {
  readonly runId: InsightRunId;
  readonly type: InsightType;
  readonly status:
    | "queued"
    | "running"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled";
  readonly failureReason?:
    | "cancelled"
    | "failed"
    | "invalid_result"
    | "superseded";
};
export type InsightCoordinatorInput = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly type: InsightType;
  readonly provider?: InsightProvider;
  readonly model: string;
  readonly reasoning: InsightReasoning;
};
export type InsightCoordinatorFailure =
  | "invalid_request"
  | "not_found"
  | "ownership_mismatch"
  | "terminal_review"
  | "already_running"
  | "model_unavailable"
  | "catalog_unavailable"
  | "storage_unavailable"
  | "not_active"
  | "stale_request"
  | "not_available";

export type Active = {
  readonly runId: InsightRunId;
  readonly controller: AbortController;
};

export class InsightRunCoordinator {
  private readonly active = new Map<string, Active>();
  private readonly recovery: InsightRecovery;
  private readonly executor: InsightRunExecutor;

  constructor(
    private readonly reviews: Pick<ReviewStore, "load" | "findOwner" | "list">,
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly insights: InsightStore,
    private readonly paths: PatchdeskPaths,
    private readonly catalog: PiRuntimeModelCatalog,
    private readonly invokers: Readonly<Record<InsightType, InsightInvoker>>,
    private readonly operations: ReviewOperationCoordinator,
    private readonly now: () => IsoTimestamp = currentIsoTimestamp,
    private readonly diagnostics?: Pick<ReviewDiagnosticService, "record">,
    private readonly providerCatalog?: InsightProviderCatalog,
    /** Only a Brief run reads it, for the commits its `c*` aliases name. */
    private readonly remotes?: Pick<ReviewRemoteStore, "load">,
    /**
     * Counts a completed Brief's Reach block against the represented worktree.
     * Absent leaves the block off: every other Insight type ignores it.
     */
    private readonly reach?: BriefReachComputer,
  ) {
    this.recovery = new InsightRecovery(
      this.reviews,
      this.insights,
      this.paths,
      this.operations,
      this.active,
      () => this.now(),
      this.diagnostics,
    );
    this.executor = new InsightRunExecutor(
      this.reviews,
      this.sessions,
      this.insights,
      this.invokers,
      this.operations,
      this.active,
      () => this.now(),
      (input) => this.recovery.recover(input),
      this.diagnostics,
      this.reach,
    );
  }

  async start(
    input: InsightCoordinatorInput,
  ): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> {
    return this.operations.withReviewLock(input.profileId, input.reviewId, () =>
      this.startUnlocked(input),
    );
  }

  private async startUnlocked(
    input: InsightCoordinatorInput,
  ): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> {
    const review = await this.reviews.load(input.profileId, input.reviewId);
    if (review._tag === "err") {
      if (review.error.reason !== "not_found")
        return err("storage_unavailable");
      const owner = await this.reviews.findOwner?.(input.reviewId);
      if (owner?._tag === "err") return err("storage_unavailable");
      if (owner?.value !== undefined && owner.value !== input.profileId)
        return err("ownership_mismatch");
      return err("not_found");
    }
    if (review.value.status._tag === "Terminal") return err("terminal_review");
    const provider = input.provider ?? "pi";
    let model = input.model;
    if (provider === "pi") {
      if (input.reasoning === "minimal" || input.reasoning === "xhigh")
        return err("model_unavailable");
      const models = await this.catalog.get();
      if (models._tag === "err") return err("catalog_unavailable");
      const canonical =
        models.value.providers === undefined
          ? input.model
          : canonicalModelId(input.model);
      if (
        canonical === undefined ||
        !models.value.models.some((candidate) => candidate.id === canonical)
      )
        return err("model_unavailable");
      model = canonical;
    } else {
      if (this.providerCatalog === undefined) return err("catalog_unavailable");
      const validated = await this.providerCatalog.validate({
        provider,
        model: input.model,
        reasoning: input.reasoning,
      });
      if (validated._tag === "err") return err(validated.error);
    }
    const session = await this.sessions.load(
      input.profileId,
      review.value.currentSessionId,
    );
    if (session._tag === "err")
      return err(
        session.error.reason === "not_found"
          ? "not_found"
          : "storage_unavailable",
      );
    const hash = parseContentHash(await contentHash(session.value.patchPath));
    if (hash._tag === "err") return err("storage_unavailable");
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const record = await this.insights.load(
      input.profileId,
      input.reviewId,
      input.type,
    );
    const token = record._tag === "ok" ? record.value.nextToken : 1;
    const runId = parseInsightRunId(
      `insight-${input.type}-${token}-${session.value.key.headSha.slice(0, 12)}-${input.reviewId}`,
    );
    if (runId._tag === "err") return err("invalid_request");
    const revision: InsightRevision = {
      sessionId: session.value.id,
      headSha: session.value.key.headSha,
      patchHash: hash.value,
    };
    const started = await this.insights.mutate({
      profileId: input.profileId,
      reviewId: input.reviewId,
      type: input.type,
      now: timestamp.value,
      operation: (current) =>
        beginInsightRun(current, {
          id: runId.value,
          revision,
          provider,
          model,
          reasoning: input.reasoning,
          startedAt: timestamp.value,
        }),
    });
    if (started._tag === "err")
      return started.error === "already_running"
        ? err("already_running")
        : err("storage_unavailable");
    const controller = new AbortController();
    this.active.set(runId.value, { runId: runId.value, controller });
    const invocation = {
      profileId: input.profileId,
      reviewId: input.reviewId,
      sessionId: session.value.id,
      runId: runId.value,
      type: input.type,
      expectedHeadSha: session.value.key.headSha,
      contextPath: this.paths.preparedContextFile(
        input.profileId,
        session.value.id,
      ),
      reviewInputPath: this.paths.preparedReviewInputFile(
        input.profileId,
        session.value.id,
      ),
      patchPath: session.value.patchPath,
      worktreePath: session.value.worktree.path,
      ...definedProps({
        briefEvidence:
          input.type === "brief"
            ? await this.briefEvidence(
                input.profileId,
                input.reviewId,
                review.value.representedRemote?.snapshotHash,
                session.value.prContext?.description,
              )
            : undefined,
      }),
      provider,
      model,
      reasoning: input.reasoning,
    };
    void this.executor.execute(
      invocation,
      input.type,
      runId.value,
      hash.value,
      controller,
    );
    return ok({ runId: runId.value, type: input.type, status: "queued" });
  }

  /**
   * Collects what a Brief may cite outside the patch. Missing evidence is not a
   * failure: a Review with no stored remote snapshot still gets a Brief, built
   * from the patch hunks alone, and `normalizeBrief` decides whether the
   * citations that survived are enough.
   */
  private async briefEvidence(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    snapshotHash: ContentHash | undefined,
    description: string | undefined,
  ): Promise<BriefEvidence> {
    const remote =
      this.remotes === undefined || snapshotHash === undefined
        ? undefined
        : await this.remotes.load({ profileId, reviewId, snapshotHash });
    return {
      ...definedProps({
        description:
          description ??
          (remote?._tag === "ok"
            ? remote.value.pullRequest.description
            : undefined),
      }),
      commits:
        remote?._tag === "ok"
          ? remote.value.commits.map((commit) => ({
              sha: commit.sha,
              subject: commit.message.split("\n")[0] ?? "",
            }))
          : [],
    };
  }

  async cancel(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly type: InsightType;
    readonly runId: InsightRunId;
  }): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> {
    return this.operations.withReviewLock(input.profileId, input.reviewId, () =>
      this.cancelUnlocked(input),
    );
  }

  private async cancelUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly type: InsightType;
    readonly runId: InsightRunId;
  }): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> {
    const ownership = await this.ensureMutableOwned(
      input.profileId,
      input.reviewId,
    );
    if (ownership._tag === "err") return ownership;
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const changed = await this.insights.mutate({
      profileId: input.profileId,
      reviewId: input.reviewId,
      type: input.type,
      now: timestamp.value,
      operation: (record) =>
        requestInsightCancellation(record, input.runId, timestamp.value),
    });
    if (changed._tag === "err") {
      if (changed.error !== "not_active") return err("storage_unavailable");
      const observed = await this.observe(input);
      return observed._tag === "ok" ? observed : err("not_active");
    }
    this.active.get(input.runId)?.controller.abort();
    return ok({ runId: input.runId, type: input.type, status: "cancelling" });
  }

  async dismissFinding(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly runId: InsightRunId;
    readonly findingId: FindingId;
    readonly reason: string;
  }): Promise<
    Result<
      { readonly findingId: FindingId; readonly status: "dismissed" },
      InsightCoordinatorFailure
    >
  > {
    return this.operations.withReviewLock(input.profileId, input.reviewId, () =>
      this.dismissFindingUnlocked(input),
    );
  }

  private async dismissFindingUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly runId: InsightRunId;
    readonly findingId: FindingId;
    readonly reason: string;
  }): Promise<
    Result<
      { readonly findingId: FindingId; readonly status: "dismissed" },
      InsightCoordinatorFailure
    >
  > {
    const ownership = await this.ensureOwned(input.profileId, input.reviewId);
    if (ownership._tag === "err") return ownership;
    const review = await this.reviews.load(input.profileId, input.reviewId);
    if (review._tag === "err") return err("storage_unavailable");
    if (review.value.status._tag === "Terminal") return err("terminal_review");
    const session = await this.sessions.load(
      input.profileId,
      review.value.currentSessionId,
    );
    if (session._tag === "err")
      return err(
        session.error.reason === "not_found"
          ? "not_found"
          : "storage_unavailable",
      );
    const currentHash = parseContentHash(
      await contentHash(session.value.patchPath),
    );
    if (currentHash._tag === "err") return err("storage_unavailable");
    const retained = await this.insights.loadTyped(
      input.profileId,
      input.reviewId,
      "analysis",
      parseReviewResult,
    );
    if (retained._tag === "err")
      return err(
        retained.error.reason === "not_found"
          ? "not_found"
          : "storage_unavailable",
      );
    const retainedRecord = retained.value.retained;
    if (retainedRecord === undefined || retainedRecord.runId !== input.runId)
      return err("not_found");
    if (
      !sameInsightRevision(retainedRecord.revision, {
        sessionId: session.value.id,
        headSha: session.value.key.headSha,
        patchHash: currentHash.value,
      })
    )
      return err("stale_request");
    if (
      !retainedRecord.value.findings.some(
        (finding) => finding.id === input.findingId,
      )
    )
      return err("not_found");
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const changed = await this.insights.mutate({
      profileId: input.profileId,
      reviewId: input.reviewId,
      type: "analysis",
      now: timestamp.value,
      operation: (record) => {
        const stored = record.retained;
        if (
          record.activeRun !== undefined ||
          stored === undefined ||
          stored.runId !== input.runId
        )
          return err("not_available" as const);
        const parsed = parseReviewResult(stored.value);
        if (
          parsed._tag === "err" ||
          !parsed.value.findings.some(
            (finding) => finding.id === input.findingId,
          )
        )
          return err("not_available" as const);
        return dismissInsightFinding(
          record,
          input.findingId,
          input.reason,
          timestamp.value,
        );
      },
    });
    if (changed._tag === "err") {
      if (changed.error === "invalid_reason") return err("invalid_request");
      if (changed.error === "not_available") return err("not_available");
      return err("storage_unavailable");
    }
    return ok({ findingId: input.findingId, status: "dismissed" });
  }

  async updateWalkthroughProgress(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly runId: InsightRunId;
    readonly progress: WalkthroughProgress;
  }): Promise<Result<{ readonly status: "saved" }, InsightCoordinatorFailure>> {
    return this.operations.withReviewLock(input.profileId, input.reviewId, () =>
      this.updateWalkthroughProgressUnlocked(input),
    );
  }

  private async updateWalkthroughProgressUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly runId: InsightRunId;
    readonly progress: WalkthroughProgress;
  }): Promise<Result<{ readonly status: "saved" }, InsightCoordinatorFailure>> {
    const ownership = await this.ensureMutableOwned(
      input.profileId,
      input.reviewId,
    );
    if (ownership._tag === "err") return ownership;
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const changed = await this.insights.mutate({
      profileId: input.profileId,
      reviewId: input.reviewId,
      type: "walkthrough",
      now: timestamp.value,
      operation: (record) => {
        if (record.retained?.runId !== input.runId)
          return err("not_available" as const);
        return updateWalkthroughProgress(
          record,
          input.progress,
          timestamp.value,
        );
      },
    });
    if (changed._tag === "err")
      return err(
        changed.error === "not_available"
          ? "not_available"
          : "storage_unavailable",
      );
    return ok({ status: "saved" });
  }

  async addFinding(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly runId: InsightRunId;
    readonly findingId: FindingId;
  }): Promise<Result<never, InsightCoordinatorFailure>> {
    const ownership = await this.ensureOwned(input.profileId, input.reviewId);
    if (ownership._tag === "err") return ownership;
    return err("not_available");
  }

  async recover(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly type: InsightType;
  }): Promise<
    Result<InsightRunResponse | undefined, InsightCoordinatorFailure>
  > {
    return this.recovery.recover(input);
  }

  /** Startup sweep: fails every run a crash left active, across all profiles. */
  async recoverAll(): Promise<void> {
    return this.recovery.recoverAll();
  }

  async observe(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly type: InsightType;
    readonly runId: InsightRunId;
  }): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> {
    const ownership = await this.ensureOwned(input.profileId, input.reviewId);
    if (ownership._tag === "err") return ownership;
    const record = await this.insights.load(
      input.profileId,
      input.reviewId,
      input.type,
    );
    if (record._tag === "err")
      return err(
        record.error.reason === "not_found"
          ? "not_found"
          : "storage_unavailable",
      );
    if (record.value.activeRun?.id === input.runId)
      return ok({
        runId: input.runId,
        type: input.type,
        status: record.value.activeRun.status,
      });
    if (record.value.retained?.runId === input.runId) {
      return ok({ runId: input.runId, type: input.type, status: "completed" });
    }
    if (record.value.replacementFailure?.runId === input.runId)
      return ok({
        runId: input.runId,
        type: input.type,
        status:
          record.value.replacementFailure.reason === "cancelled"
            ? "cancelled"
            : "failed",
        failureReason: record.value.replacementFailure.reason,
      });
    return err("not_active");
  }

  private async ensureMutableOwned(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<void, InsightCoordinatorFailure>> {
    const owned = await this.ensureOwned(profileId, reviewId);
    if (owned._tag === "err") return owned;
    const review = await this.reviews.load(profileId, reviewId);
    return review._tag === "ok" && review.value.status._tag === "Terminal"
      ? err("terminal_review")
      : review._tag === "ok"
        ? ok(undefined)
        : err("storage_unavailable");
  }

  private async ensureOwned(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<void, InsightCoordinatorFailure>> {
    const review = await this.reviews.load(profileId, reviewId);
    if (review._tag === "ok") return ok(undefined);
    if (review.error.reason !== "not_found") return err("storage_unavailable");
    const owner = await this.reviews.findOwner(reviewId);
    if (owner._tag === "err") return err("storage_unavailable");
    return owner.value !== undefined && owner.value !== profileId
      ? err("ownership_mismatch")
      : err("not_found");
  }
}

function currentIsoTimestamp(): IsoTimestamp {
  const parsed = parseIsoTimestamp(new Date().toISOString());
  if (parsed._tag === "err")
    throw new Error("system clock returned an invalid timestamp");
  return parsed.value;
}
