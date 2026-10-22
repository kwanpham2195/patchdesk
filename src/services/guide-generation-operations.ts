import { createHash } from "node:crypto";
import * as v from "valibot";

import {
  GuideReceiptReplay,
  type ReplayedOperation,
} from "#src/adapters/storage/guide-result-job";
import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type { InsightJournalSnapshot } from "#src/adapters/storage/insight-run-journal-reader";
import { guideInventoryEntrySchema } from "#src/domain/guide";
import { guidePreparedInputCodec } from "#src/domain/guide-preparation";
import {
  GUIDE_REFUSAL_REASONS,
  type GuideAppOutcome,
  type GuideChildFrame,
  type GuideOperationKind,
  type GuideRefusalReason,
} from "#src/domain/guide-protocol";
import {
  guideOperationCodec,
  guideReceiptCodec,
  guideRuntimeCodec,
  type GuideRuntime,
} from "#src/domain/guide-result";
import {
  encodeGuideOperationPayload,
  encodeGuideReceiptResult,
  parseGuideReceiptResult,
  type GuideBuild,
} from "#src/domain/guide-result-records";
import {
  insightArtifactHashSchema,
  type InsightArtifactReference,
  type InsightTextRootDescriptor,
} from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import type { ExplanationRunTransactions } from "./explanation-run-transactions";
import type {
  InsightJournalChange,
  InsightRunRef,
  InsightSlotFailure,
} from "./insight-slot-records";

/** The run, generation and cancel epoch one channel connection is bound to. */
export type GuideRunContext = {
  readonly run: InsightRunRef;
  readonly generation: number;
  readonly cancelEpoch: number;
};

type ToolCall = Extract<GuideChildFrame, { kind: "tool" }>["call"];

/** Rebuilt from durable receipts whenever its count disagrees with the journal's; never trusted across a failed commit. */
type RunMemory = {
  readonly build: GuideBuild;
  readonly ops: Map<string, ReplayedOperation>;
  count: number;
};

/**
 * One model-facing mutation as the operations module applies it. `apply` changes the in-memory build only when the
 * operation is valid, so a refusal leaves the durable log and the view untouched; `resultText` encodes the accepted
 * receipt data, which for `finish` includes the receipts accepted before it.
 */
type Mutation<TApplied> = {
  readonly kind: GuideOperationKind;
  readonly opId: string;
  readonly payloadText: string | undefined;
  readonly apply: (build: GuideBuild) => Result<TApplied, GuideRefusalReason>;
  readonly resultText: (
    applied: TApplied,
    position: {
      readonly sequence: number;
      readonly receipts: GuideRuntime["receipts"];
    },
  ) => string | undefined;
};

const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;

/**
 * App-owned acceptance of the four Guide tools. Every mutation is one journal transaction taken under the journal
 * lock alone: it checks the bound identity, replays an identical operation ID to its original receipt, refuses a
 * conflicting one, validates membership against the complete inventory, and records operation, receipt and the grown
 * GuideRuntime1 together. `finish` closes writing and freezes the receipt sequence in the same transaction.
 */
export class GuideRunOperations {
  private readonly memory = new Map<string, RunMemory>();

  constructor(
    private readonly authority: Pick<ExplanationRunTransactions, "produce">,
    private readonly artifacts: InsightArtifactStore,
  ) {}

  /** Drops the in-memory view when the run ends. */
  forget(runId: string): void {
    this.memory.delete(runId);
  }

