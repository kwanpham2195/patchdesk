import { randomBytes } from "node:crypto";

import { GuideResultStore } from "#src/adapters/storage/guide-result-store";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { InsightSlotStore } from "#src/adapters/storage/insight-slot-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import {
  guidePreparedInputCodec,
  type GuidePreparationFailureReason,
} from "#src/domain/guide-preparation";
import type {
  GuideAppOutcome,
  GuideChildFrame,
} from "#src/domain/guide-protocol";
import { guideRuntimeCodec } from "#src/domain/guide-result";
import { parseInsightRunId, type IsoTimestamp } from "#src/domain/ids";
import type { InsightArtifactReference } from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import { GuideRequestStaging } from "./guide-generation-dispatch";
import {
  GuideRunOperations,
  type GuideRunContext,
} from "./guide-generation-operations";
import {
  GuideResumePreparation,
  type GuideResumeFailure,
  type GuideResumeRequest,
} from "./guide-generation-resume";
import type {
  AdmittedRun,
  GuidePreparationRequest,
  GuidePreparationService,
} from "./guide-preparation-service";
import {
  GuidePassConclusion,
  slotPointerDigest,
  type GuideBaseline,
  type GuidePass,
} from "./guide-result-publication";
import type { InsightResourceBundle } from "./insight-resource-bundle";
import type { InsightSlotAuthority } from "./insight-slot-authority";
import { isTerminalStatus, type InsightRunRef } from "./insight-slot-records";
import type {
  PiGuideChildOutcome,
  PiInsightChildInvoker,
} from "./pi-insight-child-invoker";

/** The preparation request plus the head and base the run represents, so publication can recheck them. */
export type GuideStartRequest = GuidePreparationRequest & {
  readonly headSha: string;
  readonly baseSha: string;
  readonly reasoning: "low" | "medium" | "high";
};

/** What the coordinator needs from Guide generation. */
export type GuideGenerationStarter = {
  start(
    request: GuideStartRequest,
  ): Promise<
    Result<{ readonly run: AdmittedRun }, GuidePreparationFailureReason>
  >;
  resume(
    request: GuideResumeRequest,
  ): Promise<Result<void, GuideResumeFailure>>;
};

type ChildInvoker = Pick<PiInsightChildInvoker, "invokeGuide">;

/**
 * Drives a Guide from the public Start: C1 preparation, then an owned child with app-owned durable tools and request
 * admission, then worker validation and guarded publication. Start returns once the run is admitted. Resume runs the
 * same pass under a later generation after an explicit acknowledgment. Every pass is tracked by the resource bundle,
 * so shutdown stops its child and joins it before the workers it uses are terminated; a stop is not a cancellation,
 * and recovery settles the run from the journal on the next launch.
 */
export class GuideGenerationService implements GuideGenerationStarter {
  private readonly artifacts: InsightArtifactStore;
  private readonly slots: InsightSlotStore;
  private readonly operations: GuideRunOperations;
  private readonly conclusion: GuidePassConclusion;
  private readonly resumption: GuideResumePreparation;
  private readonly owned: ReturnType<
    InsightResourceBundle["ownership"]["forScope"]
  >;
  /** Runs this process is stopping for shutdown; their journals are left for recovery, not settled. */
  private readonly stopping = new Set<string>();

  constructor(
    destination: PatchdeskPaths,
    private readonly preparation: GuidePreparationService,
    private readonly authority: InsightSlotAuthority,
    private readonly resources: InsightResourceBundle,
    private readonly invoker: ChildInvoker,
    private readonly now: () => IsoTimestamp,
  ) {
    this.artifacts = new InsightArtifactStore(
      destination,
      resources.authorityReader,
    );
    this.slots = new InsightSlotStore(destination, resources.authorityReader);
    this.operations = new GuideRunOperations(authority.guide, this.artifacts);
    this.conclusion = new GuidePassConclusion(
      destination,
      authority,
      this.artifacts,
      resources.jobs,
      preparation,
      (runId) => this.stopping.has(runId),
      now,
    );
    this.owned = resources.ownership.forScope(destination.dataDirectory());
    this.resumption = new GuideResumePreparation(
      this.artifacts,
      authority,
      preparation,
      now,
    );
  }

