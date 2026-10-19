import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import type {
  InsightArtifactReference,
  InsightArtifactRunId,
} from "#src/domain/insight-artifact-scalars";
import {
  insightJournalHeadCodec,
  insightJournalStateCodec,
  insightLocalIntentCodec,
  insightTransactionEntryCodec,
  parseInsightJournalPointer,
  parseInsightPendingIntentLocator,
  type InsightJournalHead,
  type InsightJournalPointer,
  type InsightJournalState,
  type InsightLocalIntent,
} from "#src/domain/insight-run-journal-contract";
import { err, ok, type Result } from "#src/domain/result";
import type { readBoundedInsightArtifactFile } from "./insight-artifact-files";
import type { InsightArtifactStore } from "./insight-artifact-store";
import {
  findInsightIndexEntry,
  type InsightIndexScope,
} from "./insight-index-append";
import type { StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** One verified view of a journal: pointer, head and state, without the chain behind the head. */
export type InsightJournalSnapshot = {
  readonly pointer: InsightJournalPointer;
  readonly pointerBytes: Uint8Array;
  readonly head: InsightJournalHead;
  readonly state: InsightJournalState;
};

/**
 * committed: the head's transaction index names the intent. uncommitted: the pointer still holds the intent's expected
 * prior, so the intent was never exposed. conflict: the journal moved on without it; keep it for reconciliation.
 */
export type InsightPendingIntent =
  | { readonly _tag: "none" | "uncommitted" | "conflict" }
  | { readonly _tag: "committed"; readonly intent: InsightLocalIntent };

/** Names one journal under its Review; `runId` is the run the pointer must belong to. */
export type InsightJournalKey = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly journalId: string;
  readonly runId: InsightArtifactRunId;
};

