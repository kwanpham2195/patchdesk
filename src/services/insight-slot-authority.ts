import type { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type {
  InsightJournalKey,
  InsightJournalSnapshot,
} from "#src/adapters/storage/insight-run-journal-reader";
import { InsightRunJournalReader } from "#src/adapters/storage/insight-run-journal-reader";
import { InsightRunJournalStore } from "#src/adapters/storage/insight-run-journal-store";
import {
  InsightSlotStore,
  type InsightSlotSnapshot,
} from "#src/adapters/storage/insight-slot-store";
import type { InsightStore } from "#src/adapters/storage/insight-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type { IsoTimestamp } from "#src/domain/ids";
import type { InsightArtifactReference } from "#src/domain/insight-artifact-scalars";
import type { InsightFailureRecord } from "#src/domain/insight-run-binding-contract";
import type { InsightJournalState } from "#src/domain/insight-run-journal-contract";
import { KeyedMutex } from "#src/domain/keyed-mutex";
import { err, ok, type Result } from "#src/domain/result";
import {
  failed,
  isTerminalStatus,
  journalKey,
  phaseOf,
  type InsightJournalChange,
  type InsightJournalStatus,
  type InsightRunRef,
  type InsightSlotFailure,
  type InsightSlotKey,
} from "./insight-slot-records";
import {
  InsightSlotAdmission,
  type InsightAdmissionInput,
  type InsightAdmittedRun,
  type InsightProcessRuns,
} from "./insight-slot-admission";
import { reconcilePublishedGuide } from "./guide-publication-recovery";
import { GuideRunTransactions } from "./guide-run-transactions";
import { InsightSlotStatus } from "./insight-slot-status";
import { InsightSlotWriter } from "./insight-slot-writer";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

type Decision<E = never> = Result<
  InsightJournalChange | undefined,
  InsightSlotFailure | E
>;
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
  private readonly admission: InsightSlotAdmission;
  /** Lock-free reads of the same state, for status, cancel lookup and listings. */
  readonly status: InsightSlotStatus;
  private readonly publishedGuide: Parameters<
    typeof reconcilePublishedGuide
  >[0];
  /** The Guide begin, produce, resume and publish transitions over this authority's own locks and stores. */
  readonly guide: GuideRunTransactions;

  constructor(
    paths: PatchdeskPaths,
    insightArtifactReader: typeof readBoundedInsightArtifactFile,
    legacy: Pick<InsightStore, "load" | "withLegacyLock">,
    private readonly operations: ReviewOperationCoordinator,
    now: () => IsoTimestamp,
  ) {
    this.status = new InsightSlotStatus(paths, insightArtifactReader);
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
    this.guide = new GuideRunTransactions({
      locked: (key, operation) => this.locked(key, operation),
      withJournal: (journal, operation) => this.withJournal(journal, operation),
      advanceActive: (run, guard, decide) =>
        this.advanceActive(run, guard, decide),
      advanceJournal: (run, decide) => this.advanceJournal(run, decide),
      slots: this.slots,
      journals: this.journals,
      writer: this.writer,
    });
    this.publishedGuide = {
      paths,
      artifacts: this.artifacts,
      slots: this.slots,
      journals: new InsightRunJournalReader(
        paths,
        this.artifacts,
        insightArtifactReader,
      ),
      guide: this.guide,
    };
    this.admission = new InsightSlotAdmission(
      this.slots,
      this.writer,
      this.artifacts,
      this.journals,
      legacy,
      now,
      (key, operation) => this.locked(key, operation),
      (journal, operation) => this.withJournal(journal, operation),
    );
  }

  /** Stages before Review/slot locks; see `InsightSlotAdmission`. */
  admitRun<E = never>(
    input: InsightAdmissionInput<E>,
  ): Promise<Result<InsightAdmittedRun, InsightSlotFailure | E>> {
    return this.admission.admit(input);
  }

  /**
   * Records the cancel request durably (epoch + 1) before the caller signals anything. A run with no dispatch intent, or
   * a paused run no process owns, settles cancelled at once; a dispatched run stays cancelling until its owner settles it.
   * `mutable` runs under the Review lock before anything is read, so the caller's Review check cannot go stale between
   * its own check and the cancel.
   */
  async cancelRun<E>(
    input: InsightRunRef,
    mutable: () => Promise<Result<void, E>>,
  ): Promise<Result<Outcome, InsightSlotFailure | E>> {
    return this.advanceActive(input, mutable, ({ state }): Decision => {
      if (state.status === "cancelling" || isTerminalStatus(state.status))
        return ok(undefined);
      if (state.status === "complete") return err("not_active");
      const cancelEpoch = state.cancelEpoch + 1;
      return ok(
        state.status === "paused" || state.dispatches.count === 0
          ? settleUnowned(state, cancelEpoch)
          : { status: "cancelling", cancelEpoch },
      );
    });
  }

  /**
   * Installs a verified GuidePreparedInput1 on the admitted run. `guard` runs under the Review lock before anything is
   * read, so the caller's represented-input check cannot go stale; the journal must still be at the admitted generation
   * and cancel epoch, awaiting its first preparation, so a cancelled or settled run never gains the root.
   */
  async installGuidePreparation<E>(
    input: InsightRunRef & {
      readonly generation: number;
      readonly cancelEpoch: number;
      readonly guidePreparation: InsightArtifactReference;
    },
    guard: () => Promise<Result<void, E>>,
  ): Promise<Result<Outcome, InsightSlotFailure | E>> {
    return this.advanceActive(input, guard, ({ state }): Decision =>
      state.generation === input.generation &&
      state.cancelEpoch === input.cancelEpoch &&
      (state.status === "queued" || state.status === "preparing") &&
      state.guidePreparation === undefined
        ? ok({
            status: "preparing",
            guidePreparation: input.guidePreparation,
          })
        : err("not_active"),
    );
  }

  /** Journal terminal transaction with its FailureRecord first, then the slot releases the run into replacementFailure. */
  async settleRun(
    input: InsightRunRef & Pick<InsightFailureRecord, "code" | "phase">,
  ): Promise<Result<Outcome, InsightSlotFailure>> {
    return this.advanceActive(
      input,
      async () => ok(undefined),
      (snapshot) => settleDecision(snapshot, input.code, input.phase),
    );
  }

  /** Whether a slot pointer exists, without reading a body. */
  hasSlot(input: InsightSlotKey): Promise<Result<boolean, InsightSlotFailure>> {
    return this.status.hasSlot(input);
  }

  /**
   * Reconciles a current run this process does not own: a terminal journal only releases the slot, a cancelling run
   * settles cancelled, a run without dispatch intent settles failed (cancelled when paused), and a dispatched run pauses
   * for an explicit Resume. It never dispatches and never writes legacy files; an unknown outcome stays unknown for the
   * next pass. A lock-free read comes first, so a slot with no run, or one this process owns, never waits for the Review lock.
   */
  recover(
    input: InsightSlotKey,
    inProcess: InsightProcessRuns,
  ): Promise<Result<void, InsightSlotFailure>> {
    return this.reconcile(input, inProcess, (operation) =>
      this.locked(input, operation),
    ).then(async (reconciled) =>
      reconciled._tag === "err"
        ? reconciled
        : reconcilePublishedGuide(this.publishedGuide, input),
    );
  }

  /** `recover` for a caller that already holds the Review lock and takes only the slot lock. */
  recoverHeld(
    input: InsightSlotKey,
    inProcess: InsightProcessRuns,
  ): Promise<Result<void, InsightSlotFailure>> {
    return this.reconcile(input, inProcess, (operation) =>
      this.slotLocks.run(slotLockKey(input), operation),
    );
  }

  private async reconcile(
    input: InsightSlotKey,
    inProcess: InsightProcessRuns,
    lock: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<Result<void, InsightSlotFailure>> {
    const present = await this.hasSlot(input);
    if (present._tag === "err") return present;
    if (!present.value) return ok(undefined);
    const seen = await this.slots.readCurrent(
      input.profileId,
      input.reviewId,
      input.type,
    );
    if (seen._tag === "err") return failed();
    if (unownedRun(seen.value, inProcess) === undefined) return ok(undefined);
    return lock(async () => {
      const slot = await this.slots.readCurrent(
        input.profileId,
        input.reviewId,
        input.type,
      );
      if (slot._tag === "err") return failed();
      const active = unownedRun(slot.value, inProcess);
      if (slot.value === undefined || active === undefined)
        return ok(undefined);
      const run: InsightRunRef = {
        ...input,
        runId: active.runId,
        journalId: active.journalId,
      };
      const advanced = await this.advanceJournal(run, ({ state }): Decision => {
        const { status, dispatches } = state;
        if (isTerminalStatus(status)) return ok(undefined);
        if (status === "complete") return err("not_active");
        if (status === "cancelling") return ok(settleUnowned(state));
        // A dispatched pause waits for an explicit Resume; only a pause with nothing to resume is released.
        if (status === "paused")
          return ok(
            dispatches.count === 0
              ? settleUnowned(state, state.cancelEpoch + 1)
              : undefined,
          );
        return ok(
          dispatches.count === 0
            ? {
                status: "failed",
                failure: {
                  code: "producer_unsettled",
                  phase: phaseOf(state),
                  recovery: "terminal",
                },
              }
            : {
                status: "paused",
                failure: {
                  code: "paid_dispatch_unknown",
                  phase: "generation",
                  recovery: "resume_required",
                },
              },
        );
      });
      if (advanced._tag === "err") return advanced;
      return this.writer.releaseRun(run, slot.value, advanced.value);
    });
  }

  /** For a run the slot still names: one journal transaction, then a slot release if that made the journal terminal. */
  private async advanceActive<E>(
    run: InsightRunRef,
    guard: () => Promise<Result<void, E>>,
    decide: (snapshot: InsightJournalSnapshot) => Decision,
  ): Promise<Result<Outcome, InsightSlotFailure | E>> {
    return this.locked(run, async () => {
      const allowed = await guard();
      if (allowed._tag === "err") return allowed;
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

  /**
   * Under the journal lock: refuses while a pending intent the journal moved past is unreconciled, rereads the journal,
   * lets `decide` pick at most one transaction, and commits it.
   */
  private advanceJournal<E = never>(
    run: InsightRunRef,
    decide: (
      snapshot: InsightJournalSnapshot,
    ) => Decision<E> | Promise<Decision<E>>,
  ): Promise<Result<InsightJournalSnapshot, InsightSlotFailure | E>> {
    const journal = journalKey(run);
    return this.withJournal(journal, async () => {
      const pending = await this.journals.pendingIntent(journal);
      if (pending._tag === "err") return failed();
      if (pending.value._tag === "conflict") return err("outcome_unknown");
      const read = await this.journals.read(journal);
      if (read._tag === "err") return failed();
      const change = await decide(read.value);
      if (change._tag === "err") return change;
      return change.value === undefined
        ? ok(read.value)
        : this.writer.commitChange(journal, read.value, change.value);
    });
  }

  /** Review lock, then slot lock; the journal lock is taken inside. */
  private locked<T>(key: InsightSlotKey, operation: () => Promise<T>) {
    return this.operations.withReviewLock(key.profileId, key.reviewId, () =>
      this.slotLocks.run(slotLockKey(key), operation),
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

function slotLockKey(key: InsightSlotKey): string {
  return `${key.profileId}\n${key.reviewId}\n${key.type}`;
}

/** The slot's current run when this process does not own it. */
function unownedRun(
  slot: InsightSlotSnapshot | undefined,
  inProcess: InsightProcessRuns,
) {
  const active = slot?.record.activeRun;
  return active?.tag === "current" && !inProcess.has(active.runId)
    ? active
    : undefined;
}

/**
 * No process in this app owns the run, and the absence proves nothing about a provider request that may still be
 * running. With dispatch records the run still settles cancelled, but the records stay as they are and usage is marked
 * unknown instead of zero.
 */
function settleUnowned(
  state: InsightJournalState,
  cancelEpoch = state.cancelEpoch,
): InsightJournalChange {
  const change: InsightJournalChange = {
    status: "cancelled",
    cancelEpoch,
    failure: {
      code: "cancelled",
      phase: phaseOf(state),
      recovery: "terminal",
    },
  };
  return state.dispatches.count > 0
    ? { ...change, usageUnknown: true }
    : change;
}

function settleDecision(
  snapshot: InsightJournalSnapshot,
  code: InsightFailureRecord["code"],
  phase: InsightFailureRecord["phase"],
): Decision {
  const { status } = snapshot.state;
  if (isTerminalStatus(status)) return ok(undefined);
  if (status === "complete") return err("not_active");
  const dispatched = snapshot.state.dispatches.count > 0;
  const change: InsightJournalChange = {
    status:
      code === "cancelled"
        ? "cancelled"
        : code === "superseded"
          ? "superseded"
          : "failed",
    failure: { code, phase, recovery: "terminal" },
  };
  // A dispatched request may still have been served, so its usage is unknown rather than zero.
  return ok(
    dispatched && code === "cancelled"
      ? { ...change, usageUnknown: true }
      : change,
  );
}
