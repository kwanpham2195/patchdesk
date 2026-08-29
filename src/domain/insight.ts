import type {
  ContentHash,
  GitSha,
  InsightRunId,
  IsoTimestamp,
  ReviewSessionId,
} from "./ids";
import {
  sameInsightRevision,
  type InsightFailureCategory,
  type InsightRecord,
  type RetainedInsight,
  type WalkthroughProgress,
} from "./insight-record";
import type { InsightReasoning } from "./insight-provider";
import type { ReviewSession } from "./review-session";
type InsightStatus =
  | "not_generated"
  | "running"
  | "current"
  | "outdated"
  | "failed";

/** Whether the retained source artifact still matches its recorded revision hash. */
export type InsightArtifactStatus = "verified" | "mismatch";

export type InsightScopeProjection = {
  readonly baseShort: string;
  readonly headShort: string;
  readonly commitCount: number;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
};

export type InsightProjection<T> = {
  readonly status: InsightStatus;
  readonly artifactStatus?: InsightArtifactStatus;
  readonly retained?: {
    readonly runId?: InsightRunId;
    readonly sessionId: ReviewSessionId;
    readonly headSha: GitSha;
    readonly generatedAt: IsoTimestamp;
    readonly value: T;
    readonly scope?: InsightScopeProjection;
  };
  readonly progress?: WalkthroughProgress;
  readonly activeRun?: {
    readonly runId?: InsightRunId;
    readonly sessionId: ReviewSessionId;
    readonly startedAt: IsoTimestamp;
  };
  readonly replacementFailure?: {
    /** Run identity doubles as the safe, user-visible correlation ID. */
    readonly runId?: InsightRunId;
    readonly category?: InsightFailureCategory;
    readonly model: string;
    readonly reasoning: InsightReasoning;
    readonly retryable: boolean;
  };
};

/**
 * `projectStoredInsight` is generic in `T`, so a locally declared
 * `-readonly [K in keyof InsightProjection<T>]` draft type (the pattern used
 * elsewhere in this file for concrete, non-generic shapes) is flagged by
 * `anti-slop/no-known-value-widening`: a generic mapped-type alias is always
 * treated as a container that can silently swallow the literal evidence in
 * an assigned object. Building and returning each branch's literal directly,
 * omitting an optional key with `...(cond && { key })` instead of a typed
 * draft plus assignment, keeps every branch checked against this function's
 * own `InsightProjection<T>` return type and avoids that widening entirely.
 * `cond && {...}` (a `LogicalExpression`) also isn't the ternary-with-`{}`
 * shape `no-conditional-empty-object-spread` matches: when `cond` is false
 * it spreads `false`, which — like spreading `undefined` or `null` —
 * contributes no properties, so omission behaves identically to the
 * original conditional spread.
 */
export function projectStoredInsight<T>(
  record: InsightRecord<RetainedInsight<T>> | undefined,
  session: ReviewSession,
  patchHash: ContentHash | undefined,
  decorate: (value: T, record: InsightRecord<RetainedInsight<T>>) => T = (
    value,
  ) => value,
  scope?: InsightScopeProjection,
  artifactStatus?: InsightArtifactStatus,
): InsightProjection<T> {
  const retained =
    record?.retained === undefined
      ? undefined
      : {
          runId: record.retained.runId,
          sessionId: record.retained.revision.sessionId,
          headSha: record.retained.revision.headSha,
          generatedAt: record.retained.generatedAt,
          value: decorate(record.retained.value, record),
          ...(scope !== undefined && { scope }),
        };
  if (record?.activeRun !== undefined) {
    return {
      status: "running",
      ...(artifactStatus !== undefined && { artifactStatus }),
      ...(record.walkthroughProgress !== undefined && {
        progress: record.walkthroughProgress,
      }),
      ...(retained !== undefined && { retained }),
      activeRun: {
        runId: record.activeRun.id,
        sessionId: record.activeRun.revision.sessionId,
        startedAt: record.activeRun.startedAt,
      },
    };
  }
  if (record?.replacementFailure !== undefined) {
    return {
      status: "failed",
      ...(artifactStatus !== undefined && { artifactStatus }),
      ...(record.walkthroughProgress !== undefined && {
        progress: record.walkthroughProgress,
      }),
      ...(retained !== undefined && { retained }),
      replacementFailure: {
        runId: record.replacementFailure.runId,
        ...(record.replacementFailure.category !== undefined && {
          category: record.replacementFailure.category,
        }),
        model: record.replacementFailure.model,
        reasoning: record.replacementFailure.reasoning,
        retryable: record.replacementFailure.retryable,
      },
    };
  }
  if (retained === undefined)
    return {
      status: "not_generated",
      ...(record?.walkthroughProgress !== undefined && {
        progress: record.walkthroughProgress,
      }),
    };
  const retainedRecord = record?.retained;
  const isCurrent =
    retainedRecord !== undefined &&
    patchHash !== undefined &&
    sameInsightRevision(retainedRecord.revision, {
      sessionId: session.id,
      headSha: session.key.headSha,
      patchHash,
    });
  return {
    status: isCurrent ? "current" : "outdated",
    ...(artifactStatus !== undefined && { artifactStatus }),
    ...(record?.walkthroughProgress !== undefined && {
      progress: record.walkthroughProgress,
    }),
    retained,
  };
}
