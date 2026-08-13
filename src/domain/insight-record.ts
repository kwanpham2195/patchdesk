import type {
  ContentHash,
  FindingId,
  GitSha,
  InsightRunId,
  IsoTimestamp,
  ReviewId,
  ReviewSessionId,
} from "./ids";
import { err, ok, type Result } from "./result";
import type {
  InsightProvenance,
  InsightProvider,
  InsightReasoning,
} from "./insight-provider";

export type InsightType = "analysis" | "walkthrough";
export type InsightRevision = {
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly patchHash: ContentHash;
};
export type InsightRun = {
  readonly id: InsightRunId;
  readonly type: InsightType;
  readonly revision: InsightRevision;
  readonly token: number;
  readonly provider: InsightProvider;
  readonly model: string;
  readonly reasoning: InsightReasoning;
  readonly status: "queued" | "running" | "cancelling";
  readonly startedAt: IsoTimestamp;
};
export type RetainedInsight<T> = {
  readonly runId: InsightRunId;
  readonly revision: InsightRevision;
  readonly generatedAt: IsoTimestamp;
  readonly provenance: InsightProvenance;
  readonly value: T;
};
export type InsightFindingDismissal = {
  readonly findingId: FindingId;
  readonly reason: string;
  readonly dismissedAt: IsoTimestamp;
};
export type WalkthroughProgress = {
  readonly reviewedSectionIds: ReadonlyArray<string>;
  readonly supportReviewed: boolean;
  readonly currentSectionId?: string;
};
/** Safe, provider-independent categories suitable for durable user-facing diagnostics. */
export type InsightFailureCategory =
  | "authentication_required"
  | "rate_limited"
  | "runtime_unavailable"
  | "timed_out"
  | "execution_failed"
  | "invalid_result"
  | "unexpected_failure";
export type InsightFailure = {
  readonly runId: InsightRunId;
  readonly reason: "cancelled" | "failed" | "invalid_result" | "superseded";
  readonly category?: InsightFailureCategory;
  readonly provider: InsightProvider;
  readonly model: string;
  readonly reasoning: InsightReasoning;
  readonly retryable: boolean;
  readonly failedAt: IsoTimestamp;
};
export type InsightFailureInput = Omit<
  InsightFailure,
  "provider" | "model" | "reasoning"
> &
  Partial<Pick<InsightFailure, "provider" | "model" | "reasoning">>;
export type InsightRecord<T> = {
  readonly schemaVersion: 2;
  readonly reviewId: ReviewId;
  readonly type: InsightType;
  readonly nextToken: number;
  readonly retained?: T;
  readonly dismissals?: ReadonlyArray<InsightFindingDismissal>;
  readonly walkthroughProgress?: WalkthroughProgress;
  readonly activeRun?: InsightRun;
  readonly replacementFailure?: InsightFailure;
  readonly updatedAt: IsoTimestamp;
};

/** Creates an empty schema-v2 Insight record. */
export function createInsightRecord(input: {
  readonly reviewId: ReviewId;
  readonly type: InsightType;
  readonly updatedAt: IsoTimestamp;
}): InsightRecord<unknown> {
  return {
    schemaVersion: 2,
    reviewId: input.reviewId,
    type: input.type,
    nextToken: 1,
    updatedAt: input.updatedAt,
  };
}

/** Starts one provider-bound Insight run and captures its immutable selection. */
export function beginInsightRun(
  record: InsightRecord<unknown>,
  input: {
    readonly id: InsightRunId;
    readonly revision: InsightRevision;
    readonly provider: InsightProvider;
    readonly model: string;
    readonly reasoning: InsightReasoning;
    readonly startedAt: IsoTimestamp;
  },
): Result<InsightRecord<unknown>, "already_running"> {
  if (record.activeRun !== undefined) return err("already_running");
  const { replacementFailure: _replacementFailure, ...withoutFailure } = record;
  void _replacementFailure;
  return ok({
    ...withoutFailure,
    nextToken: record.nextToken + 1,
    activeRun: {
      ...input,
      type: record.type,
      token: record.nextToken,
      status: "queued",
    },
    updatedAt: input.startedAt,
  });
}