  handle(context: GuideRunContext, call: ToolCall): Promise<GuideAppOutcome> {
    const identity = {
      runId: context.run.runId,
      generation: context.generation,
      cancelEpoch: context.cancelEpoch,
    };
    switch (call.tool) {
      case "open_group": {
        const input = call.input;
        return this.mutate(context, {
          kind: "open_group",
          opId: input.opId,
          payloadText: encodeGuideOperationPayload("open_group", {
            ...input,
            ...identity,
          }),
          apply: (build) => build.openGroup(input),
          resultText: (applied) =>
            encodeGuideReceiptResult("open_group", applied),
        });
      }
      case "add_members": {
        const input = call.input;
        return this.mutate(context, {
          kind: "add_members",
          opId: input.opId,
          payloadText: encodeGuideOperationPayload("add_members", {
            ...input,
            ...identity,
          }),
          apply: (build) => build.addMembers(input),
          resultText: (applied) =>
            encodeGuideReceiptResult("add_members", applied),
        });
      }
      case "finish": {
        const input = call.input;
        return this.mutate(context, {
          kind: "finish",
          opId: input.opId,
          payloadText: encodeGuideOperationPayload("finish", {
            ...input,
            ...identity,
          }),
          apply: (build) => build.finish(),
          resultText: (_applied, position) =>
            encodeGuideReceiptResult("finish", {
              sequence: position.sequence,
              receipts: position.receipts,
            }),
        });
      }
      case "lookup_receipt":
        return this.lookup(context, call.input.opId);
    }
  }

  private async lookup(
    context: GuideRunContext,
    opId: string,
  ): Promise<GuideAppOutcome> {
    let found: ReplayedOperation | undefined;
    const read = await this.authority.produce<GuideRefusalReason>(
      context.run,
      async (snapshot) => {
        const memory = await this.view(context, snapshot);
        if (memory._tag === "err") return memory;
        found = memory.value.ops.get(opId);
        return ok(undefined);
      },
    );
    if (read._tag === "err") return outcomeForFailure(read.error);
    return found === undefined
      ? { status: "not_found" }
      : receiptOutcome(found);
  }

  private async mutate<TApplied>(
    context: GuideRunContext,
    mutation: Mutation<TApplied>,
  ): Promise<GuideAppOutcome> {
    const { profileId, reviewId } = context.run;
    const { payloadText } = mutation;
    if (payloadText === undefined)
      return { status: "refused", reason: "invalid_input" };
    const payloadHash = v.parse(
      insightArtifactHashSchema,
      createHash("sha256").update(payloadText).digest("hex"),
    );
    const payload = await this.artifacts.writeTextRoot(
      profileId,
      reviewId,
      payloadText,
    );
    if (payload._tag === "err")
      return outcomeForFailure(
        payload.error.reason === "sensitive_value" ? "sensitive" : "storage",
      );
    let replay: ReplayedOperation | undefined;
    let accepted: ReplayedOperation | undefined;
    const committed = await this.authority.produce<GuideRefusalReason>(
      context.run,
      async (snapshot) => {
        const memory = await this.view(context, snapshot);
        if (memory._tag === "err") return memory;
        const prior = memory.value.ops.get(mutation.opId);
        if (prior !== undefined) {
          // The same ID with the same canonical payload is the same operation; anything else is a conflict.
          if (
            prior.kind === mutation.kind &&
            prior.payloadHash === payloadHash
          ) {
            replay = prior;
            return ok(undefined);
          }
          return err("op_conflict" as const);
        }
        if (memory.value.build.isClosed) return err("closed" as const);
        const applied = mutation.apply(memory.value.build);
        // A refused operation changed nothing, so the memory view stays usable.
        if (applied._tag === "err") return applied;
        const runtime = await this.readRuntime(context, snapshot);
        if (runtime === undefined) return this.invalidate(context, "storage");
        const sequence = runtime.receipts.count + 1;
        const resultText = mutation.resultText(applied.value, {
          sequence,
          receipts: runtime.receipts,
        });
        if (resultText === undefined)
          return this.invalidate(context, "storage");
        const staged = await this.stage(context, snapshot, {
          mutation,
          payload: payload.value,
          payloadHash,
          resultText,
          sequence,
          runtime,
        });
        if (staged._tag === "err")
          return this.invalidate(context, staged.error);
        accepted = {
          sequence,
          kind: mutation.kind,
          payloadHash,
          result: resultText,
        };
        // Updated before the lock is released; a failed commit drops the whole view below.
        memory.value.ops.set(mutation.opId, accepted);
        memory.value.count = sequence;
        return ok(staged.value);
      },
    );
    if (committed._tag === "err") {
      // A refusal leaves the durable log unchanged, but a failed commit may have changed memory first.
      if (!isRefusal(committed.error)) this.memory.delete(context.run.runId);
      return outcomeForFailure(committed.error);
    }
    if (replay !== undefined) return receiptOutcome(replay);
    return accepted === undefined
      ? outcomeForFailure("storage")
      : receiptOutcome(accepted);
  }

