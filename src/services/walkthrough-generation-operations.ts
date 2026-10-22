import { createHash } from "node:crypto";
import * as v from "valibot";
import {
  WalkthroughReceiptReplay,
  type WalkthroughReplayedOperation,
} from "#src/adapters/storage/walkthrough-receipt-replay";
import type { WalkthroughBuild } from "#src/domain/walkthrough-result-records";
import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import {
  walkthroughPreparedInputCodec,
  walkthroughHunkCodec,
} from "#src/domain/walkthrough-preparation";
import {
  walkthroughPayloadSchema,
  walkthroughChildFrameSchema,
  WALKTHROUGH_REFUSAL_REASONS,
  type WalkthroughToolCall,
  type WalkthroughAppOutcome,
  type WalkthroughRefusalReason,
} from "#src/domain/walkthrough-protocol";
import {
  walkthroughOperationCodec,
  walkthroughReceiptCodec,
  walkthroughRuntimeCodec,
} from "#src/domain/walkthrough-result";
import {
  encodeInsightArtifactCanonicalJson,
  insightArtifactHashSchema,
} from "#src/domain/insight-artifact-scalars";
import { err, ok } from "#src/domain/result";
import type { ExplanationRunTransactions } from "./explanation-run-transactions";
import type { GuideRunContext } from "./guide-generation-operations";
import type { InsightSlotFailure } from "./insight-slot-records";

type RunMemory = {
  readonly runtime: string;
  readonly generation: number;
  readonly cancelEpoch: number;
  readonly build: WalkthroughBuild;
  readonly ops: Map<string, WalkthroughReplayedOperation>;
};

/** App-owned strict ordered tools; only the journal transaction grants acceptance. */
export class WalkthroughRunOperations {
  private readonly memory = new Map<string, RunMemory>();
  constructor(
    private readonly authority: Pick<ExplanationRunTransactions, "produce">,
    private readonly artifacts: InsightArtifactStore,
  ) {}

  /** Releases the compact receipt lookup/build state when a pass ends. */
  forget(runId: string): void {
    this.memory.delete(runId);
  }

