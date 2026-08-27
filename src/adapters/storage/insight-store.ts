import * as v from "valibot";

import { definedProps } from "../../domain/defined-props";
import {
  parseContentHash,
  parseFindingId,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  parseReviewId,
  parseReviewSessionId,
  type ReviewId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import {
  parseRetainedInsight,
  type InsightFailure,
  type InsightFindingDismissal,
  type InsightRecord,
  type InsightRun,
  type InsightType,
  type RetainedInsight,
  type RetainedInsightEnvelope,
  type WalkthroughProgress,
} from "../../domain/insight-record";
import { KeyedMutex } from "../../domain/keyed-mutex";
import { err, ok, type Result } from "../../domain/result";
import {
  readJsonFile,
  writeAtomicJson,
  type StorageFailure,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

const revisionSchema = v.strictObject({
  sessionId: v.pipe(v.string(), v.minLength(1)),
  headSha: v.pipe(v.string(), v.minLength(40)),
  patchHash: v.pipe(v.string(), v.length(64)),
});
const reasoningSchema = v.picklist([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const providerSchema = v.picklist(["pi", "codex-cli-account"]);
const activeRunFields = {
  id: v.pipe(v.string(), v.minLength(1)),
  type: v.picklist(["analysis", "walkthrough"]),
  revision: revisionSchema,
  token: v.pipe(v.number(), v.integer(), v.minValue(1)),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: reasoningSchema,
  status: v.picklist(["queued", "running", "cancelling"]),
  startedAt: v.pipe(v.string(), v.isoTimestamp()),
};
const activeRunSchemaV2 = v.strictObject({
  ...activeRunFields,
  provider: providerSchema,
});
const failureFields = {
  runId: v.pipe(v.string(), v.minLength(1)),
  reason: v.picklist(["cancelled", "failed", "invalid_result", "superseded"]),
  category: v.optional(
    v.picklist([
      "authentication_required",
      "rate_limited",
      "runtime_unavailable",
      "timed_out",
      "execution_failed",
      "invalid_result",
      "unexpected_failure",
    ]),
  ),
  provider: providerSchema,
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: reasoningSchema,
  retryable: v.boolean(),
  failedAt: v.pipe(v.string(), v.isoTimestamp()),
};
const failureSchema = v.strictObject(failureFields);
const dismissalSchema = v.strictObject({
  findingId: v.pipe(v.string(), v.minLength(1)),
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  dismissedAt: v.pipe(v.string(), v.isoTimestamp()),
});
const walkthroughProgressSchema = v.strictObject({
  reviewedSectionIds: v.array(v.pipe(v.string(), v.minLength(1))),
  supportReviewed: v.boolean(),
  currentSectionId: v.optional(v.pipe(v.string(), v.minLength(1))),
});
const recordFields = {
  reviewId: v.pipe(v.string(), v.minLength(1)),
  type: v.picklist(["analysis", "walkthrough"]),
  nextToken: v.pipe(v.number(), v.integer(), v.minValue(1)),
  retained: v.optional(v.unknown()),
  dismissals: v.optional(v.array(dismissalSchema)),
  walkthroughProgress: v.optional(walkthroughProgressSchema),
  replacementFailure: v.optional(failureSchema),
  updatedAt: v.pipe(v.string(), v.isoTimestamp()),
};
const recordSchemaV2 = v.strictObject({
  schemaVersion: v.literal(2),
  ...recordFields,
  activeRun: v.optional(activeRunSchemaV2),
});

type InsightMutationFailure =
  | "already_running"
  | "not_active"
  | "superseded"
  | "invalid_reason"
  | "not_available";
export type InsightStoreFailure = StorageFailure | InsightMutationFailure;

/** Parses the single supported schema-2 Insight record. */
export function parseInsightRecord(
  input: unknown,
): Result<InsightRecord<RetainedInsight<unknown>>, StorageFailure> {
  const version = v.safeParse(recordSchemaV2, input);
  return version.success ? parseV2Record(version.output) : invalidRead();
}

/** Owns serialized Insight records and serializes mutations per profile/review/type. */
export class InsightStore {
  private readonly locks = new KeyedMutex();

  constructor(private readonly paths: PatchdeskPaths) {}

  /**
   * The record without its retained value. `parseRetainedInsight` has already
   * proved the envelope, so callers read `runId`, `revision`, `generatedAt`
   * and `provenance` as parsed domain values -- but the provider-shaped
   * `value` is deliberately not in this type. `loadTyped` is the only way
   * that value leaves storage, and it takes the parser that gives it meaning.
   */
  async load(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    type: InsightType,
  ): Promise<Result<InsightRecord<RetainedInsightEnvelope>, StorageFailure>> {
    return this.loadRecord(profileId, reviewId, type);
  }

  /** The record with its retained value parsed by the caller's own parser. */
  async loadTyped<T>(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    type: InsightType,
    parseRetainedValue: (input: unknown) => Result<T, unknown>,
  ): Promise<Result<InsightRecord<RetainedInsight<T>>, StorageFailure>> {
    const loaded = await this.loadRecord(profileId, reviewId, type);
    if (loaded._tag === "err") return loaded;
    const stored = loaded.value.retained;
    if (stored === undefined) {
      return ok({
        schemaVersion: 2,
        reviewId: loaded.value.reviewId,
        type: loaded.value.type,
        nextToken: loaded.value.nextToken,
        ...definedProps({
          dismissals: loaded.value.dismissals,
          walkthroughProgress: loaded.value.walkthroughProgress,
          activeRun: loaded.value.activeRun,
          replacementFailure: loaded.value.replacementFailure,
        }),
        updatedAt: loaded.value.updatedAt,
      });
    }
    const value = parseRetainedValue(stored.value);
    return value._tag === "err"
      ? invalidRead()
      : ok({ ...loaded.value, retained: { ...stored, value: value.value } });
  }

  private async loadRecord(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    type: InsightType,
  ): Promise<Result<InsightRecord<RetainedInsight<unknown>>, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.insightFile(profileId, reviewId, type),
    );
    if (stored._tag === "err") return stored;
    const parsed = parseInsightRecord(stored.value);
    if (
      parsed._tag === "err" ||
      parsed.value.reviewId !== reviewId ||
      parsed.value.type !== type
    )
      return invalidRead();
    return parsed;
  }

  async save(
    profileId: WorkspaceProfileId,
    record: InsightRecord<unknown>,
  ): Promise<Result<void, StorageFailure>> {
    const parsed = parseInsightRecord(record);
    if (
      parsed._tag === "err" ||
      parsed.value.reviewId !== record.reviewId ||
      parsed.value.type !== record.type
    )
      return invalidWrite();
    return writeAtomicJson(
      this.paths.insightFile(
        profileId,
        parsed.value.reviewId,
        parsed.value.type,
      ),
      parsed.value,
    );
  }

  async mutate(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly type: InsightType;
    readonly now: InsightRecord<unknown>["updatedAt"];
    readonly operation: (
      record: InsightRecord<RetainedInsight<unknown>>,
    ) => Result<InsightRecord<unknown>, InsightMutationFailure>;
  }): Promise<
    Result<InsightRecord<RetainedInsightEnvelope>, InsightStoreFailure>
  > {
    const key = `${input.profileId}\n${input.reviewId}\n${input.type}`;
    return this.locks.run(key, async () => {
      const loaded = await this.loadRecord(
        input.profileId,
        input.reviewId,
        input.type,
      );
      const current =
        loaded._tag === "ok"
          ? loaded.value
          : loaded.error.reason === "not_found"
            ? {
                schemaVersion: 2 as const,
                reviewId: input.reviewId,
                type: input.type,
                nextToken: 1,
                updatedAt: input.now,
              }
            : undefined;
      if (current === undefined) return loaded;
      const changed = input.operation(current);
      if (changed._tag === "err") return changed;
      const saved = await this.save(input.profileId, changed.value);
      if (saved._tag === "err") return saved;
      return this.loadRecord(input.profileId, input.reviewId, input.type);
    });
  }
}

function parseV2Record(
  input: v.InferOutput<typeof recordSchemaV2>,
): Result<InsightRecord<RetainedInsight<unknown>>, StorageFailure> {
  const common = parseCommonRecord(input);
  if (common._tag === "err") return common;
  const activeRun =
    input.activeRun === undefined ? undefined : parseActiveRun(input.activeRun);
  if (activeRun?._tag === "err") return invalidRead();
  const replacementFailure =
    input.replacementFailure === undefined
      ? undefined
      : parseFailure(input.replacementFailure);
  if (replacementFailure?._tag === "err") return invalidRead();
  const retained =
    input.retained === undefined
      ? undefined
      : parseRetainedInsight(input.retained, (value) => ok(value));
  if (retained?._tag === "err") return invalidRead();
  return ok({
    ...common.value,
    ...definedProps({
      retained: retained?.value,
      activeRun: activeRun?.value,
      replacementFailure: replacementFailure?.value,
    }),
  });
}

function parseCommonRecord(input: {
  readonly reviewId: string;
  readonly type: InsightType;
  readonly nextToken: number;
  readonly retained?: unknown | undefined;
  readonly dismissals?:
    | ReadonlyArray<v.InferOutput<typeof dismissalSchema>>
    | undefined;
  readonly walkthroughProgress?:
    | v.InferOutput<typeof walkthroughProgressSchema>
    | undefined;
  readonly replacementFailure?: v.InferOutput<typeof failureSchema> | undefined;
  readonly updatedAt: string;
}): Result<
  Omit<
    InsightRecord<RetainedInsight<unknown>>,
    "retained" | "activeRun" | "replacementFailure"
  >,
  StorageFailure
> {
  const reviewId = parseReviewId(input.reviewId);
  const updatedAt = parseIsoTimestamp(input.updatedAt);
  if (reviewId._tag === "err" || updatedAt._tag === "err") return invalidRead();
  const dismissals =
    input.dismissals === undefined
      ? undefined
      : parseDismissals(input.dismissals);
  if (dismissals?._tag === "err") return invalidRead();
  const walkthroughProgress =
    input.walkthroughProgress === undefined
      ? undefined
      : parseProgress(input.walkthroughProgress);
  if (walkthroughProgress?._tag === "err") return invalidRead();
  return ok({
    schemaVersion: 2,
    reviewId: reviewId.value,
    type: input.type,
    nextToken: input.nextToken,
    ...definedProps({
      dismissals: dismissals?.value,
      walkthroughProgress: walkthroughProgress?.value,
    }),
    updatedAt: updatedAt.value,
  });
}

function parseActiveRun(
  input: v.InferOutput<typeof activeRunSchemaV2>,
): Result<InsightRun, StorageFailure> {
  const id = parseInsightRunId(input.id);
  const sessionId = parseReviewSessionId(input.revision.sessionId);
  const headSha = parseGitSha(input.revision.headSha);
  const patchHash = parseContentHash(input.revision.patchHash);
  const startedAt = parseIsoTimestamp(input.startedAt);
  if (
    id._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err" ||
    startedAt._tag === "err"
  )
    return invalidRead();
  const provider = input.provider;
  return ok({
    id: id.value,
    type: input.type,
    revision: {
      sessionId: sessionId.value,
      headSha: headSha.value,
      patchHash: patchHash.value,
    },
    token: input.token,
    provider,
    model: input.model,
    reasoning: input.reasoning,
    status: input.status,
    startedAt: startedAt.value,
  });
}

function parseFailure(
  input: v.InferOutput<typeof failureSchema>,
): Result<InsightFailure, StorageFailure> {
  const runId = parseInsightRunId(input.runId);
  const failedAt = parseIsoTimestamp(input.failedAt);
  if (runId._tag === "err" || failedAt._tag === "err") return invalidRead();
  const provider = input.provider;
  return ok({
    runId: runId.value,
    reason: input.reason,
    provider,
    model: input.model,
    reasoning: input.reasoning,
    ...definedProps({ category: input.category }),
    retryable: input.retryable,
    failedAt: failedAt.value,
  });
}

function parseDismissals(
  input: ReadonlyArray<v.InferOutput<typeof dismissalSchema>>,
): Result<ReadonlyArray<InsightFindingDismissal>, StorageFailure> {
  const values: Array<InsightFindingDismissal> = [];
  const seen = new Set<string>();
  for (const dismissal of input) {
    const findingId = parseFindingId(dismissal.findingId);
    const dismissedAt = parseIsoTimestamp(dismissal.dismissedAt);
    if (
      findingId._tag === "err" ||
      dismissedAt._tag === "err" ||
      dismissal.reason.trim() !== dismissal.reason ||
      seen.has(dismissal.findingId)
    )
      return invalidRead();
    seen.add(dismissal.findingId);
    values.push({
      findingId: findingId.value,
      reason: dismissal.reason,
      dismissedAt: dismissedAt.value,
    });
  }
  return ok(values);
}

function parseProgress(
  input: v.InferOutput<typeof walkthroughProgressSchema>,
): Result<WalkthroughProgress, StorageFailure> {
  if (
    new Set(input.reviewedSectionIds).size !== input.reviewedSectionIds.length
  )
    return invalidRead();
  return ok({
    reviewedSectionIds: input.reviewedSectionIds,
    supportReviewed: input.supportReviewed,
    ...definedProps({ currentSectionId: input.currentSectionId }),
  });
}

function invalidRead(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}
function invalidWrite(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "write",
    reason: "invalid_stored_value",
  });
}
