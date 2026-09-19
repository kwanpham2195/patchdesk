import { rename, rm } from "node:fs/promises";

import * as v from "valibot";

import {
  parseIsoTimestamp,
  type IsoTimestamp,
  type ReviewId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import type { LogEntryInput } from "../../domain/log-entry";
import { err, ok, type Result } from "../../domain/result";
import {
  appendRecentWriteReceipts,
  parseRecentReviewWrite,
  type RecentReviewWrite,
} from "../../domain/recent-review-write";
import type { PatchdeskPaths } from "./patchdesk-paths";
import {
  isNotFound,
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";

/**
 * Backstop for a best-effort own-write journal entry: comfortably longer
 * than the ~90s poll interval and any plausible GitHub read-propagation
 * delay, short enough not to mask a real persistent bug.
 */
const RECENT_WRITE_JOURNAL_AGE_CEILING_MS = 24 * 60 * 60 * 1000;

/** The persisted variant of a typed own-write entry, dated for pruning. */
export type DurableRecentReviewWrite = RecentReviewWrite & {
  readonly writtenAt: IsoTimestamp;
};

const entrySchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("Comment"),
    commentId: v.string(),
    reviewId: v.optional(v.string()),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("ThreadState"),
    threadId: v.string(),
    state: v.picklist(["open", "resolved"]),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("PendingThread"),
    threadId: v.string(),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("DiscardedThread"),
    threadId: v.string(),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("DeletedComment"),
    commentId: v.string(),
    nodeId: v.optional(v.string()),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("DirectSummaryReview"),
    reviewId: v.string(),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("LabelChange"),
    added: v.pipe(v.array(v.string()), v.readonly()),
    removed: v.pipe(v.array(v.string()), v.readonly()),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("AssigneeChange"),
    added: v.pipe(v.array(v.string()), v.readonly()),
    removed: v.pipe(v.array(v.string()), v.readonly()),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("ReviewerChange"),
    requested: v.pipe(v.array(v.string()), v.readonly()),
    removed: v.pipe(v.array(v.string()), v.readonly()),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("DraftStateChange"),
    draft: v.boolean(),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("BaseBranchChange"),
    branch: v.string(),
    writtenAt: v.string(),
  }),
]);
const journalSchema = v.strictObject({
  schemaVersion: v.literal(1),
  entries: v.array(entrySchema),
});

/** Typed from the schema so a write fails to compile when `entrySchema` lacks a receipt tag. */
type PersistedRecentWriteJournal = v.InferOutput<typeof journalSchema>;

/** What a write flow needs from the journal: record a write GitHub already confirmed. */
export type ConfirmedWriteJournal = Pick<
  RecentWriteJournalStore,
  "appendConfirmed"
>;

/**
 * Durable per-review record of this app session's own confirmed GitHub
 * writes, appended at the main-process write-confirmation boundary and read
 * back at detect time so a renderer reload's empty in-memory journal cannot
 * make the maintainer's own just-made write read as absent. Sibling of, and
 * deliberately distinct from, `ReviewObservationJournalStore`'s crash-safe
 * transition journal.
 */