  /** Applies or looks up a tool under the current generation before inspecting operation identity. */
  async handle(
    context: GuideRunContext,
    call: WalkthroughToolCall,
  ): Promise<WalkthroughAppOutcome> {
    if (Buffer.byteLength(JSON.stringify(call)) > 32768)
      return { status: "refused", reason: "too_large" };
    const frame = {
      kind: "tool",
      runId: context.run.runId,
      generation: context.generation,
      cancelEpoch: context.cancelEpoch,
      connection: "internal",
      correlation: 1,
      call,
    };
    if (Buffer.byteLength(JSON.stringify(frame)) > 32768)
      return { status: "refused", reason: "too_large" };
    const checked = v.safeParse(walkthroughChildFrameSchema, frame);
    if (!checked.success || checked.output.kind !== "tool")
      return { status: "refused", reason: "invalid_input" };
    call = checked.output.call;
    let answer: WalkthroughAppOutcome = { status: "unknown" };
    const { profileId, reviewId } = context.run;
    const store = new InsightResultStore(this.artifacts, profileId, reviewId);
    const committed = await this.authority.produce<WalkthroughRefusalReason>(
      context.run,
      async ({ state, head }) => {
        if (
          state.generation !== context.generation ||
          state.cancelEpoch !== context.cancelEpoch ||
          context.run.type !== "walkthrough"
        )
          return err("stale_identity");
        if (state.status === "cancelled" || state.status === "cancelling")
          return err("cancelled");
        if (
          (state.status !== "running" &&
            state.status !== "waiting" &&
            state.status !== "complete") ||
          state.walkthroughRuntime === undefined ||
          state.walkthroughPreparation === undefined
        )
          return err("closed");
        const [runtime, prepared] = await Promise.all([
          this.artifacts.readObject(
            profileId,
            reviewId,
            walkthroughRuntimeCodec,
            state.walkthroughRuntime,
          ),
          this.artifacts.readObject(
            profileId,
            reviewId,
            walkthroughPreparedInputCodec,
            state.walkthroughPreparation,
          ),
        ]);
        if (runtime._tag === "err" || prepared._tag === "err")
          return err("storage");
        if (
          prepared.value.binding.hash !== state.binding.hash ||
          runtime.value.preparation.hash !== state.walkthroughPreparation.hash
        )
          return err("storage");
        let memory = this.memory.get(context.run.runId);
        if (
          memory === undefined ||
          memory.runtime !== state.walkthroughRuntime.hash ||
          memory.generation !== context.generation ||
          memory.cancelEpoch !== context.cancelEpoch
        ) {
          const ids = new Set<string>();
          for (let at = 0; at < prepared.value.hunks.count; at += 1) {
            const entries = await store.readIndex(
              "WalkthroughHunk1",
              prepared.value.hunks,
              at,
              1,
            );
            const entry = entries._tag === "ok" ? entries.value[0] : undefined;
            if (entry === undefined) return err("storage");
            const hunk = await this.artifacts.readObject(
              profileId,
              reviewId,
              walkthroughHunkCodec,
              entry.value,
            );
            if (hunk._tag === "err" || hunk.value.id !== `h${at + 1}`)
              return err("storage");
            ids.add(hunk.value.id);
          }
          const replayed = await new WalkthroughReceiptReplay(
            this.artifacts,
            profileId,
            reviewId,
            {
              runId: context.run.runId,
              generation: context.generation,
              cancelEpoch: context.cancelEpoch,
            },
          ).replay(runtime.value.receipts, ids, false);
          if (replayed._tag === "err") return err("storage");
          memory = {
            runtime: state.walkthroughRuntime.hash,
            generation: context.generation,
            cancelEpoch: context.cancelEpoch,
            build: replayed.value.build,
            ops: new Map(replayed.value.ops),
          };
          this.memory.set(context.run.runId, memory);
        }
        const prior = memory.ops.get(call.input.opId);
        if (call.tool === "lookup_receipt") {
          answer =
            prior === undefined
              ? { status: "not_found" }
              : {
                  status: "receipt",
                  sequence: prior.sequence,
                  result: prior.result,
                };
          return ok(undefined);
        }
        const parsed = v.safeParse(walkthroughPayloadSchema, {
          kind: call.tool,
          ...call.input,
          runId: context.run.runId,
          generation: context.generation,
          cancelEpoch: context.cancelEpoch,
        });
        if (!parsed.success) return err("invalid_input");
        const payloadText = encodeInsightArtifactCanonicalJson(parsed.output);
        if (payloadText === undefined) return err("invalid_input");
        const payloadHash = v.parse(
          insightArtifactHashSchema,
          createHash("sha256").update(payloadText).digest("hex"),
        );
        if (prior !== undefined) {
          if (prior.kind !== call.tool || prior.payloadHash !== payloadHash)
            return err("op_conflict");
          answer = {
            status: "receipt",
            sequence: prior.sequence,
            result: prior.result,
          };
          return ok(undefined);
        }
        const sequence = runtime.value.receipts.count + 1;
        // A stage or commit failure must never leave speculative acceptance cached.
        this.memory.delete(context.run.runId);
        const applied = memory.build.apply(parsed.output, {
          sequence,
          receipts: runtime.value.receipts,
        });
        if (applied._tag === "err") return applied;
        answer = { status: "receipt", sequence, result: applied.value };
        if (
          Buffer.byteLength(
            JSON.stringify({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    accepted: true,
                    sequence,
                    ...applied.value,
                  }),
                },
              ],
            }),
          ) > 32768
        )
          return err("too_large");
        const resultText = encodeInsightArtifactCanonicalJson(applied.value);
        if (resultText === undefined) return err("storage");
        const [payload, result] = await Promise.all([
          this.artifacts.writeTextRoot(profileId, reviewId, payloadText),
          this.artifacts.writeTextRoot(profileId, reviewId, resultText),
        ]);
        if (payload._tag === "err" || result._tag === "err")
          return err(
            [payload, result].some(
              (r) => r._tag === "err" && r.error.reason === "sensitive_value",
            )
              ? "sensitive"
              : "storage",
          );
        const operation = await this.artifacts.writeObject(
          profileId,
          reviewId,
          walkthroughOperationCodec,
          {
            runId: context.run.runId,
            generation: context.generation,
            cancelEpoch: context.cancelEpoch,
            opId: parsed.output.opId,
            kind: parsed.output.kind,
            payload: payload.value,
            payloadHash,
          },
        );
        if (operation._tag === "err") return err("storage");
        const receipt = await this.artifacts.writeObject(
          profileId,
          reviewId,
          walkthroughReceiptCodec,
          { operation: operation.value, sequence, result: result.value },
        );
        if (receipt._tag === "err") return err("storage");
        const [receipts, journalReceipts] = await Promise.all([
          store.appendIndex(
            "WalkthroughReceipt1",
            runtime.value.receipts,
            sequence,
            receipt.value,
          ),
          store.appendIndex(
            "Receipt",
            head.receipts,
            head.receipts.count + 1,
            receipt.value,
          ),
        ]);
        if (receipts._tag === "err" || journalReceipts._tag === "err")
          return err("storage");
        const runtimeValue = { ...runtime.value, receipts: receipts.value };
        if (call.tool === "finish") {
          runtimeValue.phase = "validating";
          runtimeValue.frozen = { sequence, receipts: receipts.value };
        }
        const next = await this.artifacts.writeObject(
          profileId,
          reviewId,
          walkthroughRuntimeCodec,
          runtimeValue,
        );
        if (next._tag === "err") return err("storage");
        memory.ops.set(parsed.output.opId, {
          kind: parsed.output.kind,
          payloadHash,
          sequence,
          result: applied.value,
        });
        this.memory.set(context.run.runId, {
          ...memory,
          runtime: next.value.hash,
        });
        return ok({
          status: state.status,
          walkthroughRuntime: next.value,
          operation: {
            operation: operation.value,
            receipt: receipt.value,
            receipts: journalReceipts.value,
          },
          staged: [
            { schema: "WalkthroughOperation1", root: operation.value },
            { schema: "WalkthroughReceipt1", root: receipt.value },
          ],
        });
      },
    );
    if (committed._tag === "err") this.memory.delete(context.run.runId);
    return committed._tag === "ok"
      ? answer
      : walkthroughOutcomeForFailure(committed.error);
  }
}

/** Unknown journal outcomes must stop production rather than promise refusal. */
function walkthroughOutcomeForFailure(
  error: WalkthroughRefusalReason | InsightSlotFailure,
): WalkthroughAppOutcome {
  if (error === "outcome_unknown") return { status: "unknown" };
  const reason = WALKTHROUGH_REFUSAL_REASONS.find((r) => r === error);
  return { status: "refused", reason: reason ?? "storage" };
}