function withoutWalkthroughProgress(
  record: InsightRecord<unknown>,
): Omit<InsightRecord<unknown>, "walkthroughProgress"> {
  const { walkthroughProgress: _walkthroughProgress, ...withoutProgress } =
    record;
  void _walkthroughProgress;
  return withoutProgress;
}

/** Marks the owned active run as cancelling. */
export function requestInsightCancellation(
  record: InsightRecord<unknown>,
  runId: InsightRunId,
  at: IsoTimestamp,
): Result<InsightRecord<unknown>, "not_active"> {
  if (record.activeRun?.id !== runId) return err("not_active");
  return ok({
    ...record,
    activeRun: { ...record.activeRun, status: "cancelling" },
    updatedAt: at,
  });
}

/** Replaces the retained result only when the supplied run still owns the record. */
export function completeInsightRun<T>(
  record: InsightRecord<unknown>,
  runId: InsightRunId,
  retained: RetainedInsight<T>,
  at: IsoTimestamp,
): Result<InsightRecord<RetainedInsight<T>>, "superseded"> {
  if (record.activeRun?.id !== runId) return err("superseded");
  const {
    activeRun: _activeRun,
    replacementFailure: _replacementFailure,
    dismissals: _dismissals,
    ...withoutActiveRun
  } = record;
  void _activeRun;
  void _replacementFailure;
  void _dismissals;
  const next =
    record.type === "walkthrough"
      ? withoutWalkthroughProgress(withoutActiveRun)
      : withoutActiveRun;
  return ok({ ...next, retained, updatedAt: at });
}

/** Dismisses one retained Analysis Finding without changing the retained result. */
export function dismissInsightFinding(
  record: InsightRecord<unknown>,
  findingId: FindingId,
  reason: string,
  dismissedAt: IsoTimestamp,
): Result<InsightRecord<unknown>, "invalid_reason" | "not_available"> {
  const trimmed = reason.trim();
  if (trimmed.length < 1 || trimmed.length > 500) return err("invalid_reason");
  if (record.type !== "analysis" || record.retained === undefined)
    return err("not_available");
  if (record.dismissals?.some((dismissal) => dismissal.findingId === findingId))
    return ok(record);
  return ok({
    ...record,
    dismissals: [
      ...(record.dismissals ?? []),
      { findingId, reason: trimmed, dismissedAt },
    ],
    updatedAt: dismissedAt,
  });
}

/** Updates walkthrough progress for the currently retained walkthrough. */
export function updateWalkthroughProgress(
  record: InsightRecord<unknown>,
  progress: WalkthroughProgress,
  at: IsoTimestamp,
): Result<InsightRecord<unknown>, "not_available"> {
  if (record.type !== "walkthrough" || record.retained === undefined)
    return err("not_available");
  const reviewedSectionIds = [
    ...new Set(
      progress.reviewedSectionIds.filter((id) => id.trim().length > 0),
    ),
  ];
  return ok({
    ...record,
    walkthroughProgress: {
      reviewedSectionIds,
      supportReviewed: progress.supportReviewed,
      ...(progress.currentSectionId === undefined
        ? {}
        : { currentSectionId: progress.currentSectionId }),
    },
    updatedAt: at,
  });
}

/** Records a terminal failure while preserving the selected run provenance. */
export function failInsightRun(
  record: InsightRecord<unknown>,
  runId: InsightRunId,
  failure: InsightFailureInput,
  at: IsoTimestamp,
): Result<InsightRecord<unknown>, "superseded"> {
  if (record.activeRun?.id !== runId) return err("superseded");
  const { activeRun: _activeRun, ...withoutActiveRun } = record;
  void _activeRun;
  const replacementFailure: InsightFailure = {
    ...failure,
    provider: failure.provider ?? record.activeRun.provider,
    model: failure.model ?? record.activeRun.model,
    reasoning: failure.reasoning ?? record.activeRun.reasoning,
  };
  return ok({ ...withoutActiveRun, replacementFailure, updatedAt: at });
}

/** Extracts the current run's provider provenance for retained-result persistence. */
export function provenanceFromRun(run: InsightRun): InsightProvenance {
  return { provider: run.provider, model: run.model, reasoning: run.reasoning };
}
