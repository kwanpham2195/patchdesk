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
import type {
  InsightFailure,
  InsightFindingDismissal,
  InsightRecord,
  InsightRun,
  InsightType,
  RetainedInsight,
  WalkthroughProgress,
} from "../../domain/insight-record";
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
const provenanceSchema = v.strictObject({
  provider: providerSchema,
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: reasoningSchema,
});
const retainedSchema = v.strictObject({
  runId: v.pipe(v.string(), v.minLength(1)),
  revision: revisionSchema,
  generatedAt: v.pipe(v.string(), v.isoTimestamp()),
  provenance: provenanceSchema,
  value: v.unknown(),
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
  retained: v.optional(retainedSchema),
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
): Result<InsightRecord<unknown>, StorageFailure> {
  const version = v.safeParse(recordSchemaV2, input);
  return version.success ? parseV2Record(version.output) : invalidRead();
}

/** Owns serialized Insight records and serializes mutations per profile/review/type. */
export class InsightStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly paths: PatchdeskPaths) {}

  async load(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    type: InsightType,
  ): Promise<Result<InsightRecord<unknown>, StorageFailure>> {
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

  async loadTyped<T>(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    type: InsightType,
    parseRetainedValue: (input: unknown) => Result<RetainedInsight<T>, unknown>,
  ): Promise<Result<InsightRecord<RetainedInsight<T>>, StorageFailure>> {
    const loaded = await this.load(profileId, reviewId, type);
    if (loaded._tag === "err") return loaded;
    if (loaded.value.retained === undefined) {
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
    const parsedRetained = parseRetained(loaded.value.retained);
    if (parsedRetained._tag === "err") return invalidRead();
    const retained = parseRetainedValue(loaded.value.retained);
    return retained._tag === "err"
      ? invalidRead()
      : ok({ ...loaded.value, retained: retained.value });
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
      record: InsightRecord<unknown>,
    ) => Result<InsightRecord<unknown>, InsightMutationFailure>;
  }): Promise<Result<InsightRecord<unknown>, InsightStoreFailure>> {
    const key = `${input.profileId}\n${input.reviewId}\n${input.type}`;
    return this.withLock(key, async () => {
      const loaded = await this.load(
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
      return this.load(input.profileId, input.reviewId, input.type);
    });
  }

  private async withLock<T>(
    key: string,
    operation: () => Promise<Result<T, InsightStoreFailure>>,
  ): Promise<Result<T, InsightStoreFailure>> {
    const previous = this.locks.get(key);
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    if (previous !== undefined) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

function parseV2Record(
  input: v.InferOutput<typeof recordSchemaV2>,
): Result<InsightRecord<unknown>, StorageFailure> {
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
    input.retained === undefined ? undefined : parseRetained(input.retained);
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
  Omit<InsightRecord<unknown>, "retained" | "activeRun" | "replacementFailure">,
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

function parseRetained(
  input: unknown,
): Result<RetainedInsight<unknown>, StorageFailure> {
  const parsed = v.safeParse(retainedSchema, input);
  if (!parsed.success) return invalidRead();
  const value = parsed.output;
  const runId = parseInsightRunId(value.runId);
  const sessionId = parseReviewSessionId(value.revision.sessionId);
  const headSha = parseGitSha(value.revision.headSha);
  const patchHash = parseContentHash(value.revision.patchHash);
  const generatedAt = parseIsoTimestamp(value.generatedAt);
  if (
    runId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err" ||
    generatedAt._tag === "err"
  )
    return invalidRead();
  return ok({
    runId: runId.value,
    revision: {
      sessionId: sessionId.value,
      headSha: headSha.value,
      patchHash: patchHash.value,
    },
    generatedAt: generatedAt.value,
    provenance: value.provenance,
    value: value.value,
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
