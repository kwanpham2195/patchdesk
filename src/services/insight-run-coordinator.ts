import { readFile } from "node:fs/promises";

import { definedProps } from "../domain/defined-props";

import type { GitSha } from "../domain/ids";

import type { InsightActivitySink } from "../adapters/codex/codex-activity";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { InsightStore } from "../adapters/storage/insight-store";
import {
  parseContentHash,
  parseInsightRunId,
  parseIsoTimestamp,
  parseRepoRelativePath,
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
  setAnalysisVerificationStep,
  updateWalkthroughProgress,
  type AnalysisVerification,
  type InsightFailureCategory,
  type InsightRevision,
  type InsightType,
  type WalkthroughProgress,
} from "../domain/insight-record";
import type {
  InsightProvider,
  InsightReasoning,
} from "../domain/insight-provider";
import { parseReviewResult, type ReviewResult } from "../domain/review-result";
import {
  renderSuggestionCommentBody,
  resolveSuggestionTarget,
} from "../domain/finding-suggestion";
import type {
  FindingReviewSource,
  PendingReviewAnchor,
} from "../domain/pending-review";
import type { ReviewSession } from "../domain/review-session";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  canonicalModelId,
  type PiRuntimeModelCatalog,
} from "../adapters/pi/pi-runtime-model-catalog";
import type { DesktopNotifier } from "./desktop-notifier";
import type { BriefReachComputer } from "./brief-reach-service";
import type { InsightProviderCatalog } from "./insight-provider-catalog";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import { contentHash } from "./review-artifact-hash";
import { err, ok, type Result } from "../domain/result";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import { InsightRecovery } from "./insight-recovery";
import type { ReviewContextPackService } from "./review-context-pack-service";
import { InsightRunExecutor } from "./insight-run-executor";
import {
  InsightActivityBuffer,
  type InsightActivitySnapshot,
} from "./insight-activity-buffer";

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
  readonly provider: InsightProvider;
  readonly model: string;
  readonly reasoning: InsightReasoning;
};
/**
 * Why one Insight invocation failed, in the app's own vocabulary. The set is
 * closed so a provider classifies its own failures at its edge, where its
 * vocabulary is in scope, rather than handing the executor a string only it
 * understands; `cancelled` stands apart because a cancelled run is not a failure.
 */
type InsightInvocationFailure = {
  readonly reason: InsightFailureCategory | "cancelled";
  /** Where in the provider's own run the failure happened, for diagnostics. */
  readonly phase?: string;
  /** The provider's bounded, redacted account of the failure, when it gave one. */
  readonly stderr?: string;
};
/** Per-invocation options; Pi has no incremental boundary and never calls `onActivity`. */
export type InsightInvocationOptions = {
  readonly signal: AbortSignal;
  readonly onActivity?: InsightActivitySink | undefined;
};
export type InsightInvoker = {
  invoke(
    input: InsightInvocationInput,
    options: InsightInvocationOptions,
  ): Promise<Result<unknown, InsightInvocationFailure>>;
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
  readonly failureCategory?: InsightFailureCategory;
  /** Present while this process holds the run's activity trace; a Pi run has none. */
  readonly activity?: InsightActivitySnapshot | undefined;
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

/**
 * The one pending-review write a verified Finding suggestion authorizes. The
 * anchor and the body are rebuilt here from the represented patch and the
 * retained Analysis, so no caller decides what reaches GitHub (issue #316).
 */
export type FindingSuggestionCommand = {
  readonly anchor: PendingReviewAnchor;
  readonly body: string;
  readonly finding: FindingReviewSource;
};

/** Names one retained Analysis Finding for a Finding-scoped command. */
type AnalysisFindingRef = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly runId: InsightRunId;
  readonly findingId: FindingId;
};

/** One retained Analysis Finding, with the revision every Finding command is checked against. */
type CurrentAnalysisFinding = {
  readonly session: ReviewSession;
  readonly patchHash: ContentHash;
  readonly finding: ReviewResult["findings"][number];
};

