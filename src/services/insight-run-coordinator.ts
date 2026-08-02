import { readFile, readdir } from "node:fs/promises";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { InsightStore } from "../adapters/storage/insight-store";
import { parseContentHash, parseInsightRunId, parseIsoTimestamp, parseWorkspaceProfileId, type ContentHash, type InsightRunId, type IsoTimestamp, type ReviewAttemptId, type ReviewId, type ReviewSessionId, type WorkspaceProfileId } from "../domain/ids";
import type { ReviewScope } from "../domain/review-comparison";
import { beginInsightRun, completeInsightRun, failInsightRun, requestInsightCancellation, type InsightRecord, type InsightRevision, type InsightType } from "../domain/insight-record";
import { mapFindingLocation, parseUnifiedPatch } from "../domain/patch";
import { parseModelReviewResult, parseReviewResult } from "../domain/review-result";
import { normalizeNarrativeWalkthrough } from "../domain/narrative-walkthrough";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { StorageFailure } from "../adapters/storage/json-file";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { PiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
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
    private readonly reviews: Pick<ReviewStore, "load"> & { readonly findOwner?: (reviewId: ReviewId) => Promise<Result<WorkspaceProfileId | undefined, StorageFailure>>; readonly list?: ReviewStore["list"] },
    private readonly sessions: Pick<ReviewSessionStore, "load" | "loadAttempt">,
    private readonly insights: InsightStore,
    private readonly paths: PatchdeskPaths,
    private readonly catalog: PiRuntimeModelCatalog,
    private readonly invokers: Readonly<{ readonly analysis: InsightInvoker; readonly walkthrough: InsightInvoker }>,
    private readonly now: () => IsoTimestamp = currentIsoTimestamp,
    private readonly diagnostics?: Pick<ReviewDiagnosticService, "record">,
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

  async recoverAll(): Promise<void> {
    if (this.reviews.list === undefined) return;
    let profileEntries: ReadonlyArray<string>;
    try {
      profileEntries = await readdir(this.paths.dataProfilesDirectory());
    } catch {
      return;
    }
    for (const entry of profileEntries) {
      const profileId = parseWorkspaceProfileId(entry);
      if (profileId._tag === "err") continue;
      const reviews = await this.reviews.list(profileId.value);
      if (reviews._tag === "err") {
        await this.recordRecoveryDiagnostic(profileId.value, undefined, "review_list_failed");
        continue;
      }
      for (const review of reviews.value) {
        for (const type of ["analysis", "walkthrough"] as const) {
          const recovered = await this.recover({ profileId: profileId.value, reviewId: review.id, type });
          if (recovered._tag === "err") await this.recordRecoveryDiagnostic(profileId.value, review.currentSessionId, `${type}_recovery_failed`);
        }
      }
    }
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
      if (timestamp._tag === "err") {
        await this.recordExecutionFailure(input, type, runId, "invalid_timestamp");
        return;
      }
      const current = latestReview._tag === "ok" && latestSession._tag === "ok" && latestHash._tag === "ok" && latestReview.value.currentSessionId === input.sessionId && latestSession.value.id === input.sessionId && latestHash.value === startedHash;
      if (!current) {
        await this.persistTerminal(input, type, runId, timestamp.value, (record) => failInsightRun(record, runId, { runId, reason: "superseded", retryable: true, failedAt: timestamp.value }, timestamp.value), "superseded");
        return;
      }
      if (invocation._tag === "err" || controller.signal.aborted) {
        await this.persistTerminal(input, type, runId, timestamp.value, (record) => failInsightRun(record, runId, { runId, reason: controller.signal.aborted || invocation._tag === "err" && invocation.error.reason === "cancelled" ? "cancelled" : "failed", retryable: true, failedAt: timestamp.value }, timestamp.value), "invocation");
        return;
      }
      const validated = await this.validateResult(type, invocation.value, input, {
        sessionId: input.sessionId,
        headSha: latestSession.value.key.headSha,
        patchHash: latestHash.value,
      });
      if (validated._tag === "err") {
        await this.persistTerminal(input, type, runId, timestamp.value, (record) => failInsightRun(record, runId, { runId, reason: "invalid_result", retryable: true, failedAt: timestamp.value }, timestamp.value), "invalid_result");
        await this.recordDiagnostic(input, type, "invalid_result");
        return;
      }
      await this.persistTerminal(input, type, runId, timestamp.value, (record) => {
        const active = record.activeRun;
        if (active?.id !== runId) return err("superseded" as const);
        if (active.revision.sessionId !== input.sessionId || active.revision.headSha !== latestSession.value.key.headSha || active.revision.patchHash !== latestHash.value) {
          return failInsightRun(record, runId, { runId, reason: "superseded", retryable: true, failedAt: timestamp.value }, timestamp.value);
        }
        return completeInsightRun(record, runId, { runId, revision: active.revision, generatedAt: timestamp.value, value: validated.value }, timestamp.value);
      }, "completion");
    } catch (cause: unknown) {
      await this.recordExecutionFailure(input, type, runId, safeFailureDetail(cause));
    } finally {
      this.active.delete(runId);
    }
  }

  private async validateResult(type: InsightType, value: unknown, input: InsightInvocationInput, revision: InsightRevision): Promise<Result<unknown, "invalid_result">> {
    const patch = await readFile(input.patchPath, "utf8").catch(() => undefined);
    if (patch === undefined) return err("invalid_result");
    if (type === "analysis") {
      const stored = parseReviewResult(value);
      if (stored._tag === "ok") return stored;
      const model = parseModelReviewResult(value);
      if (model._tag === "err") return err("invalid_result");
      const files = parseUnifiedPatch(patch);
      const mapped = parseReviewResult({
        changeSummary: model.value.changeSummary,
        verdict: model.value.verdict,
        summary: model.value.summary,
        validationPlan: model.value.validationPlan,
        assumptions: model.value.assumptions,
        ...(model.value.coverage === undefined ? {} : { coverage: model.value.coverage }),
        ...(model.value.overallConfidence === undefined ? {} : { overallConfidence: model.value.overallConfidence }),
        ...(model.value.unresolvedItems === undefined ? {} : { unresolvedItems: model.value.unresolvedItems }),
        ...(model.value.callouts === undefined ? {} : { callouts: model.value.callouts }),
        findings: model.value.findings.map((finding) => {
          const location = mapFindingLocation(files, finding);
          return {
            ...finding,
            mappingStatus: location.mappingStatus,
            ...(location.path === undefined ? {} : { file: location.path }),
            ...(location.side === undefined ? {} : { diffSide: location.side }),
            ...(location.line === undefined ? {} : { lineStart: location.startLine ?? location.line }),
            ...(location.startLine === undefined ? {} : { lineEnd: location.line }),
          };
        }),
      });
      return mapped._tag === "ok" ? mapped : err("invalid_result");
    }
    const normalized = normalizeNarrativeWalkthrough(value, patch, { profileId: input.profileId, sessionId: revision.sessionId, headSha: revision.headSha, patchHash: revision.patchHash });
    return normalized._tag === "ok" ? normalized : err("invalid_result");
  }

  private async persistTerminal(
    input: InsightInvocationInput,
    type: InsightType,
    runId: InsightRunId,
    at: IsoTimestamp,
    operation: (record: InsightRecord<unknown>) => Result<InsightRecord<unknown>, "superseded">,
    detail: string,
  ): Promise<void> {
    try {
      const changed = await this.insights.mutate({ profileId: input.profileId, reviewId: input.reviewId, type, now: at, operation });
      if (changed._tag === "ok" || changed.error === "superseded") return;
    } catch {
      // Fall through to orphan recovery and diagnostic reporting.
    }
    this.active.delete(runId);
    const recovered = await this.recover({ profileId: input.profileId, reviewId: input.reviewId, type });
    if (recovered._tag === "err") await this.recordDiagnostic(input, type, `${detail}_recovery_failed`);
    await this.recordDiagnostic(input, type, `${detail}_persist_failed`);
  }

  private async recordExecutionFailure(input: InsightInvocationInput, type: InsightType, runId: InsightRunId, detail: string): Promise<void> {
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "ok") {
      await this.persistTerminal(input, type, runId, timestamp.value, (record) => failInsightRun(record, runId, { runId, reason: "failed", retryable: true, failedAt: timestamp.value }, timestamp.value), detail);
    }
    await this.recordDiagnostic(input, type, detail);
  }

  private async recordDiagnostic(input: InsightInvocationInput, type: InsightType, detail: string): Promise<void> {
    try {
      await this.diagnostics?.record({ profileId: input.profileId, sessionId: input.sessionId, category: "run", phase: `insight-${type}-failed`, retryable: true, detail: `insight_${type}_${detail}` });
    } catch {
      // Diagnostics are best effort and never become an unhandled rejection.
    }
  }

  private async recordRecoveryDiagnostic(profileId: WorkspaceProfileId, sessionId: ReviewSessionId | undefined, detail: string): Promise<void> {
    try {
      await this.diagnostics?.record({ profileId, ...(sessionId === undefined ? {} : { sessionId }), category: "recovery", phase: "insight-recovery-failed", retryable: true, detail });
    } catch {
      // Diagnostics are best effort and never become an unhandled rejection.
    }
  }
}

function safeFailureDetail(cause: unknown): string {
  return cause instanceof Error && cause.name.length > 0 ? cause.name.toLowerCase().replace(/[^a-z0-9]+/g, "_") : "unknown";
}

function isRetainedRun(value: unknown, runId: InsightRunId): boolean {
  return typeof value === "object" && value !== null && "runId" in value && value.runId === runId;
}

function currentIsoTimestamp(): IsoTimestamp {
  const parsed = parseIsoTimestamp(new Date().toISOString());
  if (parsed._tag === "err") throw new Error("system clock returned an invalid timestamp");
  return parsed.value;
}
