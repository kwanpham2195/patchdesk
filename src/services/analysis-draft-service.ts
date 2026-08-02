import { readFile } from "node:fs/promises";

import type { InsightStore } from "../adapters/storage/insight-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { parseContentHash, parseGitSha, parseInsightRunId, parseIsoTimestamp, parseReviewSessionId, parseLocalReviewItemId, type InsightRunId, type IsoTimestamp, type LocalReviewItemId, type ReviewSessionId, type WorkspaceProfileId, type ReviewId } from "../domain/ids";
import { createEmptyReviewBatch, type ReviewAnchor, type ReviewBatch, type ReviewBatchItem } from "../domain/review-batch";
import { fingerprintPatchAnchor } from "../domain/review-anchor";
import { parseReviewResult, type ReviewResult } from "../domain/review-result";
import type { RetainedInsight } from "../domain/insight-record";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import { readObjectField } from "./read-object-field";
import { contentHash } from "./review-artifact-hash";
import { renderAnalysisReviewBody, type AnalysisReviewBodyScope } from "./analysis-review-body";

export type AnalysisDraftPreview = {
  readonly body: string;
  readonly suggestedEvent: ReviewBatch["suggestedEvent"];
  readonly items: ReadonlyArray<ReviewBatchItem>;
  readonly preservedItems: ReadonlyArray<ReviewBatchItem>;
  readonly removedItems: ReadonlyArray<ReviewBatchItem>;
};

export type AnalysisDraftFailure =
  | { readonly reason: "draft_not_empty"; readonly merge: AnalysisDraftPreview; readonly replacement: AnalysisDraftPreview }
  | { readonly reason: "revision_conflict" }
  | { readonly reason: "replacement_acknowledgement_required" }
  | { readonly reason: "invalid_item_id" };

export type CurrentAnalysisInput = { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly sessionId: ReviewSessionId; readonly analysisRunId: InsightRunId; readonly scope: AnalysisReviewBodyScope; readonly now: IsoTimestamp };

export type AnalysisDraftStoreFailure = { readonly reason: "invalid_input" | "not_found" | "stale_request" | "storage_failed" | "draft_not_empty"; readonly merge?: AnalysisDraftPreview; readonly replacement?: AnalysisDraftPreview };

export type AnalysisDraftInput = {
  readonly sessionId: ReviewSessionId;
  readonly analysisRunId: InsightRunId;
  readonly result: ReviewResult;
  readonly scope: AnalysisReviewBodyScope;
  readonly patch?: string;
  readonly now: IsoTimestamp;
};

/** Builds deterministic Analysis content and applies only explicit draft transitions. */
export class AnalysisDraftService {
  constructor(private readonly stores?: { readonly sessions: Pick<ReviewSessionStore, "load" | "save">; readonly insights: Pick<InsightStore, "loadTyped"> }) {}

  seed(input: AnalysisDraftInput & { readonly current?: ReviewBatch }): Result<ReviewBatch, AnalysisDraftFailure> {
    const current = input.current;
    if (current !== undefined && !isEmptyDraft(current)) {
      return err({ reason: "draft_not_empty", merge: previewMerge(current, input), replacement: previewReplacement(current, input) });
    }
    return ok(buildGeneratedBatch(input));
  }

  async seedCurrent(input: CurrentAnalysisInput): Promise<Result<ReviewBatch, AnalysisDraftStoreFailure>> {
    const loaded = await this.loadCurrent(input);
    if (loaded._tag === "err") return loaded;
    const seeded = this.seed({ ...loaded.value.draft, ...(loaded.value.current === undefined ? {} : { current: loaded.value.current }) });
    if (seeded._tag === "err") return seeded.error.reason === "draft_not_empty" ? err({ reason: "draft_not_empty", merge: seeded.error.merge, replacement: seeded.error.replacement }) : err({ reason: "invalid_input" });
    return this.saveCurrent(loaded.value.session, seeded.value, input.now);
  }

  async previewMergeCurrent(input: CurrentAnalysisInput): Promise<Result<AnalysisDraftPreview & { readonly draftRevision: IsoTimestamp }, AnalysisDraftStoreFailure>> {
    const loaded = await this.loadCurrent(input);
    if (loaded._tag === "err") return loaded;
    const current = loaded.value.current ?? createEmptyReviewBatch({ sessionId: input.sessionId, createdAt: input.now });
    return ok({ ...this.previewMerge(current, loaded.value.draft), draftRevision: current.updatedAt });
  }

  async previewReplaceCurrent(input: CurrentAnalysisInput): Promise<Result<AnalysisDraftPreview & { readonly draftRevision: IsoTimestamp }, AnalysisDraftStoreFailure>> {
    const loaded = await this.loadCurrent(input);
    if (loaded._tag === "err") return loaded;
    const current = loaded.value.current ?? createEmptyReviewBatch({ sessionId: input.sessionId, createdAt: input.now });
    return ok({ ...this.previewReplacement(current, loaded.value.draft), draftRevision: current.updatedAt });
  }

