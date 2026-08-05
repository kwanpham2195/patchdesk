import type { GitSha, InsightRunId, IsoTimestamp, ReviewSessionId } from "./ids";
import type { InsightFailureCategory, WalkthroughProgress } from "./insight-record";
export type InsightStatus =
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
  readonly changedFiles: ReadonlyArray<{ readonly path: string; readonly additions: number; readonly deletions: number }>;
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
    readonly model?: string;
    readonly reasoning?: "low" | "medium" | "high";
    readonly incidentId?: string;
    readonly retryable: boolean;
  };
};
