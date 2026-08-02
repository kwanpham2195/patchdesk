import type { GitSha, InsightRunId, IsoTimestamp, ReviewSessionId } from "./ids";
import type { WalkthroughProgress } from "./insight-record";
export type InsightStatus =
  | "not_generated"
  | "running"
  | "current"
  | "outdated"
  | "failed";

export type InsightProjection<T> = {
  readonly status: InsightStatus;
  readonly retained?: {
    readonly runId?: InsightRunId;
    readonly sessionId: ReviewSessionId;
    readonly headSha: GitSha;
    readonly generatedAt: IsoTimestamp;
    readonly value: T;
  };
  readonly progress?: WalkthroughProgress;
  readonly activeRun?: {
    readonly sessionId: ReviewSessionId;
    readonly startedAt: IsoTimestamp;
  };
  readonly replacementFailure?: {
    readonly incidentId?: string;
    readonly retryable: boolean;
  };
};
