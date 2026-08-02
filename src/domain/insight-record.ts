import type { ContentHash, GitSha, InsightRunId, IsoTimestamp, ReviewId, ReviewSessionId } from "./ids";
import { err, ok, type Result } from "./result";

export type InsightType = "analysis" | "walkthrough";
export type InsightRevision = { readonly sessionId: ReviewSessionId; readonly headSha: GitSha; readonly patchHash: ContentHash };
export type InsightRun = { readonly id: InsightRunId; readonly type: InsightType; readonly revision: InsightRevision; readonly token: number; readonly model: string; readonly reasoning: "low" | "medium" | "high"; readonly status: "queued" | "running" | "cancelling"; readonly startedAt: IsoTimestamp };
export type RetainedInsight<T> = { readonly runId: InsightRunId; readonly revision: InsightRevision; readonly generatedAt: IsoTimestamp; readonly value: T };
export type InsightFailure = { readonly runId: InsightRunId; readonly reason: "cancelled" | "failed" | "invalid_result" | "superseded"; readonly incidentId?: string; readonly retryable: boolean; readonly failedAt: IsoTimestamp };
export type InsightRecord<T> = { readonly schemaVersion: 1; readonly reviewId: ReviewId; readonly type: InsightType; readonly nextToken: number; readonly retained?: T; readonly activeRun?: InsightRun; readonly replacementFailure?: InsightFailure; readonly updatedAt: IsoTimestamp };

export function createInsightRecord(input: { readonly reviewId: ReviewId; readonly type: InsightType; readonly updatedAt: IsoTimestamp }): InsightRecord<unknown> {
  return { schemaVersion: 1, reviewId: input.reviewId, type: input.type, nextToken: 1, updatedAt: input.updatedAt };
}

export function beginInsightRun(record: InsightRecord<unknown>, input: { readonly id: InsightRunId; readonly revision: InsightRevision; readonly model: string; readonly reasoning: "low" | "medium" | "high"; readonly startedAt: IsoTimestamp }): Result<InsightRecord<unknown>, "already_running"> {
  if (record.activeRun !== undefined) return err("already_running");
  const { replacementFailure: _replacementFailure, ...withoutFailure } = record;
  void _replacementFailure;
  return ok({ ...withoutFailure, nextToken: record.nextToken + 1, activeRun: { ...input, type: record.type, token: record.nextToken, status: "queued" }, updatedAt: input.startedAt });
}

export function requestInsightCancellation(record: InsightRecord<unknown>, runId: InsightRunId, at: IsoTimestamp): Result<InsightRecord<unknown>, "not_active"> {
  if (record.activeRun?.id !== runId) return err("not_active");
  return ok({ ...record, activeRun: { ...record.activeRun, status: "cancelling" }, updatedAt: at });
}

export function completeInsightRun<T>(record: InsightRecord<unknown>, runId: InsightRunId, retained: RetainedInsight<T>, at: IsoTimestamp): Result<InsightRecord<RetainedInsight<T>>, "superseded"> {
  if (record.activeRun?.id !== runId) return err("superseded");
  const { activeRun: _activeRun, replacementFailure: _replacementFailure, ...withoutActiveRun } = record;
  void _activeRun;
  void _replacementFailure;
  return ok({ ...withoutActiveRun, retained, updatedAt: at });
}

export function failInsightRun(record: InsightRecord<unknown>, runId: InsightRunId, failure: InsightFailure, at: IsoTimestamp): Result<InsightRecord<unknown>, "superseded"> {
  if (record.activeRun?.id !== runId) return err("superseded");
  const { activeRun: _activeRun, ...withoutActiveRun } = record;
  void _activeRun;
  return ok({ ...withoutActiveRun, replacementFailure: failure, updatedAt: at });
}
