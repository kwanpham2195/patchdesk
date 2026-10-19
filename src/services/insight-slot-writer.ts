import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { commitInsightPointerFile } from "#src/adapters/storage/insight-artifact-pointer-files";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type {
  InsightJournalKey,
  InsightJournalSnapshot,
} from "#src/adapters/storage/insight-run-journal-reader";
import type { InsightRunJournalStore } from "#src/adapters/storage/insight-run-journal-store";
import type { InsightSlotSnapshot } from "#src/adapters/storage/insight-slot-store";
import type { InsightStore } from "#src/adapters/storage/insight-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { definedProps } from "#src/domain/defined-props";
import type { IsoTimestamp } from "#src/domain/ids";
import {
  insightArtifactIdSchema,
  type InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import {
  insightAuthorizationCodec,
  insightFailureRecordCodec,
  insightLegacyFailureCodec,
  insightProvenanceCodec,
} from "#src/domain/insight-run-binding-contract";
import {
  encodeInsightSlotPointer,
  type InsightSlotRecord3,
} from "#src/domain/insight-slot-contract";
import { insightSlotIdentityCodec } from "#src/domain/insight-slot-identity-contract";
import { err, ok, type Result } from "#src/domain/result";
import {
  failed,
  isTerminalStatus,
  legacyFailureFor,
  type InsightJournalChange,
  type InsightRunRef,
  type InsightSlotFailure,
  type InsightSlotKey,
} from "./insight-slot-records";

/**
 * The lock-free write steps of the slot authority. Every method assumes the caller holds the locks the authority's
 * lock order names, and none retries: an uncertain pointer replacement is reconciled once and then reported.
 */
export class InsightSlotWriter {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly artifacts: InsightArtifactStore,
    private readonly journals: InsightRunJournalStore,
    private readonly legacy: Pick<InsightStore, "withLegacyLock">,
    private readonly now: () => IsoTimestamp,
  ) {}

  /** Commits one internal transaction on `snapshot`, staging a FailureRecord when the change carries one. */
  async commitChange(
    journal: InsightJournalKey,
    snapshot: InsightJournalSnapshot,
    change: InsightJournalChange,
  ): Promise<Result<InsightJournalSnapshot, InsightSlotFailure>> {
    const staged: Array<{
      readonly schema: string;
      readonly root: InsightArtifactReference;
    }> = [];
    let failure = snapshot.state.failure;
    const at = this.now();
    if (change.failure !== undefined) {
      const record = await this.artifacts.writeObject(
        journal.profileId,
        journal.reviewId,
        insightFailureRecordCodec,
        {
          ...change.failure,
          at,
          lastDurableSequence: snapshot.pointer.sequence,
        },
      );
      if (record._tag === "err") return failed();
      failure = record.value;
      staged.push({ schema: "FailureRecord", root: record.value });
    }
    const committed = await this.journals.applyInternalTransaction(
      journal,
      snapshot,
      {
        ...snapshot.state,
        status: change.status,
        cancelEpoch: change.cancelEpoch ?? snapshot.state.cancelEpoch,
        failure,
      },
      { createdAt: at, staged },
    );
    if (committed._tag === "err") return failed();
    if (committed.value._tag === "committed")
      return ok(committed.value.snapshot);
    return committed.value._tag === "unknown"
      ? err("outcome_unknown")
      : failed();
  }

  /** For a terminal journal: moves the slot's activeRun into replacementFailure, mapped to the legacy failure vocabulary. */
  async releaseRun(
    run: InsightRunRef,
    slot: InsightSlotSnapshot,
    snapshot: InsightJournalSnapshot,
  ): Promise<Result<void, InsightSlotFailure>> {
    const { profileId, reviewId } = run;
    if (!isTerminalStatus(snapshot.state.status)) return ok(undefined);
    if (snapshot.state.failure === null) return failed();
    const record = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightFailureRecordCodec,
      snapshot.state.failure,
    );
    if (record._tag === "err") return failed();
    const authorization = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightAuthorizationCodec,
      snapshot.state.authorization,
    );
    if (authorization._tag === "err") return failed();
    const selection = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightProvenanceCodec,
      authorization.value.selection,
    );
    if (selection._tag === "err") return failed();
    const runText = await this.artifacts.writeTextRoot(
      profileId,
      reviewId,
      run.runId,
    );
    if (runText._tag === "err") return failed();
    const mapped = legacyFailureFor(record.value.code);
    const category =
      mapped.category === undefined
        ? undefined
        : await this.artifacts.writeTextRoot(
            profileId,
            reviewId,
            mapped.category,
          );
    if (category?._tag === "err") return failed();
    const failure = await this.artifacts.writeObject(
      profileId,
      reviewId,
      insightLegacyFailureCodec,
      {
        runId: runText.value,
        reason: mapped.reason,
        ...definedProps({ category: category?.value }),
        provider: selection.value.provider,
        model: selection.value.model,
        reasoning: selection.value.reasoning,
        retryable: true,
        failedAt: record.value.at,
      },
    );
    if (failure._tag === "err") return failed();
    return this.replaceSlot(run, slot.pointerBytes, {
      ...slot.record,
      version: slot.record.version + 1,
      activeRun: null,
      replacementFailure: failure.value,
      updatedAt: this.now(),
    });
  }

  /** The first record of a slot with no pointer yet: version 0, token 1, nothing retained. */
  async newSlot(
    key: InsightSlotKey,
  ): Promise<Result<InsightSlotRecord3, InsightSlotFailure>> {
    const { profileId, reviewId } = key;
    const profile = await this.artifacts.writeTextRoot(
      profileId,
      reviewId,
      profileId,
    );
    if (profile._tag === "err") return failed();
    const review = await this.artifacts.writeTextRoot(
      profileId,
      reviewId,
      reviewId,
    );
    if (review._tag === "err") return failed();
    const identity = await this.artifacts.writeObject(
      profileId,
      reviewId,
      insightSlotIdentityCodec,
      { profileId: profile.value, reviewId: review.value, type: key.type },
    );
    if (identity._tag === "err") return failed();
    return ok({
      schemaVersion: 3,
      slotId: v.parse(insightArtifactIdSchema, randomUUID()),
      identity: identity.value,
      type: key.type,
      version: 0,
      nextToken: 1,
      retained: null,
      actions: null,
      activeRun: null,
      replacementFailure: null,
      migration: null,
      publication: null,
      updatedAt: this.now(),
    });
  }

  /** Publishes the pointer under the legacy store lock for this key so no legacy write lands after the fence. */
  async replaceSlot(
    key: InsightSlotKey,
    prior: Uint8Array | null,
    record: InsightSlotRecord3,
  ): Promise<Result<void, InsightSlotFailure>> {
    const { profileId, reviewId, type } = key;
    const reference = await this.artifacts.writeSlotRecord3(
      profileId,
      reviewId,
      record,
    );
    if (reference._tag === "err") return failed();
    const pointer = encodeInsightSlotPointer({
      format: 2,
      slotId: record.slotId,
      version: record.version,
      record: reference.value,
    });
    if (pointer._tag === "err") return failed();
    const committed = await this.legacy.withLegacyLock(
      profileId,
      reviewId,
      type,
      () =>
        commitInsightPointerFile(
          this.paths.dataDirectory(),
          this.paths.insightSlotPointerFile(profileId, reviewId, type),
          prior,
          pointer.value,
        ),
    );
    if (committed._tag === "err") return failed();
    if (committed.value._tag === "committed") return ok(undefined);
    return committed.value._tag === "unknown"
      ? err("outcome_unknown")
      : failed();
  }
}
