import * as v from "valibot";

import { parseContentHash, parseGitSha, parseInsightRunId, parseIsoTimestamp, parseReviewId, parseReviewSessionId, type ReviewId, type WorkspaceProfileId } from "../../domain/ids";
import type { InsightType } from "../../domain/insight-record";
import { err, ok, type Result } from "../../domain/result";
import type { InsightRecord } from "../../domain/insight-record";
import { readJsonFile, writeAtomicJson, type StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

const revisionSchema = v.strictObject({ sessionId: v.pipe(v.string(), v.minLength(1)), headSha: v.pipe(v.string(), v.minLength(40)), patchHash: v.pipe(v.string(), v.length(64)) });
const activeRunSchema = v.strictObject({ id: v.pipe(v.string(), v.minLength(1)), type: v.picklist(["analysis", "walkthrough"]), revision: revisionSchema, token: v.pipe(v.number(), v.integer(), v.minValue(1)), model: v.pipe(v.string(), v.minLength(1)), reasoning: v.picklist(["low", "medium", "high"]), status: v.picklist(["queued", "running", "cancelling"]), startedAt: v.pipe(v.string(), v.isoTimestamp()) });
const failureSchema = v.strictObject({ runId: v.pipe(v.string(), v.minLength(1)), reason: v.picklist(["cancelled", "failed", "invalid_result", "superseded"]), incidentId: v.optional(v.pipe(v.string(), v.minLength(1))), retryable: v.boolean(), failedAt: v.pipe(v.string(), v.isoTimestamp()) });
const recordSchema = v.strictObject({ schemaVersion: v.literal(1), reviewId: v.pipe(v.string(), v.minLength(1)), type: v.picklist(["analysis", "walkthrough"]), nextToken: v.pipe(v.number(), v.integer(), v.minValue(1)), retained: v.optional(v.unknown()), activeRun: v.optional(activeRunSchema), replacementFailure: v.optional(failureSchema), updatedAt: v.pipe(v.string(), v.isoTimestamp()) });

type InsightMutationFailure = "already_running" | "not_active" | "superseded";
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
  return ok({ schemaVersion: 1, reviewId: reviewId.value, type: parsed.output.type, nextToken: parsed.output.nextToken, ...(parsed.output.retained === undefined ? {} : { retained: parsed.output.retained }), ...(activeRun === undefined ? {} : { activeRun: activeRun.value }), ...(replacementFailure === undefined ? {} : { replacementFailure: replacementFailure.value }), updatedAt: updatedAt.value });
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
function parseFailure(input: v.InferOutput<typeof failureSchema>): Result<NonNullable<InsightRecord<unknown>["replacementFailure"]>, StorageFailure> { const runId = parseInsightRunId(input.runId); const failedAt = parseIsoTimestamp(input.failedAt); if (runId._tag === "err" || failedAt._tag === "err") return invalidRead(); return ok({ runId: runId.value, reason: input.reason, ...(input.incidentId === undefined ? {} : { incidentId: input.incidentId }), retryable: input.retryable, failedAt: failedAt.value }); }
function invalidRead(): Result<never, StorageFailure> { return err({ _tag: "StorageFailure", operation: "read", reason: "invalid_stored_value" }); }
function invalidWrite(): Result<never, StorageFailure> { return err({ _tag: "StorageFailure", operation: "write", reason: "invalid_stored_value" }); }
