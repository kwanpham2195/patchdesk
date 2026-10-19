import { randomUUID } from "node:crypto";

import type {
  InsightArtifactIndexDescriptor,
  InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import { insightUsageRootCodec } from "#src/domain/insight-run-binding-contract";
import {
  encodeInsightJournalPointer,
  encodeInsightPendingIntentLocator,
  insightJournalHeadCodec,
  insightJournalStateCodec,
  insightLocalIntentCodec,
  insightObjectDigestCodec,
  insightTransactionEntryCodec,
  type InsightJournalHead,
  type InsightJournalPointer,
  type InsightJournalState,
} from "#src/domain/insight-run-journal-contract";
import { err, ok, type Result } from "#src/domain/result";
import type { readBoundedInsightArtifactFile } from "./insight-artifact-files";
import {
  commitInsightPointerFile,
  replaceInsightPointerFile,
} from "./insight-artifact-pointer-files";
import { InsightArtifactStore } from "./insight-artifact-store";
import {
  appendInsightIndexEntry,
  writeEmptyInsightIndex,
} from "./insight-index-append";
import {
  InsightRunJournalReader,
  type InsightJournalKey,
  type InsightJournalSnapshot,
  type InsightPendingIntent,
} from "./insight-run-journal-reader";
import type { StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/**
 * committed: the pointer replacement is durable. conflict: the pointer no longer held the expected bytes and nothing
 * changed. not_committed: an uncertain replacement was reconciled as absent. unknown: reconciliation itself failed, so
 * the transaction may have committed; the caller must reread under the same lock before acting.
 */
type InsightJournalCommit =
  | { readonly _tag: "committed"; readonly snapshot: InsightJournalSnapshot }
  | { readonly _tag: "conflict" | "not_committed" | "unknown" };

type Staged = {
  readonly schema: string;
  readonly root: InsightArtifactReference;
};

/**
 * Run-journal storage. Every method that writes assumes the caller holds the per-journal lock; the store owns no locks,
 * so the compare inside the pointer replacement is atomic only under that lock.
 */
export class InsightRunJournalStore {
  private readonly artifacts: InsightArtifactStore;
  private readonly reader: InsightRunJournalReader;

  constructor(
    private readonly paths: PatchdeskPaths,
    insightArtifactReader: typeof readBoundedInsightArtifactFile,
  ) {
    this.artifacts = new InsightArtifactStore(paths, insightArtifactReader);
    this.reader = new InsightRunJournalReader(
      paths,
      this.artifacts,
      insightArtifactReader,
    );
  }

  /** An absent pointer is `not_found`; a corrupt or missing pointer, head, state or intent is a storage failure, never an empty run. */
  read(
    journal: InsightJournalKey,
  ): Promise<Result<InsightJournalSnapshot, StorageFailure>> {
    return this.reader.read(journal);
  }

  /** Read-only restart detection for the pending-intent locator; it never clears or replays the intent. */
  pendingIntent(
    journal: InsightJournalKey,
  ): Promise<Result<InsightPendingIntent, StorageFailure>> {
    return this.reader.pendingIntent(journal);
  }

  /**
   * Creates the journal as its first transaction: queued, generation 1, cancelEpoch 0, no CandidateRoot, empty usage,
   * dispatches and receipts. `binding`, `authorization` and `policy` are objects the caller already staged; `staged` lists every object it wrote for admission.
   */
  async create(
    journal: InsightJournalKey,
    input: {
      readonly binding: InsightArtifactReference;
      readonly authorization: InsightArtifactReference;
      readonly policy: InsightArtifactReference;
      readonly staged: ReadonlyArray<Staged>;
      readonly createdAt: string;
    },
  ): Promise<Result<InsightJournalCommit, StorageFailure>> {
    const { profileId, reviewId } = journal;
    const [dispatches, receipts, usageEntries, transactions] =
      await Promise.all([
        writeEmptyInsightIndex(this.reader.scope(journal, "DispatchRecord")),
        writeEmptyInsightIndex(this.reader.scope(journal, "Receipt")),
        writeEmptyInsightIndex(this.reader.scope(journal, "UsageEntry")),
        writeEmptyInsightIndex(this.reader.scope(journal, "TransactionEntry")),
      ]);
    if (dispatches._tag === "err") return dispatches;
    if (receipts._tag === "err") return receipts;
    if (usageEntries._tag === "err") return usageEntries;
    if (transactions._tag === "err") return transactions;
    const usage = await this.artifacts.writeObject(
      profileId,
      reviewId,
      insightUsageRootCodec,
      {
        entries: usageEntries.value,
        knownInputTokens: 0,
        knownOutputTokens: 0,
        knownCacheReadTokens: 0,
        knownCacheWriteTokens: 0,
        knownMicroUsd: 0,
        hasUnknownUsage: false,
      },
    );
    if (usage._tag === "err") return usage;
    return this.commit(
      journal,
      null,
      {
        binding: input.binding,
        generation: 1,
        candidate: null,
        draft: null,
        checkpoint: null,
        checkpointVersion: 0,
        authorization: input.authorization,
        policy: input.policy,
        dispatches: dispatches.value,
        usage: usage.value,
        seal: null,
        status: "queued",
        cancelEpoch: 0,
        failure: null,
        publication: null,
      },
      {
        receipts: receipts.value,
        transactions: transactions.value,
        createdAt: input.createdAt,
        staged: [
          ...input.staged,
          { schema: "UsageRoot", root: usage.value },
          { schema: "Index<UsageEntry>", root: usageEntries.value.root },
          { schema: "Index<DispatchRecord>", root: dispatches.value.root },
          { schema: "Index<Receipt>", root: receipts.value.root },
        ],
      },
    );
  }

  /** Applies one internal transaction (null operation and receipt) that moves `prior` to `nextState`; `staged` lists objects the caller wrote for it. */
  async applyInternalTransaction(
    journal: InsightJournalKey,
    prior: InsightJournalSnapshot,
    nextState: InsightJournalState,
    input: {
      readonly createdAt: string;
      readonly staged: ReadonlyArray<Staged>;
    },
  ): Promise<Result<InsightJournalCommit, StorageFailure>> {
    return this.commit(journal, prior, nextState, {
      receipts: prior.head.receipts,
      transactions: prior.head.transactions,
      createdAt: input.createdAt,
      staged: input.staged,
    });
  }

  // r2 section 7 build order: receipts, state, intent, transaction entry, head, then locator and pointer.
  private async commit(
    journal: InsightJournalKey,
    prior: InsightJournalSnapshot | null,
    nextState: InsightJournalState,
    input: {
      readonly receipts: InsightArtifactIndexDescriptor;
      readonly transactions: InsightArtifactIndexDescriptor;
      readonly createdAt: string;
      readonly staged: ReadonlyArray<Staged>;
    },
  ): Promise<Result<InsightJournalCommit, StorageFailure>> {
    const { profileId, reviewId } = journal;
    const pending = await this.reader.pendingIntent(journal);
    if (pending._tag === "err") return pending;
    // A conflicting intent stays for reconciliation.
    if (pending.value._tag === "conflict")
      return writeFailure("invalid_stored_value");
    // A stale prior must not replace the locator of an intent that may still be pending.
    const current = await this.reader.readPointerBytes(journal);
    if (current._tag === "err") return current;
    if (
      prior === null
        ? current.value !== null
        : current.value === null ||
          !Buffer.from(current.value).equals(prior.pointerBytes)
    )
      return ok({ _tag: "conflict" });
    const sequence = (prior?.pointer.sequence ?? 0) + 1;
    const state = await this.artifacts.writeObject(
      profileId,
      reviewId,
      insightJournalStateCodec,
      nextState,
    );
    if (state._tag === "err") return state;
    const objects = await this.writeObjectDigests(journal, input.staged);
    if (objects._tag === "err") return objects;
    const intent = await this.artifacts.writeObject(
      profileId,
      reviewId,
      insightLocalIntentCodec,
      {
        transactionId: randomUUID(),
        runId: journal.runId,
        expectedSequence: sequence - 1,
        expectedHead: prior?.pointer.head ?? null,
        operation: null,
        receipt: null,
        nextState: state.value,
        nextReceipts: input.receipts,
        objects: objects.value,
        createdAt: input.createdAt,
      },
    );
    if (intent._tag === "err") return intent;
    const entry = await this.artifacts.writeObject(
      profileId,
      reviewId,
      insightTransactionEntryCodec,
      { sequence, intent: intent.value },
    );
    if (entry._tag === "err") return entry;
    const transactions = await appendInsightIndexEntry(
      this.reader.scope(journal, "TransactionEntry"),
      input.transactions,
      sequence,
      entry.value,
    );
    if (transactions._tag === "err") return transactions;
    const head: InsightJournalHead = {
      runId: journal.runId,
      sequence,
      previous: prior?.pointer.head ?? null,
      transaction: intent.value,
      state: state.value,
      receipts: input.receipts,
      transactions: transactions.value,
    };
    const headReference = await this.artifacts.writeObject(
      profileId,
      reviewId,
      insightJournalHeadCodec,
      head,
    );
    if (headReference._tag === "err") return headReference;
    // An uncommitted intent left by an earlier attempt was never exposed, so replacing its locator loses nothing.
    const located = await this.writeLocator(journal, intent.value);
    if (located._tag === "err") return located;
    const pointer: InsightJournalPointer = {
      format: 2,
      runId: journal.runId,
      sequence,
      head: headReference.value,
    };
    return this.replacePointer(journal, prior, {
      pointer,
      head,
      state: nextState,
    });
  }

  private async replacePointer(
    journal: InsightJournalKey,
    prior: InsightJournalSnapshot | null,
    next: Omit<InsightJournalSnapshot, "pointerBytes">,
  ): Promise<Result<InsightJournalCommit, StorageFailure>> {
    const path = this.paths.insightJournalPointerFile(
      journal.profileId,
      journal.reviewId,
      journal.journalId,
    );
    const bytes = encodeInsightJournalPointer(next.pointer);
    if (path._tag === "err" || bytes._tag === "err")
      return writeFailure("invalid_stored_value");
    const committed = await commitInsightPointerFile(
      this.paths.dataDirectory(),
      path.value,
      prior?.pointerBytes ?? null,
      bytes.value,
    );
    if (committed._tag === "err") return committed;
    return committed.value._tag === "committed"
      ? ok({
          _tag: "committed",
          snapshot: { ...next, pointerBytes: bytes.value },
        })
      : ok({ _tag: committed.value._tag });
  }

  private async writeObjectDigests(
    journal: InsightJournalKey,
    staged: ReadonlyArray<Staged>,
  ): Promise<Result<InsightArtifactIndexDescriptor, StorageFailure>> {
    const scope = this.reader.scope(journal, "ObjectDigest");
    let objects = await writeEmptyInsightIndex(scope);
    for (const [ordinal, digest] of staged.entries()) {
      if (objects._tag === "err") return objects;
      const written = await this.artifacts.writeObject(
        journal.profileId,
        journal.reviewId,
        insightObjectDigestCodec,
        digest,
      );
      if (written._tag === "err") return written;
      objects = await appendInsightIndexEntry(
        scope,
        objects.value,
        ordinal,
        written.value,
      );
    }
    return objects;
  }

  private async writeLocator(
    journal: InsightJournalKey,
    intent: InsightArtifactReference,
  ): Promise<Result<void, StorageFailure>> {
    const path = this.paths.insightJournalIntentFile(
      journal.profileId,
      journal.reviewId,
      journal.journalId,
    );
    const bytes = encodeInsightPendingIntentLocator({
      format: 2,
      runId: journal.runId,
      intent,
    });
    const existing = await this.reader.readLocator(journal);
    if (path._tag === "err" || bytes._tag === "err")
      return writeFailure("invalid_stored_value");
    if (existing._tag === "err") return existing;
    const replaced = await replaceInsightPointerFile(
      this.paths.dataDirectory(),
      path.value,
      existing.value,
      bytes.value,
    );
    if (replaced._tag === "err") return replaced;
    // The locator is not authoritative, so an uncertain write only stops this transaction before the pointer moves.
    return replaced.value._tag === "committed"
      ? ok(undefined)
      : writeFailure(
          replaced.value._tag === "conflict" ? "invalid_stored_value" : "io",
        );
  }
}

function writeFailure(
  reason: StorageFailure["reason"],
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "write", reason });
}
