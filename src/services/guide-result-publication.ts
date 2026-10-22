import { createHash } from "node:crypto";
import * as v from "valibot";

import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type { InsightSlotSnapshot } from "#src/adapters/storage/insight-slot-store";
import {
  guidePublicationCodec,
  guideResultRootCodec,
  guideRuntimeCodec,
  guideValidationCodec,
} from "#src/domain/guide-result";
import type { IsoTimestamp } from "#src/domain/ids";
import {
  insightArtifactHashSchema,
  type InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import type { ExplanationRunTransactions } from "./explanation-run-transactions";
import type { GuideStartRequest } from "./guide-generation-service";
import type { PiGuideChildOutcome } from "./pi-insight-child-invoker";
import type { ExplanationPreparationService } from "./explanation-preparation-service";
import type { InsightEvidenceReference } from "./insight-evidence-reference";
import type { InsightResourceBundle } from "./insight-resource-bundle";
import type { InsightSlotAuthority } from "./insight-slot-authority";
import { isTerminalStatus } from "./insight-slot-records";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type { GuideRuntime } from "#src/domain/guide-result";
import type { InsightFailureRecord } from "#src/domain/insight-run-binding-contract";
import type { InsightRunRef } from "./insight-slot-records";

/** What the publication compares against; every field was observed or produced by this run. */
export type GuidePublicationFences = {
  readonly generation: number;
  readonly cancelEpoch: number;
  /** R<GuideRuntime1> in its `validated` phase. */
  readonly runtime: InsightArtifactReference;
  readonly result: InsightArtifactReference;
  readonly slotVersion: number;
  readonly slotDigest: InsightArtifactReference["hash"];
};

/** `stale` means a fence no longer holds; the previous retained result is untouched in every failure. */
export type GuidePublicationFailure = "stale" | "invalid" | "storage";

/** SHA-256 of the slot pointer bytes, the digest half of the slot-version fence. */
export function slotPointerDigest(
  slot: InsightSlotSnapshot,
): InsightArtifactReference["hash"] {
  return v.parse(
    insightArtifactHashSchema,
    createHash("sha256").update(slot.pointerBytes).digest("hex"),
  );
}

/**
 * Publishes a validated Guide through the existing SlotRecord3 authority. Under the Review, slot and journal locks it
 * rereads the journal, the validated runtime, the validation and the result root and compares run, generation, cancel
 * epoch, authoritative status, frozen sequence and receipt index, result and validation identity, and the slot's
 * version and digest. Only then does the slot name `{generated, root}` and `GuidePublication1` together. A previously
 * retained result stays named on every failure, and a committed pointer stays a success.
 */
export class GuidePublisher {
  constructor(
    private readonly authority: Pick<ExplanationRunTransactions, "publish">,
    private readonly artifacts: InsightArtifactStore,
    private readonly now: () => IsoTimestamp,
  ) {}

  async publish(
    run: InsightRunRef,
    fences: GuidePublicationFences,
    /** Runs under the Review lock; confirms the represented session, head, base and patch are unchanged. */
    represented: () => Promise<Result<void, GuidePublicationFailure>>,
  ): Promise<Result<void, GuidePublicationFailure>> {
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
          state.guideRuntime === undefined ||
          state.guidePreparation === undefined ||
          state.guideRuntime.hash !== fences.runtime.hash ||
          slot.record.version !== fences.slotVersion ||
          slotPointerDigest(slot) !== fences.slotDigest
        )
          return err("stale" as const);
        const runtime = await this.artifacts.readObject(
          profileId,
          reviewId,
          guideRuntimeCodec,
          state.guideRuntime,
        );
        if (runtime._tag === "err") return err("storage" as const);
        const frozen = runtime.value.frozen;
        if (
          runtime.value.phase !== "validated" ||
          frozen === null ||
          runtime.value.result === null ||
          runtime.value.result.hash !== fences.result.hash ||
          runtime.value.preparation.hash !== state.guidePreparation.hash
        )
          return err("stale" as const);
        const root = await this.artifacts.readObject(
          profileId,
          reviewId,
          guideResultRootCodec,
          fences.result,
        );
        if (root._tag === "err") return err("storage" as const);
        const validation = await this.artifacts.readObject(
          profileId,
          reviewId,
          guideValidationCodec,
          root.value.validation,
        );
        if (validation._tag === "err") return err("storage" as const);
        if (
          root.value.binding.hash !== state.binding.hash ||
          root.value.preparation.hash !== state.guidePreparation.hash ||
          root.value.frozenSequence !== frozen.sequence ||
          !sameIndex(root.value.receipts, frozen.receipts) ||
          validation.value.binding.hash !== state.binding.hash ||
          validation.value.generation !== fences.generation ||
          validation.value.cancelEpoch !== fences.cancelEpoch ||
          validation.value.frozenSequence !== frozen.sequence ||
          !sameIndex(validation.value.receipts, frozen.receipts) ||
          !sameIndex(validation.value.groups, root.value.groups) ||
          !sameIndex(validation.value.inventory, root.value.inventory) ||
          !sameIndex(validation.value.others, root.value.others)
        )
          return err("invalid" as const);
        const at = this.now();
        const publication = await this.artifacts.writeObject(
          profileId,
          reviewId,
          guidePublicationCodec,
          {
            runId: run.runId,
            generation: fences.generation,
            cancelEpoch: fences.cancelEpoch,
            expectedSlotVersion: fences.slotVersion,
            expectedSlotDigest: fences.slotDigest,
            frozenSequence: frozen.sequence,
            receipts: frozen.receipts,
            result: fences.result,
            validation: root.value.validation,
            publishedAt: at,
          },
        );
        if (publication._tag === "err") return err("storage" as const);
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
    if (published._tag === "ok") return published;
    return err(
      published.error === "stale" || published.error === "invalid"
        ? published.error
        : published.error === "not_active"
          ? "stale"
          : "storage",
    );
  }
}

