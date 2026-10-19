import { lstat } from "node:fs/promises";

import type { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { InsightRunJournalReader } from "#src/adapters/storage/insight-run-journal-reader";
import { InsightSlotStore } from "#src/adapters/storage/insight-slot-store";
import { isNotFound } from "#src/adapters/storage/json-file";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { definedProps } from "#src/domain/defined-props";
import type { ReviewSessionId } from "#src/domain/ids";
import type { InsightArtifactReference } from "#src/domain/insight-artifact-scalars";
import {
  INSIGHT_FAILURE_CATEGORIES,
  type InsightFailure,
  type InsightFailureCategory,
} from "#src/domain/insight-record";
import {
  insightBindingCodec,
  insightDomainIdentityCodec,
  insightFailureRecordCodec,
  insightLegacyFailureCodec,
} from "#src/domain/insight-run-binding-contract";
import { ok, type Result } from "#src/domain/result";
import {
  failed,
  journalKey,
  legacyFailureFor,
  type InsightRunRef,
  type InsightSlotFailure,
  type InsightSlotKey,
} from "./insight-slot-records";

/** A current run's state in the vocabulary the run-status response already uses. */
export type InsightRunObservation = {
  readonly status:
    | "queued"
    | "running"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled";
  readonly failureReason?: InsightFailure["reason"];
  readonly failureCategory?: InsightFailureCategory;
};

/**
 * Lock-free reads of current-format slots and run journals. Pointers and the objects they name are replaced
 * atomically, so a read sees one consistent state. Every read goes through the artifact worker, which refuses more
 * than four pending reads: callers check `hasSlot` first and read slots one at a time.
 */
export class InsightSlotStatus {
  private readonly slots: InsightSlotStore;
  private readonly artifacts: InsightArtifactStore;
  private readonly journals: InsightRunJournalReader;

  constructor(
    private readonly paths: PatchdeskPaths,
    insightArtifactReader: typeof readBoundedInsightArtifactFile,
  ) {
    this.slots = new InsightSlotStore(paths, insightArtifactReader);
    this.artifacts = new InsightArtifactStore(paths, insightArtifactReader);
    this.journals = new InsightRunJournalReader(
      paths,
      this.artifacts,
      insightArtifactReader,
    );
  }

  /** Whether a slot pointer exists; the lstat reads no body, so a sweep can run it for every Review at once. */
  async hasSlot(
    input: InsightSlotKey,
  ): Promise<Result<boolean, InsightSlotFailure>> {
    try {
      await lstat(
        this.paths.insightSlotPointerFile(
          input.profileId,
          input.reviewId,
          input.type,
        ),
      );
      return ok(true);
    } catch (cause: unknown) {
      return isNotFound(cause) ? ok(false) : failed();
    }
  }

  /** The run the slot names as active, if any. */
  async activeRun(
    key: InsightSlotKey,
  ): Promise<Result<InsightRunRef | undefined, InsightSlotFailure>> {
    const current = await this.slots.readCurrent(
      key.profileId,
      key.reviewId,
      key.type,
    );
    if (current._tag === "err") return failed();
    const active = current.value?.record.activeRun ?? null;
    if (active === null) return ok(undefined);
    // A migrated legacy run has no journal to answer from, so it cannot be reported or cancelled here.
    if (active.tag !== "current") return failed();
    return ok({
      profileId: key.profileId,
      reviewId: key.reviewId,
      type: key.type,
      runId: active.runId,
      journalId: active.journalId,
    });
  }

  /** The slot's active run when its bound session is `sessionId`. */
  async activeRunOn(
    input: InsightSlotKey & { readonly sessionId: ReviewSessionId },
  ): Promise<Result<InsightRunRef | undefined, InsightSlotFailure>> {
    const run = await this.activeRun(input);
    if (run._tag === "err" || run.value === undefined) return run;
    const { profileId, reviewId } = input;
    const snapshot = await this.journals.read(journalKey(run.value));
    if (snapshot._tag === "err") return failed();
    const binding = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightBindingCodec,
      snapshot.value.state.binding,
    );
    if (binding._tag === "err") return failed();
    const identity = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightDomainIdentityCodec,
      binding.value.identity,
    );
    if (identity._tag === "err") return failed();
    const same = await this.artifacts.textRootEquals(
      profileId,
      reviewId,
      identity.value.sessionId,
      input.sessionId,
    );
    if (same._tag === "err") return failed();
    return ok(same.value ? run.value : undefined);
  }

  /**
   * The state of one run, or undefined when the slot knows no such run. The active run answers from its journal; the
   * run that last settled answers from the slot's replacement failure. A completed run is not answered yet: no
   * current-format publication exists.
   */
  async observeRun(
    input: InsightSlotKey & { readonly runId: string },
  ): Promise<Result<InsightRunObservation | undefined, InsightSlotFailure>> {
    const current = await this.slots.readCurrent(
      input.profileId,
      input.reviewId,
      input.type,
    );
    if (current._tag === "err") return failed();
    if (current.value === undefined) return ok(undefined);
    const { activeRun, replacementFailure, nextToken } = current.value.record;
    if (activeRun?.tag === "current" && activeRun.runId === input.runId)
      return this.observeJournal({
        ...input,
        runId: activeRun.runId,
        journalId: activeRun.journalId,
      });
    // The failure belongs to the last admitted run, so a run ID with another token skips the text comparison.
    if (replacementFailure !== null && runToken(input.runId) === nextToken - 1)
      return this.observeReplacement(input, replacementFailure);
    return ok(undefined);
  }

  private async observeJournal(
    run: InsightRunRef,
  ): Promise<Result<InsightRunObservation, InsightSlotFailure>> {
    const snapshot = await this.journals.read(journalKey(run));
    if (snapshot._tag === "err") return failed();
    const { status, failure } = snapshot.value.state;
    switch (status) {
      case "queued":
      case "preparing":
        return ok({ status: "queued" });
      case "running":
      case "waiting":
        return ok({ status: "running" });
      case "cancelling":
        return ok({ status: "cancelling" });
      case "complete":
        return ok({ status: "completed" });
      case "paused":
      case "failed":
      case "cancelled":
      case "superseded": {
        if (failure === null) return failed();
        const record = await this.artifacts.readObject(
          run.profileId,
          run.reviewId,
          insightFailureRecordCodec,
          failure,
        );
        if (record._tag === "err") return failed();
        const mapped = legacyFailureFor(record.value.code);
        return ok({
          status: mapped.reason === "cancelled" ? "cancelled" : "failed",
          failureReason: mapped.reason,
          ...definedProps({ failureCategory: mapped.category }),
        });
      }
    }
  }

  private async observeReplacement(
    input: InsightSlotKey & { readonly runId: string },
    reference: InsightArtifactReference,
  ): Promise<Result<InsightRunObservation | undefined, InsightSlotFailure>> {
    const { profileId, reviewId } = input;
    const failure = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightLegacyFailureCodec,
      reference,
    );
    if (failure._tag === "err") return failed();
    const sameRun = await this.artifacts.verifyTextRootEquals(
      profileId,
      reviewId,
      failure.value.runId,
      input.runId,
    );
    if (sameRun._tag === "err") return failed();
    const { reason, category } = failure.value;
    let failureCategory: InsightFailureCategory | undefined;
    if (category !== undefined) {
      for (const candidate of INSIGHT_FAILURE_CATEGORIES) {
        // The descriptor's length only narrows the candidates; a category no candidate verifies as equal is corrupt.
        if (category.data.bytes !== Buffer.byteLength(candidate, "utf8"))
          continue;
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- the reads go through the artifact worker, which refuses more than four pending reads
        const match = await this.artifacts.textRootEquals(
          profileId,
          reviewId,
          category,
          candidate,
        );
        if (match._tag === "err") return failed();
        if (match.value) {
          failureCategory = candidate;
          break;
        }
      }
      if (failureCategory === undefined) return failed();
    }
    return ok({
      status: reason === "cancelled" ? "cancelled" : "failed",
      failureReason: reason,
      ...definedProps({ failureCategory }),
    });
  }
}

/** The token segment of `insight-<type>-<token>-...`; undefined for an ID that does not carry one. */
function runToken(runId: string): number | undefined {
  const token = /^insight-[a-z]+-([1-9]\d*)-/.exec(runId)?.[1];
  return token === undefined ? undefined : Number(token);
}
