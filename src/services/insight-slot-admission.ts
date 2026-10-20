import { randomUUID } from "node:crypto";
import * as v from "valibot";

import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type { InsightJournalKey } from "#src/adapters/storage/insight-run-journal-reader";
import type { InsightRunJournalStore } from "#src/adapters/storage/insight-run-journal-store";
import type {
  InsightSlotSnapshot,
  InsightSlotStore,
} from "#src/adapters/storage/insight-slot-store";
import type { InsightStore } from "#src/adapters/storage/insight-store";
import {
  insightArtifactIdSchema,
  insightArtifactRunIdSchema,
  type InsightArtifactReference,
  type InsightArtifactRunId,
} from "#src/domain/insight-artifact-scalars";
import type { IsoTimestamp } from "#src/domain/ids";
import type { InsightSlotRecord3 } from "#src/domain/insight-slot-contract";
import { err, ok, type Result } from "#src/domain/result";
import {
  currentRunId,
  failed,
  stageAdmissionObjects,
  type InsightAdmissionObjects,
  type InsightSlotFailure,
  type InsightSlotKey,
} from "./insight-slot-records";
import type { InsightSlotWriter } from "./insight-slot-writer";

/** Runs this process owns, keyed by run ID; a current run absent from it is not being executed. */
export type InsightProcessRuns = ReadonlyMap<string, InsightSlotKey>;

export type InsightAdmissionInput<E = never> = InsightSlotKey &
  Pick<
    InsightAdmissionObjects,
    | "sessionId"
    | "source"
    | "baseSha"
    | "headSha"
    | "patchHash"
    | "selection"
    | "possibleSpendAcknowledged"
  > & {
    readonly inProcess: InsightProcessRuns;
    /**
     * Runs under the Review and slot locks with the run's full identity as soon as the slot may name it: after a
     * confirmed replacement, and after an unknown one that a reread could not settle. A reconciler therefore never
     * sees the run unowned, and the caller keeps what it needs to settle an uncertain run. It is not called when the
     * replacement is known not to have happened.
     */
    readonly claim?: (run: InsightAdmittedRun) => void;
    /**
     * Rechecks the represented session, head, base and patch identity under the same Review and slot lock, after
     * staging and before the slot names the run. It must not take the Review lock itself.
     */
    readonly represented?: () => Promise<Result<void, E>>;
  };

/** What a successful admission names: the run, its journal and the Binding every later artifact must cite. */
export type InsightAdmittedRun = {
  readonly runId: InsightArtifactRunId;
  readonly journalId: string;
  readonly captureId: string;
  readonly binding: InsightArtifactReference;
  /** The journal's creating transaction fixes generation 1 and cancel epoch 0. */
  readonly generation: 1;
  readonly cancelEpoch: 0;
};

/** An admission built outside the locks for the slot version it saw. */
type StagedAdmission = Omit<
  InsightAdmittedRun,
  "generation" | "cancelEpoch"
> & {
  readonly record: InsightSlotRecord3;
};

type Locked = <T>(
  key: InsightSlotKey,
  operation: () => Promise<T>,
) => Promise<T>;

/** Stages admission objects and the journal outside the Review and slot locks, then names the run in the slot under them. */
export class InsightSlotAdmission {
  constructor(
    private readonly slots: InsightSlotStore,
    private readonly writer: InsightSlotWriter,
    private readonly artifacts: InsightArtifactStore,
    private readonly journals: InsightRunJournalStore,
    private readonly legacy: Pick<InsightStore, "load">,
    private readonly now: () => IsoTimestamp,
    private readonly locked: Locked,
    private readonly withJournal: <T>(
      journal: InsightJournalKey,
      operation: () => Promise<T>,
    ) => Promise<T>,
  ) {}

