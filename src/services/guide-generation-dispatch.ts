import { createHash } from "node:crypto";

import { GuideResultStore } from "#src/adapters/storage/guide-result-store";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import {
  GUIDE_MAX_REQUEST_BYTES,
  GUIDE_REQUEST_CHUNK_BYTES,
  type GuideAppOutcome,
  type GuideChildFrame,
  type GuideRefusalReason,
} from "#src/domain/guide-protocol";
import {
  guideDispatchIntentCodec,
  guideRuntimeCodec,
} from "#src/domain/guide-result";
import type { IsoTimestamp } from "#src/domain/ids";
import { err, ok } from "#src/domain/result";
import {
  outcomeForFailure,
  type GuideRunContext,
} from "./guide-generation-operations";
import type { GuideRunTransactions } from "./guide-run-transactions";

type StagedRequest = {
  readonly handle: number;
  readonly totalBytes: number;
  readonly chunks: Buffer[];
  received: number;
};

/**
 * Per-connection staging of exact provider request bodies. The app issues the handle, so the child never names a
 * destination; bytes arrive in bounded chunks and are committed only when their length and SHA-256 match. The body
 * TextRoot, its hash and length and a GuideDispatchIntent1 are durable before the app grants permission to send,
 * and no permission is granted once `finish` has closed writing, so no paid turn follows an accepted finish.
 */
export class GuideRequestStaging {
  private staged: StagedRequest | undefined;
  private nextHandle = 1;

  constructor(
    private readonly authority: Pick<GuideRunTransactions, "produce">,
    private readonly artifacts: InsightArtifactStore,
    private readonly now: () => IsoTimestamp,
  ) {}

  /** A new open discards an unfinished earlier body: only one request is in flight per connection. */
  open(totalBytes: number): GuideAppOutcome {
    if (totalBytes > GUIDE_MAX_REQUEST_BYTES)
      return { status: "refused", reason: "too_large" };
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.staged = { handle, totalBytes, chunks: [], received: 0 };
    return { status: "handle", handle };
  }

  chunk(
    frame: Extract<GuideChildFrame, { kind: "request_chunk" }>,
  ): GuideAppOutcome {
    const staged = this.staged;
    if (staged === undefined || staged.handle !== frame.handle)
      return { status: "refused", reason: "invalid_input" };
    const bytes = Buffer.from(frame.data, "base64");
    if (
      frame.offset !== staged.received ||
      bytes.length === 0 ||
      bytes.length > GUIDE_REQUEST_CHUNK_BYTES ||
      staged.received + bytes.length > staged.totalBytes
    ) {
      this.staged = undefined;
      return { status: "refused", reason: "invalid_input" };
    }
    staged.chunks.push(bytes);
    staged.received += bytes.length;
    return { status: "stored" };
  }

  async commit(
    context: GuideRunContext,
    frame: Extract<GuideChildFrame, { kind: "request_commit" }>,
  ): Promise<GuideAppOutcome> {
    const staged = this.staged;
    this.staged = undefined;
    if (
      staged === undefined ||
      staged.handle !== frame.handle ||
      staged.received !== staged.totalBytes ||
      frame.bytes !== staged.totalBytes
    )
      return { status: "refused", reason: "invalid_input" };
    const body = Buffer.concat(staged.chunks);
    if (createHash("sha256").update(body).digest("hex") !== frame.sha256)
      return { status: "refused", reason: "invalid_input" };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        body,
      );
    } catch {
      return { status: "refused", reason: "unsupported" };
    }
    const { profileId, reviewId } = context.run;
    // Sensitive content refuses dispatch; the recorded body is never a redacted variant of what would be sent.
    const root = await this.artifacts.writeTextRoot(profileId, reviewId, text);
    if (root._tag === "err")
      return {
        status: "refused",
        reason:
          root.error.reason === "sensitive_value" ? "sensitive" : "storage",
      };
    let ordinal = 0;
    const recorded = await this.authority.produce<GuideRefusalReason>(
      context.run,
      async (snapshot) => {
        const { state } = snapshot;
        if (state.status === "cancelling" || state.status === "cancelled")
          return err("cancelled" as const);
        if (
          state.generation !== context.generation ||
          state.cancelEpoch !== context.cancelEpoch ||
          state.guideRuntime === undefined ||
          (state.status !== "running" && state.status !== "waiting")
        )
          return err("stale_identity" as const);
        const runtime = await this.artifacts.readObject(
          profileId,
          reviewId,
          guideRuntimeCodec,
          state.guideRuntime,
        );
        if (runtime._tag === "err") return err("storage" as const);
        // After an accepted finish the model is done; no further request is permitted.
        if (runtime.value.phase !== "building") return err("closed" as const);
        ordinal = state.dispatches.count + 1;
        const intent = await this.artifacts.writeObject(
          profileId,
          reviewId,
          guideDispatchIntentCodec,
          {
            binding: state.binding,
            generation: context.generation,
            cancelEpoch: context.cancelEpoch,
            requestOrdinal: ordinal,
            requestBody: root.value,
            requestHash: frame.sha256,
            requestBytes: frame.bytes,
            createdAt: this.now(),
          },
        );
        if (intent._tag === "err") return err("storage" as const);
        const dispatches = await new GuideResultStore(
          this.artifacts,
          profileId,
          reviewId,
        ).appendIndex(
          "GuideDispatchIntent1",
          state.dispatches,
          ordinal,
          intent.value,
        );
        if (dispatches._tag === "err") return err("storage" as const);
        return ok({
          status: state.status,
          dispatches: dispatches.value,
          staged: [{ schema: "GuideDispatchIntent1", root: intent.value }],
        });
      },
    );
    if (recorded._tag === "err") return outcomeForFailure(recorded.error);
    return {
      status: "permission",
      requestOrdinal: ordinal,
      sha256: frame.sha256,
      bytes: frame.bytes,
    };
  }
}