  /** Writes the operation, receipt and next runtime and returns the single journal change that names them. */
  private async stage(
    context: GuideRunContext,
    snapshot: InsightJournalSnapshot,
    input: {
      readonly mutation: Pick<Mutation<unknown>, "kind" | "opId">;
      readonly payload: InsightTextRootDescriptor;
      readonly payloadHash: InsightArtifactReference["hash"];
      readonly resultText: string;
      readonly sequence: number;
      readonly runtime: GuideRuntime;
    },
  ): Promise<Result<InsightJournalChange, GuideRefusalReason>> {
    const { profileId, reviewId } = context.run;
    const store = new InsightResultStore(this.artifacts, profileId, reviewId);
    const result = await this.artifacts.writeTextRoot(
      profileId,
      reviewId,
      input.resultText,
    );
    if (result._tag === "err") return err("storage");
    const opId = v.safeParse(
      guideOperationCodec.schema.entries.opId,
      input.mutation.opId,
    );
    if (!opId.success) return err("invalid_input");
    const operation = await this.artifacts.writeObject(
      profileId,
      reviewId,
      guideOperationCodec,
      {
        runId: context.run.runId,
        generation: context.generation,
        cancelEpoch: context.cancelEpoch,
        opId: opId.output,
        kind: input.mutation.kind,
        payload: input.payload,
        payloadHash: input.payloadHash,
      },
    );
    if (operation._tag === "err") return err("storage");
    const receipt = await this.artifacts.writeObject(
      profileId,
      reviewId,
      guideReceiptCodec,
      {
        operation: operation.value,
        sequence: input.sequence,
        result: result.value,
      },
    );
    if (receipt._tag === "err") return err("storage");
    const [receipts, journalReceipts] = await Promise.all([
      store.appendIndex(
        "GuideReceipt1",
        input.runtime.receipts,
        input.sequence,
        receipt.value,
      ),
      store.appendIndex(
        "Receipt",
        snapshot.head.receipts,
        // The journal numbers every receipt of every generation; the receipt's own sequence restarts per generation.
        snapshot.head.receipts.count + 1,
        receipt.value,
      ),
    ]);
    if (receipts._tag === "err" || journalReceipts._tag === "err")
      return err("storage");
    const next: GuideRuntime =
      input.mutation.kind === "finish"
        ? {
            ...input.runtime,
            receipts: receipts.value,
            phase: "validating",
            frozen: { sequence: input.sequence, receipts: receipts.value },
          }
        : { ...input.runtime, receipts: receipts.value };
    const runtime = await this.artifacts.writeObject(
      profileId,
      reviewId,
      guideRuntimeCodec,
      next,
    );
    if (runtime._tag === "err") return err("storage");
    return ok({
      status: snapshot.state.status,
      guideRuntime: runtime.value,
      operation: {
        operation: operation.value,
        receipt: receipt.value,
        receipts: journalReceipts.value,
      },
      staged: [
        { schema: "GuideOperation1", root: operation.value },
        { schema: "GuideReceipt1", root: receipt.value },
      ],
    });
  }

  private invalidate(
    context: GuideRunContext,
    reason: GuideRefusalReason,
  ): Result<never, GuideRefusalReason> {
    this.memory.delete(context.run.runId);
    return err(reason);
  }