  async mergeCurrent(input: CurrentAnalysisInput & { readonly expectedRevision: IsoTimestamp }): Promise<Result<ReviewBatch, AnalysisDraftStoreFailure>> {
    const loaded = await this.loadCurrent(input);
    if (loaded._tag === "err") return loaded;
    const current = loaded.value.current ?? createEmptyReviewBatch({ sessionId: input.sessionId, createdAt: input.now });
    const merged = this.merge({ ...loaded.value.draft, current, expectedRevision: input.expectedRevision });
    if (merged._tag === "err") return mapDraftFailure(merged.error);
    return this.saveCurrent(loaded.value.session, merged.value, input.now);
  }

  async replaceCurrent(input: CurrentAnalysisInput & { readonly expectedRevision: IsoTimestamp; readonly acknowledgement: boolean }): Promise<Result<ReviewBatch, AnalysisDraftStoreFailure>> {
    const loaded = await this.loadCurrent(input);
    if (loaded._tag === "err") return loaded;
    const current = loaded.value.current ?? createEmptyReviewBatch({ sessionId: input.sessionId, createdAt: input.now });
    const replaced = this.replace({ ...loaded.value.draft, current, expectedRevision: input.expectedRevision, acknowledgement: input.acknowledgement });
    if (replaced._tag === "err") return mapDraftFailure(replaced.error);
    return this.saveCurrent(loaded.value.session, replaced.value, input.now);
  }

  private async loadCurrent(input: CurrentAnalysisInput): Promise<Result<{ readonly session: ReviewSession; readonly current?: ReviewBatch; readonly draft: AnalysisDraftInput }, AnalysisDraftStoreFailure>> {
    if (this.stores === undefined) return err({ reason: "storage_failed" });
    const session = await this.stores.sessions.load(input.profileId, input.sessionId);
    if (session._tag === "err") return err({ reason: session.error.reason === "not_found" ? "not_found" : "storage_failed" });
    const analysis = await this.stores.insights.loadTyped(input.profileId, input.reviewId, "analysis", parseRetainedAnalysis);
    if (analysis._tag === "err" || analysis.value.retained === undefined) return err({ reason: analysis._tag === "err" && analysis.error.reason === "not_found" ? "not_found" : "storage_failed" });
    const retained = analysis.value.retained;
    if (retained.runId !== input.analysisRunId || retained.revision.sessionId !== input.sessionId || retained.revision.headSha !== session.value.key.headSha) return err({ reason: "stale_request" });
    let patch: string;
    try {
      patch = await readFile(session.value.patchPath, "utf8");
      if (await contentHash(session.value.patchPath) !== retained.revision.patchHash) return err({ reason: "stale_request" });
    } catch {
      return err({ reason: "storage_failed" });
    }
    return ok({ session: session.value, ...(session.value.batchContent === undefined ? {} : { current: session.value.batchContent }), draft: { sessionId: input.sessionId, analysisRunId: input.analysisRunId, result: retained.value, scope: input.scope, patch, now: input.now } });
  }

  private async saveCurrent(session: ReviewSession, batch: ReviewBatch, now: IsoTimestamp): Promise<Result<ReviewBatch, AnalysisDraftStoreFailure>> {
    if (this.stores === undefined) return err({ reason: "storage_failed" });
    const saved = await this.stores.sessions.save({ ...session, batch: { state: batch.state }, batchContent: batch, updatedAt: now });
    return saved._tag === "ok" ? ok(batch) : err({ reason: "storage_failed" });
  }

  previewMerge(current: ReviewBatch, input: AnalysisDraftInput): AnalysisDraftPreview {
    return previewMerge(current, input);
  }

  merge(input: AnalysisDraftInput & { readonly current: ReviewBatch; readonly expectedRevision: IsoTimestamp }): Result<ReviewBatch, AnalysisDraftFailure> {
    if (input.current.updatedAt !== input.expectedRevision) return err({ reason: "revision_conflict" });
    const preview = previewMerge(input.current, input);
    return ok({ ...input.current, summaryBody: preview.body, suggestedEvent: preview.suggestedEvent, items: [...preview.preservedItems, ...preview.items], updatedAt: input.now });
  }

  previewReplacement(current: ReviewBatch, input: AnalysisDraftInput): AnalysisDraftPreview {
    return previewReplacement(current, input);
  }

  replace(input: AnalysisDraftInput & { readonly current: ReviewBatch; readonly expectedRevision: IsoTimestamp; readonly acknowledgement: boolean }): Result<ReviewBatch, AnalysisDraftFailure> {
    if (input.current.updatedAt !== input.expectedRevision) return err({ reason: "revision_conflict" });
    if (!input.acknowledgement) return err({ reason: "replacement_acknowledgement_required" });
    return ok(buildGeneratedBatch(input));
  }
}