export class RecentWriteJournalStore {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly log: { readonly write: (input: LogEntryInput) => void },
  ) {}

  /**
   * Journals a write GitHub already confirmed. A failure is logged and
   * swallowed: the journal only suppresses a duplicate observation, and ADR
   * 0035 forbids a confirmed write from ending locked or retryable.
   */
  async appendConfirmed(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    entry: RecentReviewWrite,
    writtenAt: IsoTimestamp,
  ): Promise<void> {
    const appended = await this.append(profileId, reviewId, entry, writtenAt);
    if (appended._tag === "ok") return;
    this.log.write({
      process: "main",
      level: "warn",
      topic: "recent-write-journal",
      message: "journal append failed; write already confirmed, continuing",
      profileId,
      meta: { reason: appended.error.reason, reviewId },
    });
  }

  /** Read-modify-write append; callers must already hold the review write lock. */
  async append(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    entry: RecentReviewWrite,
    writtenAt: IsoTimestamp,
  ): Promise<Result<void, StorageFailure>> {
    const existing = await this.readEntries(profileId, reviewId);
    if (existing._tag === "err") return existing;
    const referenceMs = Date.parse(writtenAt);
    const kept = existing.value.filter((stored) =>
      withinCeiling(stored.writtenAt, referenceMs),
    );
    const next: PersistedRecentWriteJournal = {
      schemaVersion: 1,
      entries: appendRecentWriteReceipts(kept, [{ ...entry, writtenAt }]),
    };
    return writeAtomicJson(
      this.paths.recentWriteJournalFile(profileId, reviewId),
      next,
    );
  }

  /** Absent file is an empty journal, not an error; age-ceiling-filtered. */
  async load(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<ReadonlyArray<RecentReviewWrite>, StorageFailure>> {
    const existing = await this.readEntries(profileId, reviewId);
    if (existing._tag === "err") return existing;
    const nowMs = Date.now();
    const kept: Array<RecentReviewWrite> = [];
    for (const entry of existing.value) {
      if (withinCeiling(entry.writtenAt, nowMs))
        kept.push(stripWrittenAt(entry));
    }
    return ok(kept);
  }

  /** Drop every entry the predicate confirms is now represented remotely. */
  async prune(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    satisfied: (entry: RecentReviewWrite) => boolean,
  ): Promise<Result<void, StorageFailure>> {
    const existing = await this.readEntries(profileId, reviewId);
    if (existing._tag === "err") return existing;
    const remaining = existing.value.filter(
      (entry) => !satisfied(stripWrittenAt(entry)),
    );
    if (remaining.length === existing.value.length) return ok(undefined);
    if (remaining.length === 0) return this.clear(profileId, reviewId);
    const next: PersistedRecentWriteJournal = {
      schemaVersion: 1,
      entries: remaining,
    };
    return writeAtomicJson(
      this.paths.recentWriteJournalFile(profileId, reviewId),
      next,
    );
  }

  async clear(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<void, StorageFailure>> {
    try {
      await rm(this.paths.recentWriteJournalFile(profileId, reviewId));
      return ok(undefined);
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok(undefined);
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
  }

  private async readEntries(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<ReadonlyArray<DurableRecentReviewWrite>, StorageFailure>> {
    const read = await this.parseEntries(profileId, reviewId);
    if (read._tag === "ok") return read;
    if (read.error.reason === "not_found") return ok([]);
    if (
      read.error.reason !== "invalid_json" &&
      read.error.reason !== "invalid_stored_value"
    )
      return read;
    return this.quarantine(profileId, reviewId, read.error.reason);
  }

  private async parseEntries(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<ReadonlyArray<DurableRecentReviewWrite>, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.recentWriteJournalFile(profileId, reviewId),
    );
    if (stored._tag === "err") return stored;
    // Schema-validate at this exact I/O boundary; every downstream helper
    // works from the resulting named, non-`unknown` variant type.
    const parsed = v.safeParse(journalSchema, stored.value);
    if (!parsed.success) return invalidRead();
    return parseRecentWriteEntries(parsed.output.entries);
  }

  /**
   * ADR 0019: an invalid journal is moved aside and restarts empty, since
   * nothing can rebuild it and losing it costs one redundant refresh.
   */
  private async quarantine(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    reason: "invalid_json" | "invalid_stored_value",
  ): Promise<Result<ReadonlyArray<DurableRecentReviewWrite>, StorageFailure>> {
    try {
      await rename(
        this.paths.recentWriteJournalFile(profileId, reviewId),
        this.paths.recentWriteJournalQuarantineFile(profileId, reviewId),
      );
    } catch {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    this.log.write({
      process: "main",
      level: "warn",
      topic: "recent-write-journal",
      message: "journal unreadable; moved aside and restarted empty",
      profileId,
      meta: { reason, reviewId },
    });
    return ok([]);
  }
}

type RawJournalEntry = v.InferOutput<typeof entrySchema>;

/** Decode already schema-validated entries, failing closed on any malformed one. */
function parseRecentWriteEntries(
  raw: ReadonlyArray<RawJournalEntry>,
): Result<ReadonlyArray<DurableRecentReviewWrite>, StorageFailure> {
  const entries: Array<DurableRecentReviewWrite> = [];
  for (const entry of raw) {
    const decoded = parseRecentWriteEntry(entry);
    if (decoded._tag === "err") return decoded;
    entries.push(decoded.value);
  }
  return ok(entries);
}

function parseRecentWriteEntry(
  entry: RawJournalEntry,
): Result<DurableRecentReviewWrite, StorageFailure> {
  const { writtenAt, ...record } = entry;
  const parsedWrittenAt = parseIsoTimestamp(writtenAt);
  const write = parseRecentReviewWrite(record);
  if (parsedWrittenAt._tag === "err" || write._tag === "err")
    return invalidRead();
  return ok({ ...write.value, writtenAt: parsedWrittenAt.value });
}

function stripWrittenAt(entry: DurableRecentReviewWrite): RecentReviewWrite {
  const { writtenAt: _writtenAt, ...rest } = entry;
  return rest;
}

function withinCeiling(writtenAt: IsoTimestamp, referenceMs: number): boolean {
  return (
    referenceMs - Date.parse(writtenAt) <= RECENT_WRITE_JOURNAL_AGE_CEILING_MS
  );
}

function invalidRead(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}
