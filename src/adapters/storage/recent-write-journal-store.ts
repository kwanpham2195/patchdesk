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
    const writtenAt = parseIsoTimestamp(entry.writtenAt);
    if (writtenAt._tag === "err") return invalidRead();
    if (entry._tag === "Comment") {
      entries.push(
        entry.reviewId === undefined
          ? {
              _tag: "Comment",
              commentId: entry.commentId,
              writtenAt: writtenAt.value,
            }
          : {
              _tag: "Comment",
              commentId: entry.commentId,
              reviewId: entry.reviewId,
              writtenAt: writtenAt.value,
            },
      );
    } else if (entry._tag === "ThreadState") {
      const threadId = parseGitHubThreadId(entry.threadId);
      if (threadId._tag === "err") return invalidRead();
      entries.push({
        _tag: "ThreadState",
        threadId: threadId.value,
        state: entry.state,
        writtenAt: writtenAt.value,
      });
    } else if (entry._tag === "PendingThread") {
      const threadId = parseGitHubThreadId(entry.threadId);
      if (threadId._tag === "err") return invalidRead();
      entries.push({
        _tag: "PendingThread",
        threadId: threadId.value,
        writtenAt: writtenAt.value,
      });
    } else if (entry._tag === "DirectSummaryReview") {
      entries.push({
        _tag: "DirectSummaryReview",
        reviewId: entry.reviewId,
        writtenAt: writtenAt.value,
      });
    } else if (entry._tag === "LabelChange") {
      entries.push({
        _tag: "LabelChange",
        added: entry.added,
        removed: entry.removed,
        writtenAt: writtenAt.value,
      });
    } else if (entry._tag === "AssigneeChange") {
      // Pre-existing bug fixed here: this branch previously fell into the
      // final `else` below and was stamped `_tag: "LabelChange"` on read,
      // silently reclassifying every persisted assignee-change entry. Since
      // consumers key off `entry._tag === "AssigneeChange"`, a reloaded
      // assignee write would never be recognized as one, and would instead
      // have been read back as (and stripped like) a label change with the
      // wrong names.
      entries.push({
        _tag: "AssigneeChange",
        added: entry.added,
        removed: entry.removed,
        writtenAt: writtenAt.value,
      });
    } else {
      entries.push({
        _tag: "ReviewerChange",
        requested: entry.requested,
        removed: entry.removed,
        writtenAt: writtenAt.value,
      });
    }
  }
  return ok(entries);
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
