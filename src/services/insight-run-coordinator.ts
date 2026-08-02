import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { InsightStore } from "../adapters/storage/insight-store";
import { parseContentHash, parseInsightRunId, parseIsoTimestamp, type ContentHash, type InsightRunId, type IsoTimestamp, type ReviewAttemptId, type ReviewId, type ReviewSessionId, type WorkspaceProfileId } from "../domain/ids";
import type { ReviewScope } from "../domain/review-comparison";
import { beginInsightRun, completeInsightRun, failInsightRun, requestInsightCancellation, type InsightRevision, type InsightType } from "../domain/insight-record";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { StorageFailure } from "../adapters/storage/json-file";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { PiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import { contentHash } from "./review-artifact-hash";
import { err, ok, type Result } from "../domain/result";

export type InsightInvocationInput = { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly sessionId: ReviewSessionId; readonly attemptId?: ReviewAttemptId; readonly runId: InsightRunId; readonly contextPath: string; readonly reviewInputPath?: string; readonly patchPath: string; readonly worktreePath: string; readonly scope?: ReviewScope; readonly model: string; readonly reasoning: "low" | "medium" | "high" };
export type InsightInvoker = { invoke(input: InsightInvocationInput, options: { readonly signal: AbortSignal }): Promise<Result<unknown, { readonly reason: string }>> };
export type InsightRunResponse = { readonly runId: InsightRunId; readonly type: InsightType; readonly status: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" };
export type InsightCoordinatorInput = { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly type: InsightType; readonly model: string; readonly reasoning: "low" | "medium" | "high" };
export type InsightCoordinatorFailure = "invalid_request" | "not_found" | "ownership_mismatch" | "terminal_review" | "already_running" | "model_unavailable" | "catalog_unavailable" | "storage_unavailable" | "not_active";

type Active = { readonly runId: InsightRunId; readonly controller: AbortController };

export class InsightRunCoordinator {
  private readonly active = new Map<string, Active>();

  constructor(
    private readonly reviews: Pick<ReviewStore, "load"> & { readonly findOwner?: (reviewId: ReviewId) => Promise<Result<WorkspaceProfileId | undefined, StorageFailure>> },
    private readonly sessions: Pick<ReviewSessionStore, "load" | "loadAttempt">,
    private readonly insights: InsightStore,
    private readonly paths: PatchdeskPaths,
    private readonly catalog: PiRuntimeModelCatalog,
    private readonly invokers: Readonly<{ readonly analysis: InsightInvoker; readonly walkthrough: InsightInvoker }>,
    private readonly now: () => IsoTimestamp = currentIsoTimestamp,
  ) {}

  async start(input: InsightCoordinatorInput): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> {
    const review = await this.reviews.load(input.profileId, input.reviewId);
    if (review._tag === "err") {
      if (review.error.reason !== "not_found") return err("storage_unavailable");
      const owner = await this.reviews.findOwner?.(input.reviewId);
      if (owner?._tag === "err") return err("storage_unavailable");
      if (owner?.value !== undefined && owner.value !== input.profileId) return err("ownership_mismatch");
      return err("not_found");
    }
    if (review.value.status._tag === "Terminal") return err("terminal_review");
    const models = await this.catalog.get();
    if (models._tag === "err") return err("catalog_unavailable");
    if (!models.value.models.some((model) => model.id === input.model)) return err("model_unavailable");
    const session = await this.sessions.load(input.profileId, review.value.currentSessionId);
    if (session._tag === "err") return err(session.error.reason === "not_found" ? "not_found" : "storage_unavailable");
    const hash = parseContentHash(await contentHash(session.value.patchPath));
    if (hash._tag === "err") return err("storage_unavailable");
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const record = await this.insights.load(input.profileId, input.reviewId, input.type);
    const token = record._tag === "ok" ? record.value.nextToken : 1;
    const runId = parseInsightRunId(`insight-${input.type}-${token}-${session.value.key.headSha.slice(0, 12)}-${input.reviewId}`);
    if (runId._tag === "err") return err("invalid_request");
    const revision: InsightRevision = { sessionId: session.value.id, headSha: session.value.key.headSha, patchHash: hash.value };
    const started = await this.insights.mutate({ profileId: input.profileId, reviewId: input.reviewId, type: input.type, now: timestamp.value, operation: (current) => beginInsightRun(current, { id: runId.value, revision, model: input.model, reasoning: input.reasoning, startedAt: timestamp.value }) });
    if (started._tag === "err") return started.error === "already_running" ? err("already_running") : err("storage_unavailable");
    const controller = new AbortController();
    this.active.set(runId.value, { runId: runId.value, controller });
    const invocation = {
      profileId: input.profileId,
      reviewId: input.reviewId,
      sessionId: session.value.id,
      runId: runId.value,
      contextPath: this.paths.preparedContextFile(input.profileId, session.value.id),
      reviewInputPath: this.paths.preparedReviewInputFile(input.profileId, session.value.id),
      patchPath: session.value.patchPath,
      worktreePath: session.value.worktree.path,
      scope: session.value.scope,
      model: input.model,
      reasoning: input.reasoning,
    };
    void this.execute(invocation, input.type, runId.value, hash.value, controller);
    return ok({ runId: runId.value, type: input.type, status: "queued" });
  }

  async cancel(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly type: InsightType; readonly runId: InsightRunId }): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> {
    const ownership = await this.ensureOwned(input.profileId, input.reviewId);
    if (ownership._tag === "err") return ownership;
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const changed = await this.insights.mutate({ profileId: input.profileId, reviewId: input.reviewId, type: input.type, now: timestamp.value, operation: (record) => requestInsightCancellation(record, input.runId, timestamp.value) });
    if (changed._tag === "err") {
      if (changed.error !== "not_active") return err("storage_unavailable");
      const observed = await this.observe(input);
      return observed._tag === "ok" ? observed : err("not_active");
    }
    this.active.get(input.runId)?.controller.abort();
    return ok({ runId: input.runId, type: input.type, status: "cancelling" });
  }

  async recover(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly type: InsightType }): Promise<Result<InsightRunResponse | undefined, InsightCoordinatorFailure>> {
    const record = await this.insights.load(input.profileId, input.reviewId, input.type);
    if (record._tag === "err") return record.error.reason === "not_found" ? ok(undefined) : err("storage_unavailable");
    const active = record.value.activeRun;
    if (active === undefined || this.active.has(active.id)) return active === undefined ? ok(undefined) : ok({ runId: active.id, type: input.type, status: active.status });
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const failed = await this.insights.mutate({ profileId: input.profileId, reviewId: input.reviewId, type: input.type, now: timestamp.value, operation: (current) => failInsightRun(current, active.id, { runId: active.id, reason: "failed", retryable: true, failedAt: timestamp.value }, timestamp.value) });
    if (failed._tag === "err") return err("storage_unavailable");
    return ok({ runId: active.id, type: input.type, status: "failed" });
  }

  async observe(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly type: InsightType; readonly runId: InsightRunId }): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> {
    const ownership = await this.ensureOwned(input.profileId, input.reviewId);
    if (ownership._tag === "err") return ownership;
    const record = await this.insights.load(input.profileId, input.reviewId, input.type);
    if (record._tag === "err") return err(record.error.reason === "not_found" ? "not_found" : "storage_unavailable");
    if (record.value.activeRun?.id === input.runId) return ok({ runId: input.runId, type: input.type, status: record.value.activeRun.status });
    if (isRetainedRun(record.value.retained, input.runId)) return ok({ runId: input.runId, type: input.type, status: "completed" });
    if (record.value.replacementFailure?.runId === input.runId) return ok({ runId: input.runId, type: input.type, status: record.value.replacementFailure.reason === "cancelled" ? "cancelled" : "failed" });
    return err("not_active");
  }

  private async ensureOwned(profileId: WorkspaceProfileId, reviewId: ReviewId): Promise<Result<void, InsightCoordinatorFailure>> {
    const review = await this.reviews.load(profileId, reviewId);
    if (review._tag === "ok") return ok(undefined);
    if (review.error.reason !== "not_found") return err("storage_unavailable");
    const owner = await this.reviews.findOwner?.(reviewId);
    if (owner?._tag === "err") return err("storage_unavailable");
    return owner?.value !== undefined && owner.value !== profileId ? err("ownership_mismatch") : err("not_found");
  }

  private async execute(input: InsightInvocationInput, type: InsightType, runId: InsightRunId, startedHash: ContentHash, controller: AbortController): Promise<void> {
    try {
      const invocation = await this.invokers[type].invoke(input, { signal: controller.signal });
      const latestReview = await this.reviews.load(input.profileId, input.reviewId);
      const latestSession = latestReview._tag === "ok" ? await this.sessions.load(input.profileId, latestReview.value.currentSessionId) : err({ _tag: "StorageFailure" as const, operation: "read" as const, reason: "io" as const });
      const latestHash = latestSession._tag === "ok" ? parseContentHash(await contentHash(latestSession.value.patchPath)) : err({ _tag: "InvalidDomainValue" as const, field: "patchHash" });
      const timestamp = parseIsoTimestamp(this.now());
      if (timestamp._tag === "err") return;
      await this.insights.mutate({ profileId: input.profileId, reviewId: input.reviewId, type, now: timestamp.value, operation: (record) => {
        const active = record.activeRun;
        if (active?.id !== runId) return err("superseded" as const);
        const current = latestReview._tag === "ok" && latestSession._tag === "ok" && latestHash._tag === "ok" && latestReview.value.currentSessionId === input.sessionId && active.revision.sessionId === latestSession.value.id && active.revision.headSha === latestSession.value.key.headSha && active.revision.patchHash === latestHash.value && latestHash.value === startedHash;
        if (!current) return failInsightRun(record, runId, { runId, reason: "superseded", retryable: true, failedAt: timestamp.value }, timestamp.value);
        if (invocation._tag === "err" || controller.signal.aborted) return failInsightRun(record, runId, { runId, reason: controller.signal.aborted || invocation._tag === "err" && invocation.error.reason === "cancelled" ? "cancelled" : "failed", retryable: true, failedAt: timestamp.value }, timestamp.value);
        return completeInsightRun(record, runId, { runId, revision: active.revision, generatedAt: timestamp.value, value: invocation.value }, timestamp.value);
      } });
    } finally {
      this.active.delete(runId);
    }
  }
}

function isRetainedRun(value: unknown, runId: InsightRunId): boolean {
  return typeof value === "object" && value !== null && "runId" in value && value.runId === runId;
}

function currentIsoTimestamp(): IsoTimestamp {
  const parsed = parseIsoTimestamp(new Date().toISOString());
  if (parsed._tag === "err") throw new Error("system clock returned an invalid timestamp");
  return parsed.value;
}