  /** A changed slot version refuses publication and leaves unnamed immutable orphans. */
  async admit<E = never>(
    input: InsightAdmissionInput<E>,
  ): Promise<Result<InsightAdmittedRun, InsightSlotFailure | E>> {
    const seen = await this.slots.readCurrent(
      input.profileId,
      input.reviewId,
      input.type,
    );
    if (seen._tag === "err") return failed();
    const early = await this.refusal(input, seen.value);
    if (early._tag === "err") return early;
    const staged = await this.stage(input, seen.value);
    if (staged._tag === "err") return staged;
    const { record, ...run } = staged.value;
    return this.locked(input, async () => {
      const current = await this.slots.readCurrent(
        input.profileId,
        input.reviewId,
        input.type,
      );
      if (current._tag === "err") return failed();
      if (current.value?.record.version !== seen.value?.record.version)
        return err("already_running");
      const refused = await this.refusal(input, current.value);
      if (refused._tag === "err") return refused;
      const unchanged = await input.represented?.();
      if (unchanged?._tag === "err") return unchanged;
      const replaced = await this.writer.replaceSlot(
        input,
        current.value?.pointerBytes ?? null,
        record,
      );
      const admitted: InsightAdmittedRun = {
        ...run,
        generation: 1,
        cancelEpoch: 0,
      };
      if (replaced._tag === "err") {
        if (replaced.error !== "outcome_unknown") return replaced;
        // The pointer may have been renamed: decide from the slot under the same locks, never from the error alone.
        const reread = await this.slots.readCurrent(
          input.profileId,
          input.reviewId,
          input.type,
        );
        if (reread._tag === "err") {
          // Still unknown: the caller owns the run and settles it by its exact identity.
          input.claim?.(admitted);
          return replaced;
        }
        const active = reread.value?.record.activeRun;
        // Readable and not naming this run: the replacement did not happen and only unnamed objects remain.
        if (
          active?.tag !== "current" ||
          active.runId !== run.runId ||
          active.journalId !== run.journalId
        )
          return failed();
      }
      input.claim?.(admitted);
      return ok(admitted);
    });
  }

  /** Refuses while this process runs, or storage records, an active run of this type in either format. */
  private async refusal(
    input: InsightAdmissionInput<unknown>,
    slot: InsightSlotSnapshot | undefined,
  ): Promise<Result<void, InsightSlotFailure>> {
    const processRun = [...input.inProcess.values()].some(
      (run) =>
        run.profileId === input.profileId &&
        run.reviewId === input.reviewId &&
        run.type === input.type,
    );
    if (processRun || (slot?.record.activeRun ?? null) !== null)
      return err("already_running");
    // A current slot hides the legacy record, so only a type without one can hold a persisted legacy run.
    if (slot !== undefined) return ok(undefined);
    const legacy = await this.legacy.load(
      input.profileId,
      input.reviewId,
      input.type,
    );
    if (legacy._tag === "err")
      return legacy.error.reason === "not_found" ? ok(undefined) : failed();
    return legacy.value.activeRun === undefined
      ? ok(undefined)
      : err("already_running");
  }

  /** Builds the journal, the admission objects and the next slot record from the slot as read, taking no Review or slot lock. */
  private async stage(
    input: InsightAdmissionInput<unknown>,
    seen: InsightSlotSnapshot | undefined,
  ): Promise<Result<StagedAdmission, InsightSlotFailure>> {
    const token = seen?.record.nextToken ?? 1;
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
    const [objects, base] = await Promise.all([
      stageAdmissionObjects(this.artifacts, {
        ...input,
        runId: runId.output,
        captureId,
        authorizedAt: createdAt,
      }),
      seen === undefined ? this.writer.newSlot(input) : ok(seen.record),
    ]);
    if (objects._tag === "err") return failed();
    if (base._tag === "err") return base;
    const created = await this.withJournal(journal, () =>
      this.journals.create(journal, { ...objects.value, createdAt }),
    );
    // Nothing names this journal yet, so any non-committed outcome leaves only an orphan.
    if (created._tag === "err" || created.value._tag !== "committed")
      return failed();
    return ok({
      runId: runId.output,
      journalId: journal.journalId,
      captureId,
      binding: objects.value.binding,
      record: {
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
    });
  }
}
