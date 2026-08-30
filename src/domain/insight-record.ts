import * as v from "valibot";

import { definedProps } from "./defined-props";
import {
  parseContentHash,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  parseReviewSessionId,
  type ContentHash,
  type FindingId,
  type GitSha,
  type InsightRunId,
  type IsoTimestamp,
  type ReviewId,
  type ReviewSessionId,
} from "./ids";
import { err, ok, type Result } from "./result";
import {
  parseInsightProvider,
  parseInsightReasoning,
  type InsightProvenance,
  type InsightProvider,
  type InsightReasoning,
} from "./insight-provider";

export type InsightType = "analysis" | "walkthrough" | "brief";
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
/** A retained Insight with its provider-shaped value withheld. See `InsightStore.load`. */
export type RetainedInsightEnvelope = Omit<RetainedInsight<unknown>, "value">;
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

/** True when two Insight revisions name the same session, head, and patch bytes. */
export function sameInsightRevision(
  a: InsightRevision,
  b: InsightRevision,
): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.headSha === b.headSha &&
    a.patchHash === b.patchHash
  );
}

/**
 * The stored shape of `retained`: a fixed envelope around one provider-shaped
 * `value` this module cannot know. Anything outside the envelope, or an
 * envelope field that fails its own domain parser, is a corrupt record.
 */
const retainedEnvelopeSchema = v.strictObject({
  runId: v.pipe(v.string(), v.minLength(1)),
  revision: v.strictObject({
    sessionId: v.pipe(v.string(), v.minLength(1)),
    headSha: v.pipe(v.string(), v.minLength(40)),
    patchHash: v.pipe(v.string(), v.length(64)),
  }),
  generatedAt: v.pipe(v.string(), v.isoTimestamp()),
  provenance: v.strictObject({
    provider: v.unknown(),
    model: v.pipe(
      v.string(),
      v.check((value) => value.trim().length > 0, "model must not be blank"),
      v.maxLength(200),
    ),
    reasoning: v.unknown(),
  }),
  value: v.unknown(),
});

/**
 * The one parser for a stored `retained` entry. It owns the envelope --
 * run id, revision, timestamp, provenance -- and hands only `value` to the
 * caller's parser, because the retained value's shape belongs to whichever
 * Insight produced it.
 *
 * Every read of a stored Insight goes through here, so no caller has to
 * rebuild the envelope rules or cast an unparsed record back into JSON.
 */
export function parseRetainedInsight<T>(
  raw: unknown,
  parseValue: (input: unknown) => Result<T, unknown>,
): Result<RetainedInsight<T>, undefined> {
  const envelope = v.safeParse(retainedEnvelopeSchema, raw);
  if (!envelope.success) return err(undefined);
  const runId = parseInsightRunId(envelope.output.runId);
  const sessionId = parseReviewSessionId(envelope.output.revision.sessionId);
  const headSha = parseGitSha(envelope.output.revision.headSha);
  const patchHash = parseContentHash(envelope.output.revision.patchHash);
  const generatedAt = parseIsoTimestamp(envelope.output.generatedAt);
  const provider = parseInsightProvider(envelope.output.provenance.provider);
  const reasoning = parseInsightReasoning(envelope.output.provenance.reasoning);
  const value = parseValue(envelope.output.value);
  if (
    runId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err" ||
    generatedAt._tag === "err" ||
    provider._tag === "err" ||
    reasoning._tag === "err" ||
    value._tag === "err"
  )
    return err(undefined);
  return ok({
    runId: runId.value,
    revision: {
      sessionId: sessionId.value,
      headSha: headSha.value,
      patchHash: patchHash.value,
    },
    generatedAt: generatedAt.value,
    provenance: {
      provider: provider.value,
      model: envelope.output.provenance.model,
      reasoning: reasoning.value,
    },
    value: value.value,
  });
}

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
      ...definedProps({ currentSectionId: progress.currentSectionId }),
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