  private async readRuntime(
    context: GuideRunContext,
    snapshot: InsightJournalSnapshot,
  ): Promise<GuideRuntime | undefined> {
    const reference = snapshot.state.guideRuntime;
    if (reference === undefined) return undefined;
    const runtime = await this.artifacts.readObject(
      context.run.profileId,
      context.run.reviewId,
      guideRuntimeCodec,
      reference,
    );
    return runtime._tag === "ok" ? runtime.value : undefined;
  }

  /** The identity, state and in-memory view every acceptance starts from; refuses a stale or closed journal. */
  private async view(
    context: GuideRunContext,
    snapshot: InsightJournalSnapshot,
  ): Promise<Result<RunMemory, GuideRefusalReason>> {
    const { state } = snapshot;
    if (state.status === "cancelling" || state.status === "cancelled")
      return err("cancelled");
    if (
      state.generation !== context.generation ||
      state.cancelEpoch !== context.cancelEpoch ||
      state.guidePreparation === undefined ||
      (state.status !== "running" && state.status !== "waiting")
    )
      return err("stale_identity");
    const { profileId, reviewId } = context.run;
    const runtime = await this.readRuntime(context, snapshot);
    if (runtime === undefined) return err("storage");
    const cached = this.memory.get(context.run.runId);
    if (cached !== undefined && cached.count === runtime.receipts.count)
      return ok(cached);
    const store = new InsightResultStore(this.artifacts, profileId, reviewId);
    const prepared = await this.artifacts.readObject(
      profileId,
      reviewId,
      guidePreparedInputCodec,
      state.guidePreparation,
    );
    if (prepared._tag === "err") return err("storage");
    const inventory = await store.readText(
      prepared.value.inventory,
      MAX_INVENTORY_BYTES,
    );
    if (inventory._tag === "err") return err("storage");
    const ids = parseInventoryIds(inventory.value);
    if (ids === undefined) return err("storage");
    const replayed = await new GuideReceiptReplay(
      this.artifacts,
      store,
      profileId,
      reviewId,
      {
        runId: context.run.runId,
        generation: context.generation,
        cancelEpoch: context.cancelEpoch,
      },
      {},
    ).replay(
      { sequence: runtime.receipts.count, receipts: runtime.receipts },
      ids,
      false,
    );
    if (replayed === undefined || replayed === "io") return err("storage");
    const memory: RunMemory = {
      build: replayed.build,
      ops: new Map(replayed.ops),
      count: runtime.receipts.count,
    };
    this.memory.set(context.run.runId, memory);
    return ok(memory);
  }
}

function receiptOutcome(op: ReplayedOperation): GuideAppOutcome {
  const result = parseGuideReceiptResult(op.kind, op.result);
  return result._tag === "ok"
    ? { status: "receipt", sequence: op.sequence, result: result.value }
    : outcomeForFailure("storage");
}

function isRefusal(
  error: GuideRefusalReason | InsightSlotFailure,
): error is GuideRefusalReason {
  return GUIDE_REFUSAL_REASONS.some((reason) => reason === error);
}

/**
 * A refusal promises no side effect. Only a definite failure is one; an unknown journal outcome is reported as such so
 * the producer stops instead of treating a possibly recorded mutation as rejected.
 */
function outcomeForFailure(
  error: GuideRefusalReason | InsightSlotFailure,
): GuideAppOutcome {
  if (error === "outcome_unknown") return { status: "unknown" };
  return { status: "refused", reason: isRefusal(error) ? error : "storage" };
}

function parseInventoryIds(text: string): ReadonlySet<string> | undefined {
  try {
    const parsed = v.safeParse(
      v.array(guideInventoryEntrySchema),
      JSON.parse(text),
    );
    return parsed.success && parsed.output.length > 0
      ? new Set(parsed.output.map((entry) => entry.id))
      : undefined;
  } catch {
    return undefined;
  }
}