function sameIndex(
  left: { readonly root: InsightArtifactReference; readonly count: number },
  right: { readonly root: InsightArtifactReference; readonly count: number },
): boolean {
  return (
    left.count === right.count &&
    left.root.hash === right.root.hash &&
    left.root.bytes === right.root.bytes
  );
}

/** One model pass: the generation and cancel epoch it runs under, fixed durably before its child starts. */
export type GuidePass = {
  readonly request: GuideStartRequest;
  readonly run: InsightRunRef;
  readonly generation: number;
  readonly cancelEpoch: number;
  readonly evidence: InsightEvidenceReference;
};

/** The slot version and digest the pass was started against; publication refuses any other. */
export type GuideBaseline = {
  readonly version: number;
  readonly digest: InsightArtifactReference["hash"];
};

/**
 * Ends a pass from the journal, never from the child's word alone: cancel and pause are respected, a closed Guide is
 * validated by the worker and published through `GuidePublisher`, and every failure is settled durably (or reported
 * unconfirmed, so the caller keeps ownership). A shutdown stop is left to startup recovery.
 */
export class GuidePassConclusion {
  private readonly publisher: GuidePublisher;

  constructor(
    private readonly destination: PatchdeskPaths,
    private readonly authority: InsightSlotAuthority,
    private readonly artifacts: InsightArtifactStore,
    private readonly jobs: Pick<InsightResourceBundle["jobs"], "validateGuide">,
    private readonly preparation: Pick<
      ExplanationPreparationService,
      "representedInputs"
    >,
    private readonly isStopping: (runId: string) => boolean,
    now: () => IsoTimestamp,
  ) {
    this.publisher = new GuidePublisher(authority.explanation, artifacts, now);
  }

  /** Decides the pass's end from the journal, never from the child's word alone. */
  async conclude(
    pass: GuidePass,
    outcome: PiGuideChildOutcome,
    controller: AbortController,
    baseline: GuideBaseline,
  ): Promise<void> {
    const ref = pass.run;
    const read = await this.authority.explanation.produce(ref, async () =>
      ok(undefined),
    );
    if (read._tag === "err") return;
    const { state } = read.value;
    // Cancel already settled it, or it rests paused for an explicit Resume.
    if (
      isTerminalStatus(state.status) ||
      state.status === "complete" ||
      state.status === "paused" ||
      state.generation !== pass.generation
    )
      return;
    if (state.status === "cancelling" || controller.signal.aborted) {
      await this.settle(ref, "cancelled", "generation");
      return;
    }
    // Cancellation advances the epoch before the stopped pass can settle it.
    if (state.cancelEpoch !== pass.cancelEpoch) return;
    const runtimeRoot = state.guideRuntime;
    const runtime =
      runtimeRoot === undefined
        ? undefined
        : await this.artifacts.readObject(
            ref.profileId,
            ref.reviewId,
            guideRuntimeCodec,
            runtimeRoot,
          );
    if (
      runtimeRoot !== undefined &&
      runtime?._tag === "ok" &&
      runtime.value.frozen !== null
    ) {
      if (
        runtime.value.phase === "validated" &&
        runtime.value.result !== null
      ) {
        await this.publish(pass, runtimeRoot, runtime.value.result, baseline);
        return;
      }
      if (runtime.value.phase === "validating") {
        await this.finalize(
          pass,
          state.binding,
          runtime.value,
          runtimeRoot,
          controller,
          baseline,
        );
        return;
      }
    }
    if (outcome._tag === "failed") {
      // A recorded request that may have been served stays locked for explicit Resume; it is never replayed.
      if (!outcome.effectKnown && state.dispatches.count > 0) {
        await this.pause(ref);
        return;
      }
      await this.settle(ref, failureCode(outcome.reason), "generation");
      return;
    }
    await this.settle(ref, "unresolved_work", "generation");
  }