  async start(
    request: GuideStartRequest,
  ): Promise<
    Result<{ readonly run: AdmittedRun }, GuidePreparationFailureReason>
  > {
    const operation = this.preparation.begin(request);
    const admitted = await operation.admission;
    if (admitted._tag === "err") return admitted;
    const run = admitted.value;
    const controller = new AbortController();
    const stop = (): void => {
      this.stopping.add(run.runId);
      operation.abort();
      controller.abort();
    };
    this.resources.work.track(
      stop,
      this.drive(request, operation.result, run, controller),
    );
    return ok({ run });
  }

  /** Explicit Resume of a run paused for an unknown paid effect; see `GuideResumePreparation`. */
  async resume(
    request: GuideResumeRequest,
  ): Promise<Result<void, GuideResumeFailure>> {
    const planned = await this.resumption.prepare(request);
    if (planned._tag === "err") return planned;
    const { pass, resume } = planned.value;
    const activeId = parseInsightRunId(pass.run.runId);
    if (activeId._tag === "err") return err("invalid");
    const { run } = pass;
    if (this.owned.has(run.runId)) return err("busy");
    const controller = new AbortController();
    const resumed = await this.authority.guide.resume(run, resume, () =>
      this.preparation.representedInputs(pass.request, pass.request),
    );
    if (resumed._tag === "err")
      return err(resumed.error === "not_active" ? "stale" : "storage");
    this.owned.set(run.runId, {
      runId: activeId.value,
      controller,
      preparing: false,
      profileId: run.profileId,
      reviewId: run.reviewId,
      type: "guide",
    });
    const advanced: GuidePass = {
      ...pass,
      generation: pass.generation + 1,
      cancelEpoch: resumed.value.cancelEpoch,
    };
    this.resources.work.track(
      () => {
        this.stopping.add(run.runId);
        controller.abort();
      },
      this.finishDrive(run, () => this.runPass(advanced, controller)),
    );
    return ok(undefined);
  }

  private async drive(
    request: GuideStartRequest,
    preparing: Promise<
      Result<{ readonly root: InsightArtifactReference }, unknown>
    >,
    run: AdmittedRun,
    controller: AbortController,
  ): Promise<void> {
    await this.finishDrive(run, async () => {
      const prepared = await preparing;
      if (prepared._tag === "err") return;
      const entry = this.owned.get(run.runId);
      // Released means preparation was cancelled and settled; nothing remains to generate.
      if (entry === undefined) return;
      this.owned.set(run.runId, { ...entry, controller, preparing: false });
      await this.beginAndRun(request, run, prepared.value.root, controller);
    });
  }

  /**
   * Runs one pass and then releases ownership only when the run is durably settled or resting (paused, complete or
   * no longer named by the slot). An unconfirmed settlement keeps the entry, so the run stays owned and visible to
   * cancel and status rather than being quietly forgotten.
   */
  private async finishDrive(
    run: InsightRunRef,
    pass: () => Promise<void>,
  ): Promise<void> {
    try {
      await pass();
    } catch {
      // An unexpected failure leaves the journal for recovery; ownership below stays truthful.
    } finally {
      this.operations.forget(run.runId);
      const shutdown = this.stopping.delete(run.runId);
      // A stopped pass is left for startup recovery; this process is going away.
      if (shutdown || (await this.resting(run))) this.owned.delete(run.runId);
    }
  }

  private async resting(run: InsightRunRef): Promise<boolean> {
    const active = await this.authority.status.activeRun(run);
    if (active._tag === "err") return false;
    if (active.value === undefined || active.value.runId !== run.runId)
      return true;
    const read = await this.authority.guide.produce(run, async () =>
      ok(undefined),
    );
    if (read._tag === "err") return false;
    const status = read.value.state.status;
    return (
      isTerminalStatus(status) || status === "complete" || status === "paused"
    );
  }

