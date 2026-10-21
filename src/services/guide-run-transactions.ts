import type {
  InsightJournalKey,
  InsightJournalSnapshot,
} from "#src/adapters/storage/insight-run-journal-reader";
import type { InsightRunJournalStore } from "#src/adapters/storage/insight-run-journal-store";
import type {
  InsightSlotSnapshot,
  InsightSlotStore,
} from "#src/adapters/storage/insight-slot-store";
import type {
  InsightArtifactIndexDescriptor,
  InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import type { InsightSlotRecord3 } from "#src/domain/insight-slot-contract";
import { err, ok, type Result } from "#src/domain/result";
import {
  failed,
  journalKey,
  type InsightJournalChange,
  type InsightJournalStatus,
  type InsightRunRef,
  type InsightSlotFailure,
  type InsightSlotKey,
} from "./insight-slot-records";
import type { InsightSlotWriter } from "./insight-slot-writer";

type Decision<E = never> = Result<
  InsightJournalChange | undefined,
  InsightSlotFailure | E
>;
type Outcome = {
  readonly status: InsightJournalStatus;
  readonly cancelEpoch: number;
};

/** The locks and stores of the one authority; the Guide transitions share them instead of adding an authority. */
export type GuideAuthorityInternals = {
  locked<T>(key: InsightSlotKey, operation: () => Promise<T>): Promise<T>;
  withJournal<T>(
    journal: InsightJournalKey,
    operation: () => Promise<T>,
  ): Promise<T>;
  advanceActive<E>(
    run: InsightRunRef,
    guard: () => Promise<Result<void, E>>,
    decide: (snapshot: InsightJournalSnapshot) => Decision,
  ): Promise<Result<Outcome, InsightSlotFailure | E>>;
  advanceJournal<E>(
    run: InsightRunRef,
    decide: (
      snapshot: InsightJournalSnapshot,
    ) => Decision<E> | Promise<Decision<E>>,
  ): Promise<Result<InsightJournalSnapshot, InsightSlotFailure | E>>;
  readonly slots: InsightSlotStore;
  readonly journals: InsightRunJournalStore;
  readonly writer: InsightSlotWriter;
};

/** What an explicit Resume names: the unresolved evidence it acknowledges and the Authorization it records. */
export type GuideResumeInput = {
  readonly generation: number;
  readonly dispatchCount: number;
  readonly authorization: InsightArtifactReference;
  readonly guideRuntime: InsightArtifactReference;
};

/**
 * Guide-specific journal and slot transitions over the shared authority locks. Lock order is unchanged: producer
 * operations take the journal lock alone; begin, resume and publish take Review, slot, then journal.
 */
export class GuideRunTransactions {
  constructor(private readonly internals: GuideAuthorityInternals) {}

  /**
   * Moves a prepared Guide run to `running` with its GuideRuntime1 root and a fresh, empty GuideDispatchIntent1 index
   * in place of the admission-time one. The journal must still be at the admitted generation and cancel epoch.
   */
  begin<E>(
    input: InsightRunRef & {
      readonly generation: number;
      readonly cancelEpoch: number;
      readonly guideRuntime: InsightArtifactReference;
      readonly dispatches: InsightArtifactIndexDescriptor;
    },
    guard: () => Promise<Result<void, E>>,
  ): Promise<Result<Outcome, InsightSlotFailure | E>> {
    return this.internals.advanceActive(input, guard, ({ state }): Decision =>
      state.generation === input.generation &&
      state.cancelEpoch === input.cancelEpoch &&
      state.status === "preparing" &&
      state.guidePreparation !== undefined &&
      state.guideRuntime === undefined &&
      state.dispatches.count === 0
        ? ok({
            status: "running",
            guideRuntime: input.guideRuntime,
            dispatches: input.dispatches,
          })
        : err("not_active"),
    );
  }

  /**
   * One producer transaction under the journal lock alone, so tool traffic never waits on a Review or slot lock. A
   * cancel racing it serializes on the same journal lock and raises the cancel epoch, which `produce` must compare.
   */
  produce<E>(
    run: InsightRunRef,
    produce: (snapshot: InsightJournalSnapshot) => Promise<Decision<E>>,
  ): Promise<Result<InsightJournalSnapshot, InsightSlotFailure | E>> {
    return this.internals.advanceJournal(run, produce);
  }

  /**
   * Explicit Resume of a run paused for an unknown paid effect. Under the Review, slot and journal locks it requires
   * the pause, the acknowledged generation and the acknowledged dispatch count, then advances the generation and the
   * cancel epoch together, records the `resume` Authorization and a fresh GuideRuntime1, marks usage unknown and
   * clears the pause. Dispatch intents, receipts and the prior runtime stay in storage untouched.
   */
  resume<E>(
    run: InsightRunRef,
    input: GuideResumeInput,
    guard: () => Promise<Result<void, E>>,
  ): Promise<Result<Outcome, InsightSlotFailure | E>> {
    return this.internals.advanceActive(run, guard, ({ state }): Decision =>
      state.status === "paused" &&
      state.guidePreparation !== undefined &&
      state.guideRuntime !== undefined &&
      state.generation === input.generation &&
      state.dispatches.count === input.dispatchCount &&
      input.dispatchCount > 0
        ? ok({
            status: "running",
            generation: state.generation + 1,
            cancelEpoch: state.cancelEpoch + 1,
            authorization: input.authorization,
            guideRuntime: input.guideRuntime,
            clearFailure: true,
            usageUnknown: true,
          })
        : err("not_active"),
    );
  }

  /**
   * Publishes a validated Guide. The journal lock is held from the final fence reads through the slot pointer
   * commit, so a producer-only mutation cannot slip in after the generation, cancel epoch and frozen receipts were
   * compared. `build` fences and stages the publication; the committed pointer is the success. An uncertain pointer
   * replacement is decided by rereading the slot and comparing the exact version, retained root and publication.
   * Completing the journal afterwards is bookkeeping that never revokes the success; recovery repeats it.
   */
  async publish<E>(
    run: InsightRunRef,
    guard: () => Promise<Result<void, E>>,
    build: (context: {
      readonly slot: InsightSlotSnapshot;
      readonly journal: InsightJournalSnapshot;
    }) => Promise<
      Result<
        {
          readonly record: InsightSlotRecord3;
          readonly complete: InsightJournalChange;
        },
        InsightSlotFailure | E
      >
    >,
  ): Promise<Result<void, InsightSlotFailure | E>> {
    const { locked, withJournal, slots, journals, writer } = this.internals;
    const committed = await locked(run, async () => {
      const allowed = await guard();
      if (allowed._tag === "err") return allowed;
      const current = await slots.readCurrent(
        run.profileId,
        run.reviewId,
        run.type,
      );
      if (current._tag === "err") return failed();
      const slot = current.value;
      const active = slot?.record.activeRun;
      if (
        slot === undefined ||
        active?.tag !== "current" ||
        active.runId !== run.runId ||
        active.journalId !== run.journalId
      )
        return err("not_active" as const);
      const journal = journalKey(run);
      return withJournal(journal, async () => {
        const pending = await journals.pendingIntent(journal);
        if (pending._tag === "err") return failed();
        if (pending.value._tag === "conflict")
          return err("outcome_unknown" as const);
        const snapshot = await journals.read(journal);
        if (snapshot._tag === "err") return failed();
        const built = await build({ slot, journal: snapshot.value });
        if (built._tag === "err") return built;
        const replaced = await writer.replaceSlot(
          run,
          slot.pointerBytes,
          built.value.record,
        );
        if (replaced._tag === "err") {
          if (replaced.error !== "outcome_unknown") return replaced;
          const reread = await slots.readCurrent(
            run.profileId,
            run.reviewId,
            run.type,
          );
          if (reread._tag === "err") return replaced;
          if (!samePublished(reread.value?.record, built.value.record))
            return failed();
        }
        return ok(built.value.complete);
      });
    });
    if (committed._tag === "err") return committed;
    try {
      await this.internals.advanceJournal(run, () => ok(committed.value));
    } catch {
      // The pointer is committed; recovery completes the journal from the matching publication.
    }
    return ok(undefined);
  }

  /** Journal-only completion of a run whose publication already committed; used by recovery. Idempotent. */
  recordPublication(
    run: InsightRunRef,
    publication: InsightArtifactReference,
  ): Promise<Result<InsightJournalSnapshot, InsightSlotFailure>> {
    return this.internals.advanceJournal(run, ({ state }): Decision =>
      state.status === "complete"
        ? ok(undefined)
        : state.status === "running"
          ? ok({ status: "complete", publication })
          : err("not_active"),
    );
  }
}

function samePublished(
  actual: InsightSlotRecord3 | undefined,
  expected: InsightSlotRecord3,
): boolean {
  return (
    actual !== undefined &&
    actual.version === expected.version &&
    actual.retained?.tag === expected.retained?.tag &&
    actual.retained?.root.hash === expected.retained?.root.hash &&
    actual.publication?.hash === expected.publication?.hash
  );
}
