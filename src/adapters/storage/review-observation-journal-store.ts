import { readdir, rm } from "node:fs/promises";

import * as v from "valibot";

import {
  parseContentHash,
  parseIsoTimestamp,
  parseReviewId,
  parseReviewSessionId,
  parseGitSha,
  parseWorkspaceProfileId,
  type ContentHash,
  type IsoTimestamp,
  type ReviewId,
  type ReviewSessionId,
  type GitSha,
  type WorkspaceProfileId,
} from "../../domain/ids";
import {
  parseFindingReviewReceipts,
  parsePendingReviewState,
  type FindingReviewReceipt,
  type PendingReviewState,
} from "../../domain/pending-review";
import { err, ok, type Result } from "../../domain/result";
import type { PatchdeskPaths } from "./patchdesk-paths";
import {
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";

/**
 * The exact cross-store transition for one same-revision observation. The
 * candidate snapshot is saved before this record; this record is removed last.
 */
export type ReviewObservationJournal = {
  readonly schemaVersion: 1;
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly sessionHeadSha: GitSha;
  readonly expectedReviewUpdatedAt: IsoTimestamp;
  readonly expectedSessionUpdatedAt: IsoTimestamp;
  readonly nextSessionUpdatedAt: IsoTimestamp;
  readonly nextReviewUpdatedAt: IsoTimestamp;
  readonly previousSnapshotHash: ContentHash;
  readonly nextSnapshotHash: ContentHash;
  readonly nextPendingReview?: PendingReviewState;
  readonly nextFindingReviewReceipts?: ReadonlyArray<FindingReviewReceipt>;
  readonly createdAt: IsoTimestamp;
};

const journalSchema = v.strictObject({
  schemaVersion: v.literal(1),
  profileId: v.string(),
  reviewId: v.string(),
  sessionId: v.string(),
  sessionHeadSha: v.string(),
  expectedReviewUpdatedAt: v.string(),
  expectedSessionUpdatedAt: v.string(),
  nextSessionUpdatedAt: v.string(),
  nextReviewUpdatedAt: v.string(),
  previousSnapshotHash: v.string(),
  nextSnapshotHash: v.string(),
  nextPendingReview: v.optional(v.unknown()),
  nextFindingReviewReceipts: v.optional(v.unknown()),
  createdAt: v.string(),
});

/** Durable storage for a Review observation's ordered optimistic transition. */
export class ReviewObservationJournalStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  /** Persist the journal after its content-addressed candidate snapshot exists. */
  async save(
    journal: ReviewObservationJournal,
  ): Promise<Result<void, StorageFailure>> {
    const parsed = parseReviewObservationJournal(journal);
    if (parsed._tag === "err") return invalidWrite();
    return writeAtomicJson(
      this.paths.reviewObservationJournalFile(
        parsed.value.profileId,
        parsed.value.reviewId,
      ),
      parsed.value,
    );
  }

  /** Load the one active observation journal, if any. */
  async load(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<ReviewObservationJournal | undefined, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.reviewObservationJournalFile(profileId, reviewId),
    );
    if (stored._tag === "err") {
      return stored.error.reason === "not_found" ? ok(undefined) : stored;
    }
    const parsed = parseReviewObservationJournal(stored.value);
    if (
      parsed._tag === "err" ||
      parsed.value.profileId !== profileId ||
      parsed.value.reviewId !== reviewId
    ) {
      return invalidRead();
    }
    return parsed;
  }

  /** List Review owners that have a journal, including malformed journals. */
  async listReviewIds(
    profileId: WorkspaceProfileId,
  ): Promise<Result<ReadonlyArray<ReviewId>, StorageFailure>> {
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(
        this.paths.profileWorkbenchesDirectory(profileId),
      );
    } catch (cause: unknown) {
      if (isMissing(cause)) return ok([]);
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
    const reviewIds = entries.flatMap((entry) => {
      const reviewId = parseReviewId(entry);
      return reviewId._tag === "ok" ? [reviewId.value] : [];
    });
    const journals = await mapConcurrent(reviewIds, 8, (reviewId) =>
      readJsonFile(
        this.paths.reviewObservationJournalFile(profileId, reviewId),
      ),
    );
    return ok(
      reviewIds.flatMap((reviewId, index) => {
        const journal = journals[index];
        return journal?._tag === "ok" || journal?.error.reason !== "not_found"
          ? [reviewId]
          : [];
      }),
    );
  }

  /** Remove a completed journal only after both durable transitions are exact. */
  /** Remove a completed journal only after both durable transitions are exact. */
  async remove(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<void, StorageFailure>> {
    try {
      await rm(this.paths.reviewObservationJournalFile(profileId, reviewId));
      return ok(undefined);
    } catch (cause: unknown) {
      if (isMissing(cause)) return ok(undefined);
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
  }
}

async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> {
  const values: Array<R> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    const index = next++;
    const item = items[index];
    if (item === undefined) return;
    values[index] = await map(item);
    return worker();
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return values;
}

/** Parse a persisted journal before any recovery code can replay it. */
export function parseReviewObservationJournal(
  input: unknown,
): Result<ReviewObservationJournal, StorageFailure> {
  const raw = v.safeParse(journalSchema, input);
  if (!raw.success) return invalidRead();
  const profileId = parseWorkspaceProfileId(raw.output.profileId);
  const reviewId = parseReviewId(raw.output.reviewId);
  const sessionId = parseReviewSessionId(raw.output.sessionId);
  const sessionHeadSha = parseGitSha(raw.output.sessionHeadSha);
  const expectedReviewUpdatedAt = parseIsoTimestamp(
    raw.output.expectedReviewUpdatedAt,
  );
  const expectedSessionUpdatedAt = parseIsoTimestamp(
    raw.output.expectedSessionUpdatedAt,
  );
  const nextSessionUpdatedAt = parseIsoTimestamp(
    raw.output.nextSessionUpdatedAt,
  );
  const nextReviewUpdatedAt = parseIsoTimestamp(raw.output.nextReviewUpdatedAt);
  const previousSnapshotHash = parseContentHash(
    raw.output.previousSnapshotHash,
  );
  const nextSnapshotHash = parseContentHash(raw.output.nextSnapshotHash);
  const pending =
    raw.output.nextPendingReview === undefined
      ? ok(undefined)
      : parsePendingReviewState(raw.output.nextPendingReview);
  if (
    sessionId._tag === "err" ||
    sessionHeadSha._tag === "err" ||
    pending._tag === "err"
  ) {
    return invalidRead();
  }
  const receipts =
    raw.output.nextFindingReviewReceipts === undefined
      ? ok(undefined)
      : parseFindingReviewReceipts(raw.output.nextFindingReviewReceipts, {
          id: sessionId.value,
          headSha: sessionHeadSha.value,
          ...(pending.value === undefined
            ? {}
            : { pendingReview: pending.value }),
        });
  const createdAt = parseIsoTimestamp(raw.output.createdAt);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    expectedReviewUpdatedAt._tag === "err" ||
    expectedSessionUpdatedAt._tag === "err" ||
    nextSessionUpdatedAt._tag === "err" ||
    nextReviewUpdatedAt._tag === "err" ||
    previousSnapshotHash._tag === "err" ||
    nextSnapshotHash._tag === "err" ||
    receipts._tag === "err" ||
    createdAt._tag === "err" ||
    Date.parse(nextSessionUpdatedAt.value) <=
      Date.parse(expectedSessionUpdatedAt.value) ||
    Date.parse(nextReviewUpdatedAt.value) <=
      Date.parse(expectedReviewUpdatedAt.value)
  ) {
    return invalidRead();
  }
  return ok({
    schemaVersion: 1,
    profileId: profileId.value,
    reviewId: reviewId.value,
    sessionId: sessionId.value,
    sessionHeadSha: sessionHeadSha.value,
    expectedReviewUpdatedAt: expectedReviewUpdatedAt.value,
    expectedSessionUpdatedAt: expectedSessionUpdatedAt.value,
    nextSessionUpdatedAt: nextSessionUpdatedAt.value,
    nextReviewUpdatedAt: nextReviewUpdatedAt.value,
    previousSnapshotHash: previousSnapshotHash.value,
    nextSnapshotHash: nextSnapshotHash.value,
    ...(pending.value === undefined
      ? {}
      : { nextPendingReview: pending.value }),
    ...(receipts.value === undefined
      ? {}
      : { nextFindingReviewReceipts: receipts.value }),
    createdAt: createdAt.value,
  });
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
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
