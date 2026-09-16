import { rm } from "node:fs/promises";

import * as v from "valibot";

import {
  parseGitHubThreadId,
  parseIsoTimestamp,
  type IsoTimestamp,
  type ReviewId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import { err, ok, type Result } from "../../domain/result";
import type { RecentReviewWrite } from "../../domain/recent-review-write";
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

type PersistedRecentWriteJournal = {
  readonly schemaVersion: 1;
  readonly entries: ReadonlyArray<DurableRecentReviewWrite>;
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
    _tag: v.literal("DirectSummaryReview"),
    reviewId: v.string(),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("LabelChange"),
    added: v.array(v.string()),
    removed: v.array(v.string()),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("AssigneeChange"),
    added: v.array(v.string()),
    removed: v.array(v.string()),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("ReviewerChange"),
    requested: v.array(v.string()),
    removed: v.array(v.string()),
    writtenAt: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("DraftStateChange"),
    draft: v.boolean(),
    writtenAt: v.string(),
  }),
]);
const journalSchema = v.strictObject({
  schemaVersion: v.literal(1),
  entries: v.array(entrySchema),
});

/**
 * Durable per-review record of this app session's own confirmed GitHub
 * writes, appended at the main-process write-confirmation boundary and read
 * back at detect time so a renderer reload's empty in-memory journal cannot
 * make the maintainer's own just-made write read as absent. Sibling of, and
 * deliberately distinct from, `ReviewObservationJournalStore`'s crash-safe
 * transition journal.
 */
export class RecentWriteJournalStore {
  constructor(private readonly paths: PatchdeskPaths) {}

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
      entries: [...kept, { ...entry, writtenAt }],
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
    const stored = await readJsonFile(
      this.paths.recentWriteJournalFile(profileId, reviewId),
    );
    if (stored._tag === "err") {
      return stored.error.reason === "not_found" ? ok([]) : stored;
    }
    // Schema-validate at this exact I/O boundary; every downstream helper
    // works from the resulting named, non-`unknown` variant type.
    const parsed = v.safeParse(journalSchema, stored.value);
    if (!parsed.success) return invalidRead();
    return parseRecentWriteEntries(parsed.output.entries);
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

/**
 * The declared return type makes TypeScript reject a schema member without a
 * branch, so an entry tag added later cannot be silently read as another one.
 */
function parseRecentWriteEntry(
  entry: RawJournalEntry,
): Result<DurableRecentReviewWrite, StorageFailure> {
  const parsedWrittenAt = parseIsoTimestamp(entry.writtenAt);
  if (parsedWrittenAt._tag === "err") return invalidRead();
  const writtenAt = parsedWrittenAt.value;
  switch (entry._tag) {
    case "Comment":
      return ok(
        entry.reviewId === undefined
          ? { _tag: "Comment", commentId: entry.commentId, writtenAt }
          : {
              _tag: "Comment",
              commentId: entry.commentId,
              reviewId: entry.reviewId,
              writtenAt,
            },
      );
    case "ThreadState": {
      const threadId = parseGitHubThreadId(entry.threadId);
      return threadId._tag === "err"
        ? invalidRead()
        : ok({
            _tag: "ThreadState",
            threadId: threadId.value,
            state: entry.state,
            writtenAt,
          });
    }
    case "PendingThread": {
      const threadId = parseGitHubThreadId(entry.threadId);
      return threadId._tag === "err"
        ? invalidRead()
        : ok({
            _tag: "PendingThread",
            threadId: threadId.value,
            writtenAt,
          });
    }
    case "DirectSummaryReview":
      return ok({
        _tag: "DirectSummaryReview",
        reviewId: entry.reviewId,
        writtenAt,
      });
    case "LabelChange":
      return ok({
        _tag: "LabelChange",
        added: entry.added,
        removed: entry.removed,
        writtenAt,
      });
    case "AssigneeChange":
      return ok({
        _tag: "AssigneeChange",
        added: entry.added,
        removed: entry.removed,
        writtenAt,
      });
    case "ReviewerChange":
      return ok({
        _tag: "ReviewerChange",
        requested: entry.requested,
        removed: entry.removed,
        writtenAt,
      });
    case "DraftStateChange":
      return ok({ _tag: "DraftStateChange", draft: entry.draft, writtenAt });
  }
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