  private async finalize(
    pass: GuidePass,
    binding: InsightArtifactReference,
    runtime: GuideRuntime,
    runtimeRoot: InsightArtifactReference,
    controller: AbortController,
    baseline: GuideBaseline,
  ): Promise<void> {
    const ref = pass.run;
    const { profileId, reviewId } = ref;
    const validated = await this.jobs.validateGuide(
      {
        destinationRoot: this.destination.dataDirectory(),
        profileId,
        reviewId,
        runId: ref.runId,
        binding,
        preparation: runtime.preparation,
        runtime: runtimeRoot,
        generation: pass.generation,
        cancelEpoch: pass.cancelEpoch,
      },
      { signal: controller.signal },
    );
    if (validated._tag === "err") {
      const reason = validated.error.reason;
      if (reason === "aborted" && this.isStopping(ref.runId)) return;
      await this.settle(
        ref,
        reason === "aborted"
          ? "cancelled"
          : reason === "rejected"
            ? "validation_rejected"
            : "storage_unavailable",
        reason === "rejected" ? "validation" : "generation",
      );
      return;
    }
    const advanced = await this.artifacts.writeObject(
      profileId,
      reviewId,
      guideRuntimeCodec,
      { ...runtime, phase: "validated", result: validated.value.result },
    );
    if (advanced._tag === "err") {
      await this.settle(ref, "storage_unavailable", "validation");
      return;
    }
    const marked = await this.authority.explanation.produce(
      ref,
      async ({ state }) =>
        state.status === "running" &&
        state.generation === pass.generation &&
        state.cancelEpoch === pass.cancelEpoch &&
        state.guideRuntime?.hash === runtimeRoot.hash
          ? ok({ status: state.status, guideRuntime: advanced.value })
          : err("not_active" as const),
    );
    if (marked._tag === "err") {
      if (marked.error === "not_active")
        await this.settle(ref, "cancelled", "validation");
      return;
    }
    await this.publish(pass, advanced.value, validated.value.result, baseline);
  }

  private async publish(
    pass: GuidePass,
    runtime: InsightArtifactReference,
    result: InsightArtifactReference,
    baseline: GuideBaseline,
  ): Promise<void> {
    const ref = pass.run;
    const published = await this.publisher.publish(
      ref,
      {
        generation: pass.generation,
        cancelEpoch: pass.cancelEpoch,
        runtime,
        result,
        slotVersion: baseline.version,
        slotDigest: baseline.digest,
      },
      async () => {
        const unchanged = await this.preparation.representedInputs(
          pass.request,
          pass.request,
        );
        return unchanged._tag === "ok" ? ok(undefined) : err("stale" as const);
      },
    );
    if (published._tag === "ok") return;
    await this.settle(
      ref,
      published.error === "stale"
        ? "evidence_changed"
        : published.error === "invalid"
          ? "validation_rejected"
          : "storage_unavailable",
      "publication",
    );
  }

  /** True only when storage confirms the run is settled; otherwise the run stays owned for a later cancel or recovery. */
  async settle(
    ref: InsightRunRef,
    code: InsightFailureRecord["code"],
    phase: InsightFailureRecord["phase"],
  ): Promise<boolean> {
    try {
      const settled = await this.authority.settleRun({ ...ref, code, phase });
      return settled._tag === "ok" || settled.error === "not_active";
    } catch {
      return false;
    }
  }

  private async pause(ref: InsightRunRef): Promise<boolean> {
    try {
      const paused = await this.authority.explanation.produce(
        ref,
        async ({ state }) =>
          state.status === "running" || state.status === "waiting"
            ? ok({
                status: "paused" as const,
                failure: {
                  code: "paid_dispatch_unknown" as const,
                  phase: "generation" as const,
                  recovery: "resume_required" as const,
                },
              })
            : ok(undefined),
      );
      return paused._tag === "ok";
    } catch {
      return false;
    }
  }
}

type PiGuideChildFailure = Extract<
  PiGuideChildOutcome,
  { _tag: "failed" }
>["reason"];

function failureCode(
  reason: PiGuideChildFailure,
): InsightFailureRecord["code"] {
  switch (reason) {
    case "cancelled":
      return "cancelled";
    case "runtime_unavailable":
      return "capability_unavailable";
    case "invalid_result":
      return "unresolved_work";
    case "timed_out":
      return "resource_exhausted";
    default:
      return "provider_refused";
  }
}
