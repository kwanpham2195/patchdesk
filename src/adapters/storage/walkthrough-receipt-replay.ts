import { WalkthroughBuild } from "#src/domain/walkthrough-result-records";
import {
  walkthroughPayloadSchema,
  walkthroughReceiptResultSchema,
  type WalkthroughPayload,
  type WalkthroughReceiptResult,
} from "#src/domain/walkthrough-protocol";
import {
  walkthroughOperationCodec,
  walkthroughReceiptCodec,
} from "#src/domain/walkthrough-result";
import {
  encodeInsightArtifactCanonicalJson,
  parseInsightArtifactCanonicalJson,
  type InsightArtifactIndexDescriptor,
} from "#src/domain/insight-artifact-scalars";
import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import type { InsightArtifactStore } from "./insight-artifact-store";
import { InsightResultStore } from "./insight-result-store";

/** Original receipt projection retained for exact lookup and idempotent replay. */
export type WalkthroughReplayedOperation = {
  readonly kind: WalkthroughPayload["kind"];
  readonly payloadHash: string;
  readonly sequence: number;
  readonly result: WalkthroughReceiptResult;
};
/** Replays ordered receipts without collecting section prose or raw hunks. */
export class WalkthroughReceiptReplay {
  private readonly store: InsightResultStore;
  constructor(
    private readonly artifacts: InsightArtifactStore,
    private readonly profileId: WorkspaceProfileId,
    private readonly reviewId: ReviewId,
    private readonly identity: {
      readonly runId: string;
      readonly generation: number;
      readonly cancelEpoch: number;
    },
    private readonly options: { readonly signal?: AbortSignal } = {},
  ) {
    this.store = new InsightResultStore(artifacts, profileId, reviewId);
  }

  /** Verifies canonical payloads, exact identities/results and the finish prefix descriptor. */
  async replay(
    receipts: InsightArtifactIndexDescriptor,
    hunks: ReadonlySet<string>,
    requireFinish: boolean,
    emit?: (
      payload: WalkthroughPayload,
      result: WalkthroughReceiptResult,
    ) => Promise<boolean>,
  ): Promise<
    Result<
      {
        readonly build: WalkthroughBuild;
        readonly ops: ReadonlyMap<string, WalkthroughReplayedOperation>;
      },
      "rejected" | "storage"
    >
  > {
    const build = new WalkthroughBuild(hunks);
    const ops = new Map<string, WalkthroughReplayedOperation>();
    let prefix = await this.store.emptyIndex("WalkthroughReceipt1");
    if (prefix._tag === "err") return err("storage");
    for (let at = 0; at < receipts.count; at += 1) {
      if (this.options.signal?.aborted) return err("storage");
      const entries = await this.store.readIndex(
        "WalkthroughReceipt1",
        receipts,
        at,
        1,
      );
      const entry = entries._tag === "ok" ? entries.value[0] : undefined;
      const sequence = at + 1;
      if (
        entry === undefined ||
        entry.key !== String(sequence).padStart(16, "0")
      )
        return err("storage");
      const receipt = await this.artifacts.readObject(
        this.profileId,
        this.reviewId,
        walkthroughReceiptCodec,
        entry.value,
      );
      if (receipt._tag === "err") return err("storage");
      if (receipt.value.sequence !== sequence) return err("rejected");
      const operation = await this.artifacts.readObject(
        this.profileId,
        this.reviewId,
        walkthroughOperationCodec,
        receipt.value.operation,
      );
      if (operation._tag === "err") return err("storage");
      const op = operation.value;
      const [payloadText, resultText] = await Promise.all([
        this.store.readText(op.payload, 32768),
        this.store.readText(receipt.value.result, 32768),
      ]);
      if (payloadText._tag === "err" || resultText._tag === "err")
        return err("storage");
      const payload = parseInsightArtifactCanonicalJson(
        new TextEncoder().encode(payloadText.value),
        walkthroughPayloadSchema,
      );
      const result = parseInsightArtifactCanonicalJson(
        new TextEncoder().encode(resultText.value),
        walkthroughReceiptResultSchema,
      );
      if (payload._tag === "err" || result._tag === "err")
        return err("rejected");
      const p = payload.value;
      if (
        p.kind !== op.kind ||
        p.opId !== op.opId ||
        p.runId !== op.runId ||
        p.generation !== op.generation ||
        p.cancelEpoch !== op.cancelEpoch ||
        op.runId !== this.identity.runId ||
        op.generation !== this.identity.generation ||
        op.cancelEpoch !== this.identity.cancelEpoch ||
        ops.has(op.opId) ||
        op.payloadHash !== op.payload.data.sha256 ||
        (op.kind === "finish" && sequence !== receipts.count)
      )
        return err("rejected");
      // Reconstructing the deterministic prefix checks its references, not merely its count.
      const applied = build.apply(p, { sequence, receipts: prefix.value });
      if (
        applied._tag === "err" ||
        encodeInsightArtifactCanonicalJson(applied.value) !==
          encodeInsightArtifactCanonicalJson(result.value)
      )
        return err("rejected");
      if (emit !== undefined && !(await emit(p, result.value)))
        return err("storage");
      ops.set(op.opId, {
        kind: op.kind,
        payloadHash: op.payloadHash,
        sequence,
        result: result.value,
      });
      prefix = await this.store.appendIndex(
        "WalkthroughReceipt1",
        prefix.value,
        sequence,
        entry.value,
      );
      if (prefix._tag === "err") return err("storage");
    }
    return requireFinish && !build.isClosed
      ? err("rejected")
      : ok({ build, ops });
  }
}
