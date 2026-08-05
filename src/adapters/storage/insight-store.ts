import * as v from "valibot";

import { parseContentHash, parseFindingId, parseGitSha, parseInsightRunId, parseIsoTimestamp, parseReviewId, parseReviewSessionId, type ReviewId, type WorkspaceProfileId } from "../../domain/ids";
import type { InsightFindingDismissal, InsightType, WalkthroughProgress } from "../../domain/insight-record";
import { err, ok, type Result } from "../../domain/result";
import type { InsightRecord } from "../../domain/insight-record";
import { readJsonFile, writeAtomicJson, type StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

const revisionSchema = v.strictObject({ sessionId: v.pipe(v.string(), v.minLength(1)), headSha: v.pipe(v.string(), v.minLength(40)), patchHash: v.pipe(v.string(), v.length(64)) });
const activeRunSchema = v.strictObject({ id: v.pipe(v.string(), v.minLength(1)), type: v.picklist(["analysis", "walkthrough"]), revision: revisionSchema, token: v.pipe(v.number(), v.integer(), v.minValue(1)), model: v.pipe(v.string(), v.minLength(1)), reasoning: v.picklist(["low", "medium", "high"]), status: v.picklist(["queued", "running", "cancelling"]), startedAt: v.pipe(v.string(), v.isoTimestamp()) });
const failureSchema = v.strictObject({
  runId: v.pipe(v.string(), v.minLength(1)),
  reason: v.picklist(["cancelled", "failed", "invalid_result", "superseded"]),
  category: v.optional(v.picklist(["authentication_required", "rate_limited", "runtime_unavailable", "timed_out", "execution_failed", "invalid_result", "unexpected_failure"])),
  model: v.optional(v.pipe(v.string(), v.minLength(1))),
  reasoning: v.optional(v.picklist(["low", "medium", "high"])),
  // Retained only so records written by older versions remain readable.
  incidentId: v.optional(v.pipe(v.string(), v.minLength(1))),
  retryable: v.boolean(),
  failedAt: v.pipe(v.string(), v.isoTimestamp()),
});
const dismissalSchema = v.strictObject({ findingId: v.pipe(v.string(), v.minLength(1)), reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)), dismissedAt: v.pipe(v.string(), v.isoTimestamp()) });
const walkthroughProgressSchema = v.strictObject({ reviewedSectionIds: v.array(v.pipe(v.string(), v.minLength(1))), supportReviewed: v.boolean(), currentSectionId: v.optional(v.pipe(v.string(), v.minLength(1))) });
const recordSchema = v.strictObject({ schemaVersion: v.literal(1), reviewId: v.pipe(v.string(), v.minLength(1)), type: v.picklist(["analysis", "walkthrough"]), nextToken: v.pipe(v.number(), v.integer(), v.minValue(1)), retained: v.optional(v.unknown()), dismissals: v.optional(v.array(dismissalSchema)), walkthroughProgress: v.optional(walkthroughProgressSchema), activeRun: v.optional(activeRunSchema), replacementFailure: v.optional(failureSchema), updatedAt: v.pipe(v.string(), v.isoTimestamp()) });

type InsightMutationFailure = "already_running" | "not_active" | "superseded" | "invalid_reason" | "not_available";
export type InsightStoreFailure = StorageFailure | InsightMutationFailure;

export function parseInsightRecord(input: unknown): Result<InsightRecord<unknown>, StorageFailure> {
  const parsed = v.safeParse(recordSchema, input);
  if (!parsed.success) return invalidRead();
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (reviewId._tag === "err") return invalidRead();
  const updatedAt = parseIsoTimestamp(parsed.output.updatedAt);
  if (updatedAt._tag === "err") return invalidRead();
  const activeRun = parsed.output.activeRun === undefined ? undefined : parseActiveRun(parsed.output.activeRun);
  if (activeRun !== undefined && activeRun._tag === "err") return invalidRead();
  const replacementFailure = parsed.output.replacementFailure === undefined ? undefined : parseFailure(parsed.output.replacementFailure);
  if (replacementFailure !== undefined && replacementFailure._tag === "err") return invalidRead();
  const dismissals = parsed.output.dismissals === undefined ? undefined : parseDismissals(parsed.output.dismissals);
  if (dismissals !== undefined && dismissals._tag === "err") return invalidRead();
  const walkthroughProgress = parsed.output.walkthroughProgress;
  return ok({ schemaVersion: 1, reviewId: reviewId.value, type: parsed.output.type, nextToken: parsed.output.nextToken, ...(parsed.output.retained === undefined ? {} : { retained: parsed.output.retained }), ...(dismissals === undefined ? {} : { dismissals: dismissals.value }), ...(walkthroughProgress === undefined ? {} : { walkthroughProgress: parseProgress(walkthroughProgress) }), ...(activeRun === undefined ? {} : { activeRun: activeRun.value }), ...(replacementFailure === undefined ? {} : { replacementFailure: replacementFailure.value }), updatedAt: updatedAt.value });
}