function buildGeneratedBatch(input: AnalysisDraftInput): ReviewBatch {
  const items = mappedFindingItems(input.result, input.analysisRunId, input.patch);
  return {
    sessionId: input.sessionId,
    state: { _tag: "Local" },
    summaryBody: renderAnalysisReviewBody({ result: input.result, scope: input.scope }),
    suggestedEvent: verdictEvent(input.result),
    items,
    receipts: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function previewMerge(current: ReviewBatch, input: AnalysisDraftInput): AnalysisDraftPreview {
  const generated = buildGeneratedBatch(input);
  const existingFindingIds = new Set(current.items.flatMap((item) => isFindingItem(item) && item.provenance._tag === "insight" && item.findingId !== undefined ? [item.findingId] : []));
  const added = generated.items.filter((item) => !isFindingItem(item) || item.findingId === undefined || !existingFindingIds.has(item.findingId));
  return {
    body: `# Maintainer notes\n${current.summaryBody}\n\n${generated.summaryBody}`,
    suggestedEvent: generated.suggestedEvent,
    items: added,
    preservedItems: current.items,
    removedItems: [],
  };
}

function previewReplacement(current: ReviewBatch, input: AnalysisDraftInput): AnalysisDraftPreview {
  const generated = buildGeneratedBatch(input);
  return { body: generated.summaryBody, suggestedEvent: generated.suggestedEvent, items: generated.items, preservedItems: [], removedItems: current.items };
}

function isFindingItem(item: ReviewBatchItem): item is Extract<ReviewBatchItem, { readonly _tag: "InlineComment" | "GeneralComment" }> {
  return item._tag === "InlineComment" || item._tag === "GeneralComment";
}

function isEmptyDraft(batch: ReviewBatch): boolean {
  return batch.summaryBody.trim().length === 0 && batch.items.length === 0 && batch.receipts.length === 0;
}

function mapDraftFailure(failure: AnalysisDraftFailure): Result<never, AnalysisDraftStoreFailure> {
  if (failure.reason === "revision_conflict") return err({ reason: "stale_request" });
  if (failure.reason === "replacement_acknowledgement_required") return err({ reason: "invalid_input" });
  if (failure.reason === "draft_not_empty") return err({ reason: "draft_not_empty", merge: failure.merge, replacement: failure.replacement });
  return err({ reason: "invalid_input" });
}

function parseRetainedAnalysis(input: unknown): Result<RetainedInsight<ReviewResult>, unknown> {
  const revision = readObjectField(input, "revision");
  const runId = parseInsightRunId(readObjectField(input, "runId"));
  const sessionId = parseReviewSessionId(readObjectField(revision, "sessionId"));
  const headSha = parseGitSha(readObjectField(revision, "headSha"));
  const patchHash = parseContentHash(readObjectField(revision, "patchHash"));
  const generatedAt = parseIsoTimestamp(readObjectField(input, "generatedAt"));
  const value = parseReviewResult(readObjectField(input, "value"));
  if (runId._tag === "err" || sessionId._tag === "err" || headSha._tag === "err" || patchHash._tag === "err" || generatedAt._tag === "err" || value._tag === "err") return err(undefined);
  return ok({ runId: runId.value, revision: { sessionId: sessionId.value, headSha: headSha.value, patchHash: patchHash.value }, generatedAt: generatedAt.value, value: value.value });
}

function mappedFindingItems(result: ReviewResult, runId: InsightRunId, patch: string | undefined): ReadonlyArray<ReviewBatchItem> {
  const used = new Set<LocalReviewItemId>();
  const items: ReviewBatchItem[] = [];
  for (const finding of result.findings) {
    if (finding.mappingStatus !== "mapped" || finding.file === undefined || finding.lineStart === undefined || finding.diffSide === undefined) continue;
    const id = nextItemId(finding.id, used);
    if (id === undefined) continue;
    used.add(id);
    const anchor: ReviewAnchor = { path: finding.file, startLine: finding.lineStart, line: finding.lineEnd ?? finding.lineStart, side: finding.diffSide };
    const fingerprint = patch === undefined ? undefined : fingerprintPatchAnchor(patch, anchor);
    items.push({ _tag: "InlineComment", id, provenance: { _tag: "insight", runId }, source: "finding", findingId: finding.id, anchor, ...(fingerprint === undefined ? {} : { fingerprint }), body: finding.suggestedComment ?? finding.explanation, include: true, postability: fingerprint === undefined ? "needs_attention" : "postable" });
  }
  return items;
}

function nextItemId(findingId: ReviewResult["findings"][number]["id"], used: ReadonlySet<LocalReviewItemId>): LocalReviewItemId | undefined {
  for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const parsed = parseLocalReviewItemId(suffix === 1 ? findingId : `${findingId}-${suffix}`);
    if (parsed._tag === "err") return undefined;
    if (!used.has(parsed.value)) return parsed.value;
  }
  return undefined;
}

function verdictEvent(result: ReviewResult): ReviewBatch["suggestedEvent"] {
  return result.verdict === "approve" ? "APPROVE" : result.verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
}
