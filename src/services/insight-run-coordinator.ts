import { readFile, readdir } from "node:fs/promises";
import type { GitSha } from "../domain/ids";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { InsightStore } from "../adapters/storage/insight-store";
import type { PublicationAuthorizationStore } from "../adapters/storage/publication-authorization-store";
import { parseContentHash, parseGitSha, parseInsightRunId, parseIsoTimestamp, parseReviewSessionId, parseWorkspaceProfileId, type ContentHash, type FindingId, type InsightRunId, type IsoTimestamp, type ReviewAttemptId, type ReviewId, type ReviewSessionId, type WorkspaceProfileId } from "../domain/ids";
import type { ReviewScope } from "../domain/review-comparison";
import { beginInsightRun, completeInsightRun, dismissInsightFinding, failInsightRun, provenanceFromRun, requestInsightCancellation, updateWalkthroughProgress, type InsightFailureCategory, type InsightRecord, type InsightRevision, type InsightType, type WalkthroughProgress } from "../domain/insight-record";
import type { InsightProvider, InsightReasoning } from "../domain/insight-provider";
import { createPublicationAuthorization, type AnalysisCompletionAction } from "../domain/publication-authorization";
import { mapFindingLocation, parseUnifiedPatch } from "../domain/patch";
import { parseModelReviewResult, parseReviewResult } from "../domain/review-result";
import { normalizeNarrativeWalkthrough } from "../domain/narrative-walkthrough";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { StorageFailure } from "../adapters/storage/json-file";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { canonicalModelId, type PiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import type { InsightProviderCatalog } from "./insight-provider-catalog";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import { contentHash } from "./review-artifact-hash";
import { err, ok, type Result } from "../domain/result";
import { readObjectField } from "./read-object-field";

export type InsightInvocationInput = { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly sessionId: ReviewSessionId; readonly attemptId?: ReviewAttemptId; readonly runId: InsightRunId; readonly type: InsightType; readonly expectedHeadSha: GitSha; readonly contextPath: string; readonly reviewInputPath?: string; readonly patchPath: string; readonly worktreePath: string; readonly scope?: ReviewScope; readonly provider: InsightProvider; readonly model: string; readonly reasoning: InsightReasoning; readonly completion?: AnalysisCompletionAction };
export type InsightInvoker = {
  invoke(input: InsightInvocationInput, options: { readonly signal: AbortSignal }): Promise<Result<unknown, { readonly reason: string }>>;
};
export type InsightRunResponse = { readonly runId: InsightRunId; readonly type: InsightType; readonly status: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled"; readonly authorizationId?: string; readonly failureReason?: "cancelled" | "failed" | "invalid_result" | "superseded" };
export type InsightCoordinatorInput = { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly type: InsightType; readonly provider?: InsightProvider; readonly model: string; readonly reasoning: InsightReasoning; readonly completion?: AnalysisCompletionAction };
export type InsightCoordinatorFailure = "invalid_request" | "not_found" | "ownership_mismatch" | "terminal_review" | "already_running" | "model_unavailable" | "catalog_unavailable" | "storage_unavailable" | "not_active" | "stale_request" | "not_available" | "draft_unavailable";
export type InsightCompletionHandler = (input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly sessionId: ReviewSessionId; readonly expectedHeadSha: GitSha; readonly expectedPatchHash: ContentHash; readonly analysisRunId: InsightRunId; readonly expectedDraftRevision: IsoTimestamp; readonly completion: AnalysisCompletionAction }) => Promise<void>;

type Active = { readonly runId: InsightRunId; readonly controller: AbortController };

export class InsightRunCoordinator {
  private readonly active = new Map<string, Active>();
  private readonly pendingCompletions = new Map<string, Promise<void>>();
  private completionHandler: InsightCompletionHandler | undefined;

  configureCompletion(handler: InsightCompletionHandler): void {
    this.completionHandler = handler;
  }

  constructor(
    private readonly reviews: Pick<ReviewStore, "load"> & { readonly findOwner?: (reviewId: ReviewId) => Promise<Result<WorkspaceProfileId | undefined, StorageFailure>>; readonly list?: ReviewStore["list"] },
    private readonly sessions: Pick<ReviewSessionStore, "load" | "loadAttempt">,
    private readonly insights: InsightStore,
    private readonly paths: PatchdeskPaths,
    private readonly catalog: PiRuntimeModelCatalog,
    private readonly invokers: Readonly<{ readonly analysis: InsightInvoker; readonly walkthrough: InsightInvoker }>,
    private readonly now: () => IsoTimestamp = currentIsoTimestamp,
    private readonly diagnostics?: Pick<ReviewDiagnosticService, "record">,
    private readonly publicationAuthorizations?: Pick<PublicationAuthorizationStore, "save" | "load">,
    private readonly providerCatalog?: InsightProviderCatalog,
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
    const provider = input.provider ?? "pi";
    let model = input.model;
    if (provider === "pi") {
      if (input.reasoning === "minimal" || input.reasoning === "xhigh") return err("model_unavailable");
      const models = await this.catalog.get();
      if (models._tag === "err") return err("catalog_unavailable");
      const canonical = models.value.providers === undefined ? input.model : canonicalModelId(input.model);
      if (canonical === undefined || !models.value.models.some((candidate) => candidate.id === canonical)) return err("model_unavailable");
      model = canonical;
    } else {
      if (this.providerCatalog === undefined) return err("catalog_unavailable");
      const validated = await this.providerCatalog.validate({ provider, model: input.model, reasoning: input.reasoning });
      if (validated._tag === "err") return err(validated.error);
    }
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
    let authorizationId: string | undefined;
    if (input.completion?._tag === "PublishWhenComplete") {
      if (input.type !== "analysis" || this.publicationAuthorizations === undefined || !isEmptyBatch(session.value.batchContent)) return err("draft_unavailable");
      const expectedDraftRevision = session.value.batchContent?.updatedAt ?? timestamp.value;
      const authorization = createPublicationAuthorization({ id: input.completion.authorizationId, profileId: input.profileId, reviewId: input.reviewId, sessionId: session.value.id, headSha: session.value.key.headSha, patchHash: hash.value, analysisRunId: runId.value, expectedDraftRevision, event: input.completion.event, createdAt: timestamp.value });
      const savedAuthorization = await this.publicationAuthorizations.save(authorization);
      if (savedAuthorization._tag === "err") return err("storage_unavailable");
      authorizationId = authorization.id;
    } else if (input.completion !== undefined && input.type !== "analysis") {
      return err("invalid_request");
    }
    const started = await this.insights.mutate({ profileId: input.profileId, reviewId: input.reviewId, type: input.type, now: timestamp.value, operation: (current) => beginInsightRun(current, { id: runId.value, revision, provider, model, reasoning: input.reasoning, startedAt: timestamp.value }) });
    if (started._tag === "err") return started.error === "already_running" ? err("already_running") : err("storage_unavailable");
    const controller = new AbortController();
    this.active.set(runId.value, { runId: runId.value, controller });
    const invocation = {
      profileId: input.profileId,
      reviewId: input.reviewId,
      sessionId: session.value.id,
      runId: runId.value,
      type: input.type,
      expectedHeadSha: session.value.key.headSha,
      contextPath: this.paths.preparedContextFile(input.profileId, session.value.id),
      reviewInputPath: this.paths.preparedReviewInputFile(input.profileId, session.value.id),
      patchPath: session.value.patchPath,
      worktreePath: session.value.worktree.path,
      ...(session.value.scope === undefined ? {} : { scope: session.value.scope }),
      provider,
      model,
      reasoning: input.reasoning,
      ...(input.completion === undefined ? {} : { completion: input.completion }),
    };
    void this.execute(invocation, input.type, runId.value, hash.value, controller);
    return ok({ runId: runId.value, type: input.type, status: "queued", ...(authorizationId === undefined ? {} : { authorizationId }) });
  }

  async cancel(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly type: InsightType; readonly runId: InsightRunId }): Promise<Result<InsightRunResponse, InsightCoordinatorFailure>> {
    const ownership = await this.ensureMutableOwned(input.profileId, input.reviewId);
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

  async dismissFinding(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly runId: InsightRunId; readonly findingId: FindingId; readonly reason: string }): Promise<Result<{ readonly findingId: FindingId; readonly status: "dismissed" }, InsightCoordinatorFailure>> {
    const ownership = await this.ensureOwned(input.profileId, input.reviewId);
    if (ownership._tag === "err") return ownership;
    const review = await this.reviews.load(input.profileId, input.reviewId);
    if (review._tag === "err") return err("storage_unavailable");
    if (review.value.status._tag === "Terminal") return err("terminal_review");
    const session = await this.sessions.load(input.profileId, review.value.currentSessionId);
    if (session._tag === "err") return err(session.error.reason === "not_found" ? "not_found" : "storage_unavailable");
    const currentHash = parseContentHash(await contentHash(session.value.patchPath));
    if (currentHash._tag === "err") return err("storage_unavailable");
    const retained = await this.insights.load(input.profileId, input.reviewId, "analysis");
    if (retained._tag === "err") return err(retained.error.reason === "not_found" ? "not_found" : "storage_unavailable");
    const retainedRecord = retained.value.retained;
    const retainedRunId = parseInsightRunId(readObjectField(retainedRecord, "runId"));
    const retainedRevision = readObjectField(retainedRecord, "revision");
    if (retainedRunId._tag === "err" || retainedRunId.value !== input.runId) return err("not_found");
    const retainedSession = parseReviewSessionId(readObjectField(retainedRevision, "sessionId"));
    const retainedHead = parseGitSha(readObjectField(retainedRevision, "headSha"));
    const retainedPatch = parseContentHash(readObjectField(retainedRevision, "patchHash"));
    const retainedValue = parseReviewResult(readRetainedValue(retainedRecord));
    if (retainedSession._tag === "err" || retainedHead._tag === "err" || retainedPatch._tag === "err" || retainedValue._tag === "err") return err("not_found");
    if (retainedSession.value !== session.value.id || retainedHead.value !== session.value.key.headSha || retainedPatch.value !== currentHash.value) return err("stale_request");
    if (!retainedValue.value.findings.some((finding) => finding.id === input.findingId)) return err("not_found");
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const changed = await this.insights.mutate({ profileId: input.profileId, reviewId: input.reviewId, type: "analysis", now: timestamp.value, operation: (record) => {
      if (record.activeRun !== undefined || record.retained === undefined || !isRetainedRun(record.retained, input.runId)) return err("not_available" as const);
      const parsed = parseReviewResult(readRetainedValue(record.retained));
      if (parsed._tag === "err" || !parsed.value.findings.some((finding) => finding.id === input.findingId)) return err("not_available" as const);
      return dismissInsightFinding(record, input.findingId, input.reason, timestamp.value);
    } });
    if (changed._tag === "err") {
      if (changed.error === "invalid_reason") return err("invalid_request");
      if (changed.error === "not_available") return err("not_available");
      return err("storage_unavailable");
    }
    return ok({ findingId: input.findingId, status: "dismissed" });
  }

  async updateWalkthroughProgress(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly runId: InsightRunId; readonly progress: WalkthroughProgress }): Promise<Result<{ readonly status: "saved" }, InsightCoordinatorFailure>> {
    const ownership = await this.ensureMutableOwned(input.profileId, input.reviewId);
    if (ownership._tag === "err") return ownership;
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const changed = await this.insights.mutate({ profileId: input.profileId, reviewId: input.reviewId, type: "walkthrough", now: timestamp.value, operation: (record) => {
      const retainedRunId = parseInsightRunId(readObjectField(record.retained, "runId"));
      if (retainedRunId._tag === "err" || retainedRunId.value !== input.runId) return err("not_available" as const);
      return updateWalkthroughProgress(record, input.progress, timestamp.value);
    } });
    if (changed._tag === "err") return err(changed.error === "not_available" ? "not_available" : "storage_unavailable");
    return ok({ status: "saved" });
  }

  async addFinding(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly runId: InsightRunId; readonly findingId: FindingId }): Promise<Result<never, InsightCoordinatorFailure>> {
    const ownership = await this.ensureOwned(input.profileId, input.reviewId);
    if (ownership._tag === "err") return ownership;
    return err("draft_unavailable");
  }

  async recover(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly type: InsightType }): Promise<Result<InsightRunResponse | undefined, InsightCoordinatorFailure>> {
    const record = await this.insights.load(input.profileId, input.reviewId, input.type);
    if (record._tag === "err") return record.error.reason === "not_found" ? ok(undefined) : err("storage_unavailable");
    const active = record.value.activeRun;
    if (active === undefined || this.active.has(active.id)) return active === undefined ? ok(undefined) : ok({ runId: active.id, type: input.type, status: active.status });
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const failed = await this.insights.mutate({ profileId: input.profileId, reviewId: input.reviewId, type: input.type, now: timestamp.value, operation: (current) => failInsightRun(current, active.id, { runId: active.id, reason: "failed", category: "unexpected_failure", retryable: true, failedAt: timestamp.value }, timestamp.value) });
    if (failed._tag === "err") return err("storage_unavailable");
    return ok({ runId: active.id, type: input.type, status: "failed", failureReason: "failed" });
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
    if (isRetainedRun(record.value.retained, input.runId)) {
      const completion = this.pendingCompletions.get(input.runId);
      if (completion !== undefined) await completion;
      return ok({ runId: input.runId, type: input.type, status: "completed" });
    }
    if (record.value.replacementFailure?.runId === input.runId) return ok({ runId: input.runId, type: input.type, status: record.value.replacementFailure.reason === "cancelled" ? "cancelled" : "failed", failureReason: record.value.replacementFailure.reason });
    return err("not_active");
  }

  private async ensureMutableOwned(profileId: WorkspaceProfileId, reviewId: ReviewId): Promise<Result<void, InsightCoordinatorFailure>> {
    const owned = await this.ensureOwned(profileId, reviewId);
    if (owned._tag === "err") return owned;
    const review = await this.reviews.load(profileId, reviewId);
    return review._tag === "ok" && review.value.status._tag === "Terminal" ? err("terminal_review") : review._tag === "ok" ? ok(undefined) : err("storage_unavailable");
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
        await this.recordExecutionFailure(input, type, runId, "unexpected_failure", "invalid_timestamp");
        return;
      }
      const current = latestReview._tag === "ok" && latestSession._tag === "ok" && latestHash._tag === "ok" && latestReview.value.currentSessionId === input.sessionId && latestSession.value.id === input.sessionId && latestHash.value === startedHash;
      if (!current) {
        await this.revokeAuthorization(input, "updates_available");
        await this.persistTerminal(input, type, runId, timestamp.value, (record) => failInsightRun(record, runId, { runId, reason: "superseded", retryable: true, failedAt: timestamp.value }, timestamp.value), "superseded");
        return;
      }
      if (invocation._tag === "err" || controller.signal.aborted) {
        await this.revokeAuthorization(input, controller.signal.aborted || invocation._tag === "err" && invocation.error.reason === "cancelled" ? "analysis_cancelled" : "analysis_failed");
        const cancelled = controller.signal.aborted || invocation._tag === "err" && invocation.error.reason === "cancelled";
        const category = invocation._tag === "err" && invocation.error.reason !== "cancelled" ? safeFailureCategory(invocation.error.reason) : undefined;
        // Attach a truncated stderr diagnostic when the walkthrough process provides one.
        const stderr = invocation._tag === "err" && "stderr" in invocation.error && typeof invocation.error.stderr === "string"
          ? invocation.error.stderr.slice(0, 500)
          : undefined;
        await this.persistTerminal(input, type, runId, timestamp.value, (record) => failInsightRun(record, runId, {
          runId,
          reason: cancelled ? "cancelled" : "failed",
          ...(category === undefined ? {} : { category }),
          retryable: true,
          failedAt: timestamp.value,
        }, timestamp.value), "invocation");
        if (stderr !== undefined) await this.recordDiagnostic(input, type, `stderr:${stderr}`);
        return;
      }
      const validated = await this.validateResult(type, invocation.value, input, {
        sessionId: input.sessionId,
        headSha: latestSession.value.key.headSha,
        patchHash: latestHash.value,
      });
      if (validated._tag === "err") {
        await this.revokeAuthorization(input, "validation_failed");
        await this.persistTerminal(input, type, runId, timestamp.value, (record) => failInsightRun(record, runId, { runId, reason: "invalid_result", category: "invalid_result", retryable: true, failedAt: timestamp.value }, timestamp.value), "invalid_result");
        await this.recordDiagnostic(input, type, "invalid_result");
        return;
      }
      let releaseCompletion: () => void = () => undefined;
      const completionReady = type === "analysis" && input.completion !== undefined && this.completionHandler !== undefined
        ? new Promise<void>((resolve) => { releaseCompletion = resolve; })
        : undefined;
      if (completionReady !== undefined) this.pendingCompletions.set(runId, completionReady);
      const retained = await this.persistTerminal(input, type, runId, timestamp.value, (record) => {
        const active = record.activeRun;
        if (active?.id !== runId) return err("superseded" as const);
        if (active.revision.sessionId !== input.sessionId || active.revision.headSha !== latestSession.value.key.headSha || active.revision.patchHash !== latestHash.value) {
          return failInsightRun(record, runId, { runId, reason: "superseded", retryable: true, failedAt: timestamp.value }, timestamp.value);
        }
        return completeInsightRun(record, runId, { runId, revision: active.revision, generatedAt: timestamp.value, provenance: provenanceFromRun(active), value: validated.value }, timestamp.value);
      }, "completion");
      if (!retained || type !== "analysis" || input.completion === undefined || this.completionHandler === undefined) {
        releaseCompletion();
        this.pendingCompletions.delete(runId);
        return;
      }
      const expectedDraftRevision = parseIsoTimestamp((latestSession.value.batchContent as { readonly updatedAt?: unknown } | undefined)?.updatedAt ?? timestamp.value);
      try {
        await this.completionHandler({ profileId: input.profileId, reviewId: input.reviewId, sessionId: input.sessionId, expectedHeadSha: latestSession.value.key.headSha, expectedPatchHash: latestHash.value, analysisRunId: runId, expectedDraftRevision: expectedDraftRevision._tag === "ok" ? expectedDraftRevision.value : timestamp.value, completion: input.completion });
      } catch {
        await this.recordDiagnostic(input, type, "completion_failed");
      } finally {
        releaseCompletion();
        this.pendingCompletions.delete(runId);
      }
    } catch {
      await this.recordExecutionFailure(input, type, runId, "unexpected_failure", safeFailureDetail());
    } finally {
      this.active.delete(runId);
    }
  }

  private async validateResult(type: InsightType, value: unknown, input: InsightInvocationInput, revision: InsightRevision): Promise<Result<unknown, "invalid_result">> {
    const patch = await readFile(input.patchPath, "utf8").catch(() => undefined);
    if (patch === undefined) return err("invalid_result");
    if (type === "analysis") {
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
    // This result came from the current alias-manifest workflow. Persist its
    // marker even when a provider omits the requested constant JSON field.
    const normalized = normalizeNarrativeWalkthrough(currentWalkthroughOutput(value), patch, { profileId: input.profileId, sessionId: revision.sessionId, headSha: revision.headSha, patchHash: revision.patchHash });
    return normalized._tag === "ok" ? normalized : err("invalid_result");
  }

  private async persistTerminal(
    input: InsightInvocationInput,
    type: InsightType,
    runId: InsightRunId,
    at: IsoTimestamp,
    operation: (record: InsightRecord<unknown>) => Result<InsightRecord<unknown>, "superseded">,
    detail: string,
  ): Promise<boolean> {
    try {
      const changed = await this.insights.mutate({ profileId: input.profileId, reviewId: input.reviewId, type, now: at, operation });
      if (changed._tag === "ok") return true;
      if (changed.error === "superseded") return false;
    } catch {
      // Fall through to orphan recovery and diagnostic reporting.
    }
    this.active.delete(runId);
    const recovered = await this.recover({ profileId: input.profileId, reviewId: input.reviewId, type });
    if (recovered._tag === "err") await this.recordDiagnostic(input, type, `${detail}_recovery_failed`);
    await this.recordDiagnostic(input, type, `${detail}_persist_failed`);
    return false;
  }

  private async revokeAuthorization(input: InsightInvocationInput, reason: "updates_available" | "analysis_failed" | "analysis_cancelled" | "validation_failed"): Promise<void> {
    const completion = input.completion;
    if (completion?._tag !== "PublishWhenComplete" || this.publicationAuthorizations === undefined) return;
    const loaded = await this.publicationAuthorizations.load(input.profileId, input.reviewId);
    if (loaded._tag !== "ok") return;
    if (loaded.value.id !== completion.authorizationId) return;
    await this.publicationAuthorizations.save({ ...loaded.value, state: { _tag: "Revoked", reason } });
  }

  private async recordExecutionFailure(input: InsightInvocationInput, type: InsightType, runId: InsightRunId, category: InsightFailureCategory, detail: "invalid_timestamp" | "unexpected_failure"): Promise<void> {
    await this.revokeAuthorization(input, "analysis_failed");
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "ok") {
      await this.persistTerminal(input, type, runId, timestamp.value, (record) => failInsightRun(record, runId, { runId, reason: "failed", category, retryable: true, failedAt: timestamp.value }, timestamp.value), detail);
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

function safeFailureDetail(): "unexpected_failure" {
  return "unexpected_failure";
}

function safeFailureCategory(value: unknown): InsightFailureCategory {
  switch (value) {
    case "authentication_required":
    case "rate_limited":
    case "runtime_unavailable":
    case "timed_out":
    case "execution_failed":
    case "invalid_result":
    case "unexpected_failure":
      return value;
    default:
      return "unexpected_failure";
  }
}

function currentWalkthroughOutput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...value, citationVersion: 2 };
}

function isRetainedRun(value: unknown, runId: InsightRunId): boolean {
  return typeof value === "object" && value !== null && "runId" in value && value.runId === runId;
}

function readRetainedValue(value: unknown): unknown {
  return typeof value === "object" && value !== null && "value" in value ? value.value : undefined;
}

function isEmptyBatch(batch: unknown): boolean {
  if (batch === undefined) return true;
  if (typeof batch !== "object" || batch === null) return false;
  const value = batch as { readonly summaryBody?: unknown; readonly items?: unknown; readonly receipts?: unknown };
  return typeof value.summaryBody === "string" && value.summaryBody.trim().length === 0
    && Array.isArray(value.items) && value.items.length === 0
    && Array.isArray(value.receipts) && value.receipts.length === 0;
}

function currentIsoTimestamp(): IsoTimestamp {
  const parsed = parseIsoTimestamp(new Date().toISOString());
  if (parsed._tag === "err") throw new Error("system clock returned an invalid timestamp");
  return parsed.value;
}