export class InsightStore {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly paths: PatchdeskPaths) {}

  async load(profileId: WorkspaceProfileId, reviewId: ReviewId, type: InsightType): Promise<Result<InsightRecord<unknown>, StorageFailure>> {
    const stored = await readJsonFile(this.paths.insightFile(profileId, reviewId, type));
    if (stored._tag === "err") return stored;
    const parsed = parseInsightRecord(stored.value);
    if (parsed._tag === "err" || parsed.value.reviewId !== reviewId || parsed.value.type !== type) return invalidRead();
    return parsed;
  }

  async loadTyped<T>(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    type: InsightType,
    parseRetained: (input: unknown) => Result<T, unknown>,
  ): Promise<Result<InsightRecord<T>, StorageFailure>> {
    const loaded = await this.load(profileId, reviewId, type);
    if (loaded._tag === "err") return loaded;
    if (loaded.value.retained === undefined) {
      return ok({
        schemaVersion: loaded.value.schemaVersion,
        reviewId: loaded.value.reviewId,
        type: loaded.value.type,
        nextToken: loaded.value.nextToken,
        ...(loaded.value.dismissals === undefined ? {} : { dismissals: loaded.value.dismissals }),
        ...(loaded.value.walkthroughProgress === undefined ? {} : { walkthroughProgress: loaded.value.walkthroughProgress }),
        ...(loaded.value.activeRun === undefined ? {} : { activeRun: loaded.value.activeRun }),
        ...(loaded.value.replacementFailure === undefined ? {} : { replacementFailure: loaded.value.replacementFailure }),
        updatedAt: loaded.value.updatedAt,
      });
    }
    const retained = parseRetained(loaded.value.retained);
    return retained._tag === "err"
      ? invalidRead()
      : ok({ ...loaded.value, retained: retained.value });
  }

  async save(profileId: WorkspaceProfileId, record: InsightRecord<unknown>): Promise<Result<void, StorageFailure>> {
    if (record.reviewId === undefined) return invalidWrite();
    return writeAtomicJson(this.paths.insightFile(profileId, record.reviewId, record.type), record);
  }

  async mutate(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly type: InsightType; readonly now: InsightRecord<unknown>["updatedAt"]; readonly operation: (record: InsightRecord<unknown>) => Result<InsightRecord<unknown>, InsightMutationFailure> }): Promise<Result<InsightRecord<unknown>, InsightStoreFailure>> {
    const key = `${input.profileId}\n${input.reviewId}\n${input.type}`;
    return this.withLock(key, async () => {
      const loaded = await this.load(input.profileId, input.reviewId, input.type);
      const current = loaded._tag === "ok" ? loaded.value : loaded.error.reason === "not_found" ? { schemaVersion: 1 as const, reviewId: input.reviewId, type: input.type, nextToken: 1, updatedAt: input.now } : undefined;
      if (current === undefined) return loaded;
      const changed = input.operation(current);
      if (changed._tag === "err") return changed;
      const saved = await this.save(input.profileId, changed.value);
      if (saved._tag === "err") return saved;
      return this.load(input.profileId, input.reviewId, input.type);
    });
  }

  private async withLock<T>(key: string, operation: () => Promise<Result<T, InsightStoreFailure>>): Promise<Result<T, InsightStoreFailure>> {
    const previous = this.locks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, current);
    if (previous !== undefined) await previous;
    try { return await operation(); } finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); }
  }
}

function parseActiveRun(input: v.InferOutput<typeof activeRunSchema>): Result<NonNullable<InsightRecord<unknown>["activeRun"]>, StorageFailure> {
  const id = parseInsightRunId(input.id); const sessionId = parseReviewSessionId(input.revision.sessionId); const headSha = parseGitSha(input.revision.headSha); const patchHash = parseContentHash(input.revision.patchHash); const startedAt = parseIsoTimestamp(input.startedAt);
  if ([id, sessionId, headSha, patchHash, startedAt].some((value) => value._tag === "err")) return invalidRead();
  if (id._tag === "err" || sessionId._tag === "err" || headSha._tag === "err" || patchHash._tag === "err" || startedAt._tag === "err") return invalidRead();
  return ok({ id: id.value, type: input.type, revision: { sessionId: sessionId.value, headSha: headSha.value, patchHash: patchHash.value }, token: input.token, model: input.model, reasoning: input.reasoning, status: input.status, startedAt: startedAt.value });
}
function parseFailure(input: v.InferOutput<typeof failureSchema>): Result<NonNullable<InsightRecord<unknown>["replacementFailure"]>, StorageFailure> {
  const runId = parseInsightRunId(input.runId);
  const failedAt = parseIsoTimestamp(input.failedAt);
  if (runId._tag === "err" || failedAt._tag === "err") return invalidRead();
  const category = input.category;
  return ok({
    runId: runId.value,
    reason: input.reason,
    ...(category === undefined ? {} : { category }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
    ...(input.incidentId === undefined ? {} : { incidentId: input.incidentId }),
    retryable: input.retryable,
    failedAt: failedAt.value,
  });
}
function parseDismissals(input: ReadonlyArray<v.InferOutput<typeof dismissalSchema>>): Result<ReadonlyArray<InsightFindingDismissal>, StorageFailure> {
  const values: Array<InsightFindingDismissal> = [];
  const seen = new Set<string>();
  for (const dismissal of input) {
    const findingId = parseFindingId(dismissal.findingId);
    const dismissedAt = parseIsoTimestamp(dismissal.dismissedAt);
    if (findingId._tag === "err" || dismissedAt._tag === "err" || dismissal.reason.trim() !== dismissal.reason || seen.has(dismissal.findingId)) return invalidRead();
    seen.add(dismissal.findingId);
    values.push({ findingId: findingId.value, reason: dismissal.reason, dismissedAt: dismissedAt.value });
  }
  return ok(values);
}
function parseProgress(input: v.InferOutput<typeof walkthroughProgressSchema>): WalkthroughProgress {
  return { reviewedSectionIds: [...new Set(input.reviewedSectionIds)], supportReviewed: input.supportReviewed, ...(input.currentSectionId === undefined ? {} : { currentSectionId: input.currentSectionId }) };
}
function invalidRead(): Result<never, StorageFailure> { return err({ _tag: "StorageFailure", operation: "read", reason: "invalid_stored_value" }); }
function invalidWrite(): Result<never, StorageFailure> { return err({ _tag: "StorageFailure", operation: "write", reason: "invalid_stored_value" }); }