  private async beginAndRun(
    request: GuideStartRequest,
    run: AdmittedRun,
    preparedRoot: InsightArtifactReference,
    controller: AbortController,
  ): Promise<void> {
    const { profileId, reviewId } = run;
    const ref: InsightRunRef = run;
    const prepared = await this.artifacts.readObject(
      profileId,
      reviewId,
      guidePreparedInputCodec,
      preparedRoot,
    );
    if (prepared._tag === "err") {
      await this.conclusion.settle(ref, "storage_unavailable", "generation");
      return;
    }
    const evidence = await this.preparation.evidenceReference(
      prepared.value,
      request.sessionId,
      run,
    );
    if (evidence === undefined) {
      await this.conclusion.settle(ref, "evidence_missing", "generation");
      return;
    }
    const store = new GuideResultStore(this.artifacts, profileId, reviewId);
    const [receipts, dispatches] = await Promise.all([
      store.emptyIndex("GuideReceipt1"),
      store.emptyIndex("GuideDispatchIntent1"),
    ]);
    if (receipts._tag === "err" || dispatches._tag === "err") {
      await this.conclusion.settle(ref, "storage_unavailable", "generation");
      return;
    }
    const runtime = await this.artifacts.writeObject(
      profileId,
      reviewId,
      guideRuntimeCodec,
      {
        preparation: preparedRoot,
        phase: "building",
        receipts: receipts.value,
        frozen: null,
        result: null,
      },
    );
    if (runtime._tag === "err") {
      await this.conclusion.settle(ref, "storage_unavailable", "generation");
      return;
    }
    const began = await this.authority.guide.begin(
      {
        ...ref,
        generation: 1,
        cancelEpoch: 0,
        guideRuntime: runtime.value,
        dispatches: dispatches.value,
      },
      () => this.preparation.representedInputs(request, request),
    );
    if (began._tag === "err") {
      // No longer active means it was cancelled or settled meanwhile; a stale source is a failure.
      if (began.error === "stale_source")
        await this.conclusion.settle(ref, "evidence_changed", "generation");
      return;
    }
    await this.runPass(
      { request, run: ref, generation: 1, cancelEpoch: 0, evidence },
      controller,
    );
  }

  /** The child, then the end of the pass; the durable generation and cancel epoch already name this pass. */
  private async runPass(
    pass: GuidePass,
    controller: AbortController,
  ): Promise<void> {
    const { run, request } = pass;
    const slot = await this.slots.readCurrent(
      run.profileId,
      run.reviewId,
      "guide",
    );
    if (slot._tag === "err" || slot.value === undefined) {
      await this.conclusion.settle(run, "storage_unavailable", "generation");
      return;
    }
    const baseline: GuideBaseline = {
      version: slot.value.record.version,
      digest: slotPointerDigest(slot.value),
    };
    const permit = await this.resources.permits.generation(
      `guide-generation:${run.profileId}:${run.reviewId}`,
      controller.signal,
    );
    if (permit._tag === "err") {
      if (this.stopping.has(run.runId)) return;
      await this.conclusion.settle(
        run,
        permit.error === "aborted" ? "cancelled" : "resource_exhausted",
        "generation",
      );
      return;
    }
    const halt = { unknown: false };
    let outcome: PiGuideChildOutcome;
    try {
      const context: GuideRunContext = {
        run,
        generation: pass.generation,
        cancelEpoch: pass.cancelEpoch,
      };
      const staging = new GuideRequestStaging(
        this.authority.guide,
        this.artifacts,
        this.now,
      );
      outcome = await this.invoker.invokeGuide({
        profileId: run.profileId,
        sessionId: request.sessionId,
        model: request.selection.model,
        reasoning: request.reasoning,
        language: request.selection.language,
        evidence: pass.evidence,
        identity: {
          runId: run.runId,
          generation: pass.generation,
          cancelEpoch: pass.cancelEpoch,
          connection: randomBytes(18).toString("base64url"),
        },
        handler: async (frame) => {
          // After one unknown outcome nothing further is recorded or permitted on this connection.
          if (halt.unknown) return { status: "unknown" };
          const answered = await this.route(context, staging, frame);
          if (answered.status === "unknown") halt.unknown = true;
          return answered;
        },
        signal: controller.signal,
      });
    } finally {
      permit.value.release();
    }
    if (this.stopping.has(run.runId)) return;
    await this.conclusion.conclude(
      pass,
      halt.unknown ? uncertain(outcome) : outcome,
      controller,
      baseline,
    );
  }

  private route(
    context: GuideRunContext,
    staging: GuideRequestStaging,
    frame: GuideChildFrame,
  ): Promise<GuideAppOutcome> {
    switch (frame.kind) {
      case "tool":
        return this.operations.handle(context, frame.call);
      case "request_open":
        return Promise.resolve(staging.open(frame.totalBytes));
      case "request_chunk":
        return Promise.resolve(staging.chunk(frame));
      case "request_commit":
        return staging.commit(context, frame);
    }
  }
}

/** After an unknown mutation or admission the child's own report cannot prove its effects known. */
function uncertain(outcome: PiGuideChildOutcome): PiGuideChildOutcome {
  return outcome._tag === "failed"
    ? { ...outcome, effectKnown: false }
    : { _tag: "failed", reason: "execution_failed", effectKnown: false };
}
