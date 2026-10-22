import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import {
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
import type { ExplanationRunTransactions } from "./explanation-run-transactions";
import { ExplanationRequestStaging } from "./explanation-request-staging";

/**
 * Per-connection staging of exact provider request bodies. The app issues the handle, so the child never names a
 * destination; bytes arrive in bounded chunks and are committed only when their length and SHA-256 match. The body
 * TextRoot, its hash and length and a GuideDispatchIntent1 are durable before the app grants permission to send,
 * and no permission is granted once `finish` has closed writing, so no paid turn follows an accepted finish.
 */
export class GuideRequestStaging {
  private readonly staging = new ExplanationRequestStaging();

  constructor(
    private readonly authority: Pick<ExplanationRunTransactions, "produce">,
    private readonly artifacts: InsightArtifactStore,
    private readonly now: () => IsoTimestamp,
  ) {}

  /** A new open discards an unfinished earlier body: only one request is in flight per connection. */
  open(totalBytes: number): GuideAppOutcome {
    return this.staging.open(totalBytes);
  }

  chunk(
    frame: Extract<GuideChildFrame, { kind: "request_chunk" }>,
  ): GuideAppOutcome {
    return this.staging.chunk(frame);
  }

  async commit(
    context: GuideRunContext,
    frame: Extract<GuideChildFrame, { kind: "request_commit" }>,
  ): Promise<GuideAppOutcome> {
    const text = this.staging.take(frame);
    if (text._tag === "err") return { status: "refused", reason: text.error };
    const { profileId, reviewId } = context.run;
    // Sensitive content refuses dispatch; the recorded body is never a redacted variant of what would be sent.
    const root = await this.artifacts.writeTextRoot(
      profileId,
      reviewId,
      text.value,
    );
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
        const dispatches = await new InsightResultStore(
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
