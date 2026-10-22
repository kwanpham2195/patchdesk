import {
  walkthroughRuntimeCodec,
  walkthroughResultRootCodec,
  walkthroughValidationCodec,
  walkthroughPublicationCodec,
} from "#src/domain/walkthrough-result";
import { walkthroughPreparedInputCodec } from "#src/domain/walkthrough-preparation";
import {
  insightBindingCodec,
  insightDomainIdentityCodec,
} from "#src/domain/insight-run-binding-contract";
import { encodeInsightArtifactCanonicalJson } from "#src/domain/insight-artifact-scalars";
import type { IsoTimestamp } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type { ExplanationRunTransactions } from "./explanation-run-transactions";
import type { InsightRunRef } from "./insight-slot-records";
import {
  slotPointerDigest,
  type GuidePublicationFences,
  type GuidePublicationFailure,
} from "./guide-result-publication";

/** Publishes only a complete, identity-bound validated Walkthrough graph under the authority's existing locks. */
export class WalkthroughPublisher {
  constructor(
    private readonly authority: Pick<ExplanationRunTransactions, "publish">,
    private readonly artifacts: InsightArtifactStore,
    private readonly now: () => IsoTimestamp,
  ) {}

  /** Compares every immutable descriptor and represented identity before atomically replacing the pointer. */
  async publish(
    run: InsightRunRef,
    fences: GuidePublicationFences & {
      readonly sessionId: string;
      readonly headSha: string;
      readonly baseSha: string;
      readonly patchHash: string;
    },
    represented: () => Promise<Result<void, GuidePublicationFailure>>,
  ): Promise<Result<void, GuidePublicationFailure>> {
    if (run.type !== "walkthrough") return err("invalid");
    const { profileId, reviewId } = run;
    const published = await this.authority.publish<GuidePublicationFailure>(
      run,
      represented,
      async ({ slot, journal }) => {
        const { state } = journal;
        if (
          state.status !== "running" ||
          state.generation !== fences.generation ||
          state.cancelEpoch !== fences.cancelEpoch ||
          state.walkthroughRuntime === undefined ||
          state.walkthroughPreparation === undefined ||
          encodeInsightArtifactCanonicalJson(state.walkthroughRuntime) !==
            encodeInsightArtifactCanonicalJson(fences.runtime) ||
          slot.record.version !== fences.slotVersion ||
          slotPointerDigest(slot) !== fences.slotDigest
        )
          return err("stale");
        const runtime = await this.artifacts.readObject(
          profileId,
          reviewId,
          walkthroughRuntimeCodec,
          state.walkthroughRuntime,
        );
        if (runtime._tag === "err") return err("storage");
        const frozen = runtime.value.frozen;
        if (
          runtime.value.phase !== "validated" ||
          frozen === null ||
          encodeInsightArtifactCanonicalJson(runtime.value.result) !==
            encodeInsightArtifactCanonicalJson(fences.result) ||
          encodeInsightArtifactCanonicalJson(runtime.value.preparation) !==
            encodeInsightArtifactCanonicalJson(state.walkthroughPreparation) ||
          frozen.sequence !== frozen.receipts.count ||
          encodeInsightArtifactCanonicalJson(runtime.value.receipts) !==
            encodeInsightArtifactCanonicalJson(frozen.receipts)
        )
          return err("invalid");
        const [root, prepared, binding] = await Promise.all([
          this.artifacts.readObject(
            profileId,
            reviewId,
            walkthroughResultRootCodec,
            fences.result,
          ),
          this.artifacts.readObject(
            profileId,
            reviewId,
            walkthroughPreparedInputCodec,
            state.walkthroughPreparation,
          ),
          this.artifacts.readObject(
            profileId,
            reviewId,
            insightBindingCodec,
            state.binding,
          ),
        ]);
        if (
          root._tag === "err" ||
          prepared._tag === "err" ||
          binding._tag === "err"
        )
          return err("storage");
        if (
          binding.value.kind !== "walkthrough" ||
          binding.value.patchHash !== fences.patchHash ||
          binding.value.headSha !== fences.headSha ||
          binding.value.baseSha !== fences.baseSha
        )
          return err("invalid");
        const identity = await this.artifacts.readObject(
          profileId,
          reviewId,
          insightDomainIdentityCodec,
          binding.value.identity,
        );
        if (identity._tag === "err") return err("storage");
        for (const [field, expected] of [
          ["profileId", profileId],
          ["reviewId", reviewId],
          ["runId", run.runId],
          ["sessionId", fences.sessionId],
        ] as const) {
          if (
            (
              await this.artifacts.verifyTextRootEquals(
                profileId,
                reviewId,
                identity.value[field],
                expected,
              )
            )._tag === "err"
          )
            return err("invalid");
        }
        const validation = await this.artifacts.readObject(
          profileId,
          reviewId,
          walkthroughValidationCodec,
          root.value.validation,
        );
        if (validation._tag === "err") return err("storage");
        const { generation, cancelEpoch, validator, ...validatedGraph } =
          validation.value;
        const { validation: validationReference, ...rootGraph } = root.value;
        if (
          validator !== "walkthrough-citations-v1" ||
          generation !== fences.generation ||
          cancelEpoch !== fences.cancelEpoch ||
          encodeInsightArtifactCanonicalJson(validatedGraph) !==
            encodeInsightArtifactCanonicalJson(rootGraph) ||
          encodeInsightArtifactCanonicalJson(root.value.binding) !==
            encodeInsightArtifactCanonicalJson(state.binding) ||
          encodeInsightArtifactCanonicalJson(prepared.value.binding) !==
            encodeInsightArtifactCanonicalJson(state.binding) ||
          encodeInsightArtifactCanonicalJson(root.value.preparation) !==
            encodeInsightArtifactCanonicalJson(state.walkthroughPreparation) ||
          root.value.frozenSequence !== frozen.sequence ||
          encodeInsightArtifactCanonicalJson(root.value.receipts) !==
            encodeInsightArtifactCanonicalJson(frozen.receipts) ||
          encodeInsightArtifactCanonicalJson(root.value.hunks) !==
            encodeInsightArtifactCanonicalJson(prepared.value.hunks) ||
          encodeInsightArtifactCanonicalJson(root.value.contextCompleteness) !==
            encodeInsightArtifactCanonicalJson(
              prepared.value.contextCompleteness,
            ) ||
          root.value.citedHunks + root.value.uncited.count !==
            root.value.hunks.count
        )
          return err("invalid");
        const at = this.now();
        const publication = await this.artifacts.writeObject(
          profileId,
          reviewId,
          walkthroughPublicationCodec,
          {
            runId: run.runId,
            generation,
            cancelEpoch,
            expectedSlotVersion: fences.slotVersion,
            expectedSlotDigest: fences.slotDigest,
            frozenSequence: frozen.sequence,
            receipts: frozen.receipts,
            result: fences.result,
            validation: validationReference,
            publishedAt: at,
          },
        );
        if (publication._tag === "err") return err("storage");
        return ok({
          record: {
            ...slot.record,
            version: slot.record.version + 1,
            retained: { tag: "generated" as const, root: fences.result },
            activeRun: null,
            replacementFailure: null,
            publication: publication.value,
            updatedAt: at,
          },
          complete: {
            status: "complete" as const,
            publication: publication.value,
          },
        });
      },
    );
    return published._tag === "ok"
      ? published
      : err(
          published.error === "invalid"
            ? "invalid"
            : published.error === "stale" || published.error === "not_active"
              ? "stale"
              : "storage",
        );
  }
}