export class InsightRunCoordinator {
  private readonly active = new Map<string, Active>();
  /** The last activity trace per profile, Review, and Insight type, kept after the run ends until the next run starts. */
  private readonly traces = new Map<
    string,
    { readonly runId: InsightRunId; readonly activity: InsightActivityBuffer }
  >();
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
    private readonly contextPack: ReviewContextPackService,
    private readonly now: () => IsoTimestamp = currentIsoTimestamp,
    private readonly diagnostics?: Pick<ReviewDiagnosticService, "record">,
    private readonly providerCatalog?: InsightProviderCatalog,
    /**
     * Counts a completed Brief's Reach block against the represented worktree.
     * Absent leaves the block off: every other Insight type ignores it.
     */
    private readonly reach?: BriefReachComputer,
    /** Announces a settled run outside the window (ADR 0044). */
    private readonly notifier?: DesktopNotifier,
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
      this.notifier,
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
    // The context pack is built here, not at prepare, and this runs under
    // `withReviewLock` so concurrent runs on one Review cannot build twice.
    // It precedes `beginInsightRun` so a failed build leaves no started run.
    const pack = await this.contextPack.ensure({
      session: session.value,
      patchHash: hash.value,
    });
    if (pack._tag === "err") return err("storage_unavailable");
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
    // Pi's child writes one result at exit, so a Pi run keeps today's panel instead of a trace.
    const activity =
      provider === "pi" ? undefined : new InsightActivityBuffer();
    const traceKey = activityTraceKey(
      input.profileId,
      input.reviewId,
      input.type,
    );
    if (activity === undefined) this.traces.delete(traceKey);
    else this.traces.set(traceKey, { runId: runId.value, activity });
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
      activity === undefined ? undefined : (event) => activity.append(event),
    );
    return ok({ runId: runId.value, type: input.type, status: "queued" });
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

  async dismissFinding(
    input: AnalysisFindingRef & { readonly reason: string },
  ): Promise<
    Result<
      { readonly findingId: FindingId; readonly status: "dismissed" },
      InsightCoordinatorFailure
    >
  > {
    return this.operations.withReviewLock(input.profileId, input.reviewId, () =>
      this.dismissFindingUnlocked(input),
    );
  }

  private async dismissFindingUnlocked(
    input: AnalysisFindingRef & { readonly reason: string },
  ): Promise<
    Result<
      { readonly findingId: FindingId; readonly status: "dismissed" },
      InsightCoordinatorFailure
    >
  > {
    const current = await this.currentAnalysisFinding(input);
    if (current._tag === "err") return current;
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

  /**
   * The retained Analysis Finding one Finding-scoped command is about, refused
   * unless the Review still represents the revision that Analysis ran against.
   */
  private async currentAnalysisFinding(
    input: AnalysisFindingRef,
  ): Promise<Result<CurrentAnalysisFinding, InsightCoordinatorFailure>> {
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
    const finding = retainedRecord.value.findings.find(
      (candidate) => candidate.id === input.findingId,
    );
    if (finding === undefined) return err("not_found");
    return ok({
      session: session.value,
      patchHash: currentHash.value,
      finding,
    });
  }

  /**
   * Rebuilds the GitHub anchor and comment body for one Finding's verified
   * replacement. The caller supplies identity only; the range comes from the
   * represented patch on disk, so a renderer cannot choose what is replaced.
   */
  async resolveFindingSuggestion(
    input: AnalysisFindingRef,
  ): Promise<Result<FindingSuggestionCommand, InsightCoordinatorFailure>> {
    return this.operations.withReviewLock(input.profileId, input.reviewId, () =>
      this.resolveFindingSuggestionUnlocked(input),
    );
  }

  private async resolveFindingSuggestionUnlocked(
    input: AnalysisFindingRef,
  ): Promise<Result<FindingSuggestionCommand, InsightCoordinatorFailure>> {
    const current = await this.currentAnalysisFinding(input);
    if (current._tag === "err") return current;
    const { finding, session } = current.value;
    const code = finding.suggestedReplacement?.code;
    // A Finding without a verified replacement keeps the ordinary comment
    // action; there is no suggestion command to answer with.
    if (code === undefined) return err("not_found");
    const patch = await readPatchText(session.patchPath);
    if (patch === undefined) return err("storage_unavailable");
    const target = resolveSuggestionTarget(patch, finding);
    if (target === undefined) return err("stale_request");
    const path = parseRepoRelativePath(target.path);
    if (path._tag === "err") return err("stale_request");
    return ok({
      anchor: {
        path: path.value,
        startLine: target.startLine,
        line: target.line,
        side: "new",
      },
      body: renderSuggestionCommentBody(
        finding.suggestedComment ?? finding.explanation,
        code,
      ),
      finding: {
        analysisRunId: input.runId,
        findingId: input.findingId,
        sessionId: session.id,
        headSha: session.key.headSha,
        patchHash: current.value.patchHash,
      },
    });
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

  async updateAnalysisVerification(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly runId: InsightRunId;
    readonly stepIndex: number;
    readonly checked: boolean;
  }): Promise<Result<AnalysisVerification, InsightCoordinatorFailure>> {
    return this.operations.withReviewLock(input.profileId, input.reviewId, () =>
      this.updateAnalysisVerificationUnlocked(input),
    );
  }

  private async updateAnalysisVerificationUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly runId: InsightRunId;
    readonly stepIndex: number;
    readonly checked: boolean;
  }): Promise<Result<AnalysisVerification, InsightCoordinatorFailure>> {
    // Ticks are the reviewer's own reading progress, so a merged or closed Review keeps them editable.
    const ownership = await this.ensureOwned(input.profileId, input.reviewId);
    if (ownership._tag === "err") return ownership;
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const changed = await this.insights.mutate({
      profileId: input.profileId,
      reviewId: input.reviewId,
      type: "analysis",
      now: timestamp.value,
      operation: (record) => {
        if (record.retained?.runId !== input.runId)
          return err("not_available" as const);
        const result = parseReviewResult(record.retained.value);
        if (result._tag === "err") return err("not_available" as const);
        return setAnalysisVerificationStep(
          record,
          {
            index: input.stepIndex,
            count: result.value.validationPlan.length,
          },
          input.checked,
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
    return ok(changed.value.analysisVerification ?? { checkedStepIndexes: [] });
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
    this.traces.clear();
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
    const trace = this.traces.get(
      activityTraceKey(input.profileId, input.reviewId, input.type),
    );
    const activity =
      trace?.runId === input.runId ? trace.activity.snapshot() : undefined;
    if (record.value.activeRun?.id === input.runId)
      return ok({
        runId: input.runId,
        type: input.type,
        status: record.value.activeRun.status,
        activity,
      });
    if (record.value.retained?.runId === input.runId) {
      return ok({
        runId: input.runId,
        type: input.type,
        status: "completed",
        activity,
      });
    }
    if (record.value.replacementFailure?.runId === input.runId)
      return ok({
        runId: input.runId,
        type: input.type,
        activity,
        status:
          record.value.replacementFailure.reason === "cancelled"
            ? "cancelled"
            : "failed",
        failureReason: record.value.replacementFailure.reason,
        ...definedProps({
          failureCategory: record.value.replacementFailure.category,
        }),
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

/** The represented patch, or undefined when it can no longer be read. */
async function readPatchText(patchPath: string): Promise<string | undefined> {
  try {
    return await readFile(patchPath, "utf8");
  } catch {
    return undefined;
  }
}

function activityTraceKey(
  profileId: WorkspaceProfileId,
  reviewId: ReviewId,
  type: InsightType,
): string {
  return `${profileId}:${reviewId}:${type}`;
}

function currentIsoTimestamp(): IsoTimestamp {
  const parsed = parseIsoTimestamp(new Date().toISOString());
  if (parsed._tag === "err")
    throw new Error("system clock returned an invalid timestamp");
  return parsed.value;
}