/** Verified, read-only access to a run journal. */
export class InsightRunJournalReader {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly artifacts: InsightArtifactStore,
    private readonly insightArtifactReader: typeof readBoundedInsightArtifactFile,
  ) {}

  /** An absent pointer is `not_found`; a corrupt pointer, head, state or intent, or a referenced object that is missing, is a storage failure. */
  async read(
    journal: InsightJournalKey,
  ): Promise<Result<InsightJournalSnapshot, StorageFailure>> {
    const path = this.paths.insightJournalPointerFile(
      journal.profileId,
      journal.reviewId,
      journal.journalId,
    );
    if (path._tag === "err") return readFailure("invalid_stored_value");
    const pointerBytes = await this.insightArtifactReader(
      this.paths.dataDirectory(),
      path.value,
    );
    if (pointerBytes._tag === "err") return pointerBytes;
    const pointer = parseInsightJournalPointer(pointerBytes.value);
    if (pointer._tag === "err" || pointer.value.runId !== journal.runId)
      return readFailure("invalid_stored_value");
    const { profileId, reviewId } = journal;
    const head = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightJournalHeadCodec,
      pointer.value.head,
    );
    if (head._tag === "err") return head;
    if (
      head.value.runId !== journal.runId ||
      head.value.sequence !== pointer.value.sequence
    )
      return readFailure("invalid_stored_value");
    const state = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightJournalStateCodec,
      head.value.state,
    );
    if (state._tag === "err") return state;
    if (head.value.transaction !== null) {
      const intent = await this.artifacts.readObject(
        profileId,
        reviewId,
        insightLocalIntentCodec,
        head.value.transaction,
      );
      if (intent._tag === "err") return intent;
      if (
        intent.value.runId !== journal.runId ||
        !sameReference(intent.value.nextState, head.value.state) ||
        intent.value.expectedSequence + 1 !== head.value.sequence ||
        !sameNullableReference(intent.value.expectedHead, head.value.previous)
      )
        return readFailure("invalid_stored_value");
    }
    return ok({
      pointer: pointer.value,
      pointerBytes: pointerBytes.value,
      head: head.value,
      state: state.value,
    });
  }

  /** Read-only restart detection for the pending-intent locator; it never clears or replays the intent. */
  async pendingIntent(
    journal: InsightJournalKey,
  ): Promise<Result<InsightPendingIntent, StorageFailure>> {
    const locator = await this.readLocator(journal);
    if (locator._tag === "err") return locator;
    if (locator.value === null) return ok({ _tag: "none" });
    const parsed = parseInsightPendingIntentLocator(locator.value);
    if (parsed._tag === "err" || parsed.value.runId !== journal.runId)
      return readFailure("invalid_stored_value");
    const intent = await this.artifacts.readObject(
      journal.profileId,
      journal.reviewId,
      insightLocalIntentCodec,
      parsed.value.intent,
    );
    if (intent._tag === "err") return intent;
    if (intent.value.runId !== journal.runId)
      return readFailure("invalid_stored_value");
    const current = await this.read(journal);
    if (current._tag === "err") {
      return current.error.reason === "not_found" &&
        intent.value.expectedSequence === 0
        ? ok({ _tag: "uncommitted" })
        : current;
    }
    const recorded = await findInsightIndexEntry(
      this.scope(journal, "TransactionEntry"),
      current.value.head.transactions,
      intent.value.expectedSequence + 1,
    );
    if (recorded._tag === "err") return recorded;
    if (recorded.value !== undefined) {
      const entry = await this.artifacts.readObject(
        journal.profileId,
        journal.reviewId,
        insightTransactionEntryCodec,
        recorded.value,
      );
      if (entry._tag === "err") return entry;
      return sameReference(entry.value.intent, parsed.value.intent)
        ? ok({ _tag: "committed", intent: intent.value })
        : ok({ _tag: "conflict" });
    }
    return current.value.pointer.sequence === intent.value.expectedSequence &&
      sameNullableReference(
        intent.value.expectedHead,
        current.value.pointer.head,
      )
      ? ok({ _tag: "uncommitted" })
      : ok({ _tag: "conflict" });
  }

  /** The raw pointer bytes, or null when the pointer is absent; any other failure is returned. */
  async readPointerBytes(
    journal: InsightJournalKey,
  ): Promise<Result<Uint8Array | null, StorageFailure>> {
    const path = this.paths.insightJournalPointerFile(
      journal.profileId,
      journal.reviewId,
      journal.journalId,
    );
    if (path._tag === "err") return readFailure("invalid_stored_value");
    const bytes = await this.insightArtifactReader(
      this.paths.dataDirectory(),
      path.value,
    );
    if (bytes._tag === "ok") return ok(bytes.value);
    return bytes.error.reason === "not_found" ? ok(null) : bytes;
  }

  async readLocator(
    journal: InsightJournalKey,
  ): Promise<Result<Uint8Array | null, StorageFailure>> {
    const path = this.paths.insightJournalIntentFile(
      journal.profileId,
      journal.reviewId,
      journal.journalId,
    );
    if (path._tag === "err") return readFailure("invalid_stored_value");
    const bytes = await this.insightArtifactReader(
      this.paths.dataDirectory(),
      path.value,
    );
    if (bytes._tag === "ok") return ok(bytes.value);
    return bytes.error.reason === "not_found" ? ok(null) : bytes;
  }

  scope(
    journal: InsightJournalKey,
    element: InsightIndexScope["element"],
  ): InsightIndexScope {
    return {
      artifacts: this.artifacts,
      profileId: journal.profileId,
      reviewId: journal.reviewId,
      element,
    };
  }
}

function sameReference(
  left: InsightArtifactReference,
  right: InsightArtifactReference,
): boolean {
  return left.hash === right.hash && left.bytes === right.bytes;
}

function sameNullableReference(
  left: InsightArtifactReference | null,
  right: InsightArtifactReference | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameReference(left, right);
}

function readFailure(
  reason: StorageFailure["reason"],
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "read", reason });
}
