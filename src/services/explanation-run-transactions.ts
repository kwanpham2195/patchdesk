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
import { definedProps } from "#src/domain/defined-props";
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
export type ExplanationAuthorityInternals = {
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
export type ExplanationResumeInput = {
  readonly generation: number;
  readonly authorization: InsightArtifactReference;
  readonly native: {
    readonly startCount: number;
    readonly startsRoot: string;
    readonly observationsRoot: string;
  };
} & (
  | {
      readonly guideRuntime: InsightArtifactReference;
      readonly walkthroughRuntime?: never;
    }
  | {
      readonly walkthroughRuntime: InsightArtifactReference;
      readonly guideRuntime?: never;
    }
);

/**
 * Guide and Walkthrough journal and slot transitions over the shared authority locks. Lock order is unchanged: producer
 * operations take the journal lock alone; begin, resume and publish take Review, slot, then journal.
 */
export class ExplanationRunTransactions {
  constructor(private readonly internals: ExplanationAuthorityInternals) {}

  /**
   * Begins the bound explanation family with its own runtime and dispatch index; Walkthrough also installs its
   * begin-time deadline and linked authorization atomically before dispatch.
   */
  begin<E>(
    input: InsightRunRef & {
      readonly generation: number;
      readonly cancelEpoch: number;
      readonly guideRuntime?: InsightArtifactReference;
      readonly walkthroughRuntime?: InsightArtifactReference;
      readonly dispatches: InsightArtifactIndexDescriptor;
      readonly policy?: InsightArtifactReference;
      readonly authorization?: InsightArtifactReference;
    },
    guard: () => Promise<Result<void, E>>,
  ): Promise<Result<Outcome, InsightSlotFailure | E>> {
    return this.internals.advanceActive(input, guard, ({ state }): Decision =>
      state.generation === input.generation &&
      state.cancelEpoch === input.cancelEpoch &&
      state.status === "preparing" &&
      (input.type === "guide"
        ? state.guidePreparation !== undefined &&
          state.guideRuntime === undefined &&
          input.guideRuntime !== undefined &&
          input.walkthroughRuntime === undefined
        : input.type === "walkthrough" &&
          state.walkthroughPreparation !== undefined &&
          state.walkthroughRuntime === undefined &&
          input.walkthroughRuntime !== undefined &&
          input.guideRuntime === undefined &&
          input.policy !== undefined &&
          input.authorization !== undefined) &&
      state.dispatches.count === 0
        ? ok({
            status: "running",
            ...definedProps({
              guideRuntime: input.guideRuntime,
              walkthroughRuntime: input.walkthroughRuntime,
              policy: input.policy,
              authorization: input.authorization,
            }),
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
   * the pause, the acknowledged generation and native start evidence, then advances the generation and the
   * cancel epoch together, records the `resume` Authorization and a fresh GuideRuntime1, marks usage unknown and
   * clears the pause. Dispatch intents, receipts and the prior runtime stay in storage untouched.
   */
  resume<E>(
    run: InsightRunRef,
    input: ExplanationResumeInput,
    guard: () => Promise<Result<void, E>>,
  ): Promise<Result<Outcome, InsightSlotFailure | E>> {
    return this.internals.advanceActive(run, guard, ({ state }): Decision =>
      state.status === "paused" &&
      (run.type === "guide"
        ? state.guidePreparation !== undefined &&
          state.guideRuntime !== undefined &&
          input.guideRuntime !== undefined
        : run.type === "walkthrough" &&
          state.walkthroughPreparation !== undefined &&
          state.walkthroughRuntime !== undefined &&
          input.walkthroughRuntime !== undefined) &&
      state.generation === input.generation &&
      state.dispatches.count === 0 &&
      state.nativeExecution !== undefined &&
      state.nativeExecution.starts.count === input.native.startCount &&
      input.native.startCount > 0 &&
      state.nativeExecution.starts.root.hash === input.native.startsRoot &&
      state.nativeExecution.observations.root.hash ===
        input.native.observationsRoot
        ? ok({
            status: "running",
            generation: state.generation + 1,
            cancelEpoch: state.cancelEpoch + 1,
            authorization: input.authorization,
            ...definedProps({
              guideRuntime: input.guideRuntime,
              walkthroughRuntime: input.walkthroughRuntime,
            }),
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
    actual.retained?.root.bytes === expected.retained?.root.bytes &&
    actual.publication?.hash === expected.publication?.hash &&
    actual.publication?.bytes === expected.publication?.bytes
  );
}
