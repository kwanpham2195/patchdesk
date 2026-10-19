import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import * as v from "valibot";

import type { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type {
  InsightJournalKey,
  InsightJournalSnapshot,
} from "#src/adapters/storage/insight-run-journal-reader";
import { InsightRunJournalStore } from "#src/adapters/storage/insight-run-journal-store";
import {
  InsightSlotStore,
  type InsightSlotSnapshot,
} from "#src/adapters/storage/insight-slot-store";
import type { InsightStore } from "#src/adapters/storage/insight-store";
import { isNotFound } from "#src/adapters/storage/json-file";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type { IsoTimestamp } from "#src/domain/ids";
import {
  insightArtifactIdSchema,
  insightArtifactRunIdSchema,
  type InsightArtifactRunId,
} from "#src/domain/insight-artifact-scalars";
import type { InsightFailureRecord } from "#src/domain/insight-run-binding-contract";
import { KeyedMutex } from "#src/domain/keyed-mutex";
import { err, ok, type Result } from "#src/domain/result";
import {
  currentRunId,
  failed,
  isTerminalStatus,
  journalKey,
  phaseOf,
  stageAdmissionObjects,
  type InsightAdmissionObjects,
  type InsightJournalChange,
  type InsightJournalStatus,
  type InsightRunRef,
  type InsightSlotFailure,
  type InsightSlotKey,
} from "./insight-slot-records";
import { InsightSlotWriter } from "./insight-slot-writer";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

/** Runs this process owns, keyed by run ID; a current run absent from it is not being executed. */
type InsightProcessRuns = ReadonlyMap<string, InsightSlotKey>;

type InsightAdmissionInput = InsightSlotKey &
  Pick<
    InsightAdmissionObjects,
    | "sessionId"
    | "source"
    | "baseSha"
    | "headSha"
    | "patchHash"
    | "selection"
    | "possibleSpendAcknowledged"
  > & { readonly inProcess: InsightProcessRuns };

type Decision = Result<InsightJournalChange | undefined, InsightSlotFailure>;
type Outcome = {
  readonly status: InsightJournalStatus;
  readonly cancelEpoch: number;
};

/**
 * The only writer of current-format slot and run-journal state. Lock order is Review, then slot, then journal; the
 * legacy store lock is taken only inside a slot pointer publication, never before the slot lock, and it must be the
 * lock of the store the legacy writers use. Producer operations take the journal lock alone.
 */
export class InsightSlotAuthority {
  private readonly slotLocks = new KeyedMutex();
  private readonly journalLocks = new KeyedMutex();
  private readonly slots: InsightSlotStore;
  private readonly journals: InsightRunJournalStore;
  private readonly artifacts: InsightArtifactStore;
  private readonly writer: InsightSlotWriter;

  constructor(
    private readonly paths: PatchdeskPaths,
    insightArtifactReader: typeof readBoundedInsightArtifactFile,
    legacy: Pick<InsightStore, "withLegacyLock">,
    private readonly operations: ReviewOperationCoordinator,
    private readonly now: () => IsoTimestamp,
  ) {
    this.slots = new InsightSlotStore(paths, insightArtifactReader);
    this.artifacts = new InsightArtifactStore(paths, insightArtifactReader);
    this.journals = new InsightRunJournalStore(paths, insightArtifactReader);
    this.writer = new InsightSlotWriter(
      paths,
      this.artifacts,
      this.journals,
      legacy,
      now,
    );
  }

  /**
   * Creates the queued journal, then points the slot at it. A crash between the two leaves a journal no slot names,
   * which recovery ignores and retention protects.
   */
  async admitRun(input: InsightAdmissionInput): Promise<
    Result<
      {
        readonly runId: InsightArtifactRunId;
        readonly journalId: string;
        readonly captureId: string;
      },
      InsightSlotFailure
    >
  > {
    return this.locked(input, async () => {
      const current = await this.slots.readCurrent(
        input.profileId,
        input.reviewId,
        input.type,
      );
      if (current._tag === "err") return failed();
      const slot = current.value;
      const legacyActive = [...input.inProcess.values()].some(
        (run) =>
          run.profileId === input.profileId &&
          run.reviewId === input.reviewId &&
          run.type === input.type,
      );
      if (legacyActive || (slot?.record.activeRun ?? null) !== null)
        return err("already_running");
      const token = slot?.record.nextToken ?? 1;
      const runId = v.safeParse(
        insightArtifactRunIdSchema,
        currentRunId(input, input.headSha, token),
      );
      if (!runId.success) return failed();
      if (input.inProcess.has(runId.output)) return err("already_running");
      const journal: InsightJournalKey = {
        profileId: input.profileId,
        reviewId: input.reviewId,
        journalId: randomUUID(),
        runId: runId.output,
      };
      const captureId = randomUUID();
      const createdAt = this.now();
      const objects = await stageAdmissionObjects(this.artifacts, {
        ...input,
        runId: runId.output,
        captureId,
        authorizedAt: createdAt,
      });
      if (objects._tag === "err") return failed();
      const created = await this.withJournal(journal, () =>
        this.journals.create(journal, { ...objects.value, createdAt }),
      );
      // Nothing names this journal yet, so any non-committed outcome leaves only an orphan.
      if (created._tag === "err" || created.value._tag !== "committed")
        return failed();
      const base =
        slot === undefined ? await this.writer.newSlot(input) : ok(slot.record);
      if (base._tag === "err") return base;
      const replaced = await this.writer.replaceSlot(
        input,
        slot?.pointerBytes ?? null,
        {
          ...base.value,
          version: base.value.version + 1,
          nextToken: token + 1,
          activeRun: {
            tag: "current",
            runId: runId.output,
            journalId: v.parse(insightArtifactIdSchema, journal.journalId),
          },
          replacementFailure: null,
          updatedAt: createdAt,
        },
      );
      if (replaced._tag === "err") return replaced;
      return ok({
        runId: runId.output,
        journalId: journal.journalId,
        captureId,
      });
    });
  }

  /** Records the cancel request durably (epoch + 1) before the caller signals anything; with no dispatch intent the run settles at once. */
  async cancelRun(
    input: InsightRunRef,
  ): Promise<Result<Outcome, InsightSlotFailure>> {
    return this.advanceActive(input, ({ state }): Decision => {
      if (state.status === "cancelling" || isTerminalStatus(state.status))
        return ok(undefined);
      if (state.status === "complete") return err("not_active");
      return ok(
        state.dispatches.count === 0
          ? {
              status: "cancelled",
              cancelEpoch: state.cancelEpoch + 1,
              failure: {
                code: "cancelled",
                phase: phaseOf(state),
                recovery: "terminal",
              },
            }
          : { status: "cancelling", cancelEpoch: state.cancelEpoch + 1 },
      );
    });
  }

  /** Journal terminal transaction with its FailureRecord first, then the slot releases the run into replacementFailure. */
  async settleRun(
    input: InsightRunRef & Pick<InsightFailureRecord, "code" | "phase">,
  ): Promise<Result<Outcome, InsightSlotFailure>> {
    return this.advanceActive(input, (snapshot) =>
      settleDecision(snapshot, input.code, input.phase),
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

  /**
   * Reconciles a current run this process does not own: a terminal journal only releases the slot, a run without
   * dispatch intent settles failed, and a dispatched run pauses for an explicit Resume. It never dispatches and never
   * writes legacy files; an unknown outcome stays unknown for the next pass.
   */
  async recover(
    input: InsightSlotKey,
    inProcess: InsightProcessRuns,
  ): Promise<Result<void, InsightSlotFailure>> {
    const present = await this.hasSlot(input);
    if (present._tag === "err") return present;
    if (!present.value) return ok(undefined);
    return this.locked(input, async () => {
      const slot = await this.slots.readCurrent(
        input.profileId,
        input.reviewId,
        input.type,
      );
      if (slot._tag === "err") return failed();
      const active = slot.value?.record.activeRun;
      if (
        slot.value === undefined ||
        active == null ||
        active.tag !== "current" ||
        inProcess.has(active.runId)
      )
        return ok(undefined);
      const run: InsightRunRef = {
        ...input,
        runId: active.runId,
        journalId: active.journalId,
      };
      const pending = await this.journals.pendingIntent(journalKey(run));
      if (pending._tag === "err") return failed();
      // An intent the journal moved past without recording stays for reconciliation.
      if (pending.value._tag === "conflict") return err("outcome_unknown");
      const advanced = await this.advanceJournal(run, (snapshot): Decision => {
        const { status, dispatches } = snapshot.state;
        if (
          isTerminalStatus(status) ||
          status === "paused" ||
          status === "cancelling"
        )
          return ok(undefined);
        if (dispatches.count === 0)
          return settleDecision(
            snapshot,
            "producer_unsettled",
            phaseOf(snapshot.state),
          );
        return status === "complete"
          ? err("not_active")
          : ok({
              status: "paused",
              failure: {
                code: "paid_dispatch_unknown",
                phase: "generation",
                recovery: "resume_required",
              },
            });
      });
      if (advanced._tag === "err") return advanced;
      return this.writer.releaseRun(run, slot.value, advanced.value);
    });
  }

  /** For a run the slot still names: one journal transaction, then a slot release if that made the journal terminal. */
  private async advanceActive(
    run: InsightRunRef,
    decide: (snapshot: InsightJournalSnapshot) => Decision,
  ): Promise<Result<Outcome, InsightSlotFailure>> {
    return this.locked(run, async () => {
      const current = await this.slots.readCurrent(
        run.profileId,
        run.reviewId,
        run.type,
      );
      if (current._tag === "err") return failed();
      const slot: InsightSlotSnapshot | undefined = current.value;
      const active = slot?.record.activeRun;
      if (
        slot === undefined ||
        active?.tag !== "current" ||
        active.runId !== run.runId ||
        active.journalId !== run.journalId
      )
        return err("not_active");
      const advanced = await this.advanceJournal(run, decide);
      if (advanced._tag === "err") return advanced;
      const released = await this.writer.releaseRun(run, slot, advanced.value);
      if (released._tag === "err") return released;
      return ok({
        status: advanced.value.state.status,
        cancelEpoch: advanced.value.state.cancelEpoch,
      });
    });
  }

  /** Rereads the journal under its lock, lets `decide` pick at most one transaction, and commits it. */
  private advanceJournal(
    run: InsightRunRef,
    decide: (snapshot: InsightJournalSnapshot) => Decision,
  ): Promise<Result<InsightJournalSnapshot, InsightSlotFailure>> {
    const journal = journalKey(run);
    return this.withJournal(journal, async () => {
      const read = await this.journals.read(journal);
      if (read._tag === "err") return failed();
      const change = decide(read.value);
      if (change._tag === "err") return change;
      return change.value === undefined
        ? ok(read.value)
        : this.writer.commitChange(journal, read.value, change.value);
    });
  }

  /** Review lock, then slot lock; the journal lock is taken inside. */
  private locked<T>(key: InsightSlotKey, operation: () => Promise<T>) {
    return this.operations.withReviewLock(key.profileId, key.reviewId, () =>
      this.slotLocks.run(
        `${key.profileId}\n${key.reviewId}\n${key.type}`,
        operation,
      ),
    );
  }

  private withJournal<T>(
    journal: InsightJournalKey,
    operation: () => Promise<T>,
  ) {
    return this.journalLocks.run(
      `${journal.profileId}\n${journal.reviewId}\n${journal.journalId}`,
      operation,
    );
  }
}

function settleDecision(
  snapshot: InsightJournalSnapshot,
  code: InsightFailureRecord["code"],
  phase: InsightFailureRecord["phase"],
): Decision {
  const { status } = snapshot.state;
  if (isTerminalStatus(status)) return ok(undefined);
  if (status === "complete") return err("not_active");
  return ok({
    status:
      code === "cancelled"
        ? "cancelled"
        : code === "superseded"
          ? "superseded"
          : "failed",
    failure: { code, phase, recovery: "terminal" },
  });
}
