import type { ExplanationFailureDiagnostic } from "#src/domain/insight-failure-diagnostic";
import type { InsightActivityEvent } from "#src/adapters/codex/codex-activity";
import { definedProps } from "#src/domain/defined-props";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import { InsightSlotStore } from "#src/adapters/storage/insight-slot-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { walkthroughPreparedInputCodec } from "#src/domain/walkthrough-preparation";
import { walkthroughRuntimeCodec } from "#src/domain/walkthrough-result";
import type { GuidePreparationFailureReason } from "#src/domain/guide-preparation";
import { parseInsightRunId, type IsoTimestamp } from "#src/domain/ids";
import type { InsightArtifactReference } from "#src/domain/insight-artifact-scalars";
import type { InsightFailureRecord } from "#src/domain/insight-run-binding-contract";
import { err, ok, type Result } from "#src/domain/result";
import type { InsightResourceBundle } from "./insight-resource-bundle";
import type { InsightSlotAuthority } from "./insight-slot-authority";
import { isTerminalStatus, type InsightRunRef } from "./insight-slot-records";
import type {
  ExplanationPreparationService,
  AdmittedRun,
} from "./explanation-preparation-service";
import type { GuideStartRequest } from "./guide-generation-service";
import type {
  GuideResumeRequest,
  GuideResumeFailure,
} from "./guide-generation-resume";
import type {
  ExplanationProducers,
  ExplanationProducerOutcome,
} from "./explanation-producer";
import {
  explanationStartCount,
  nativeTurnStatus,
  nativePreflightMayOwnProcess,
} from "./native-explanation-turns";
import {
  slotPointerDigest,
  type GuideBaseline,
} from "./guide-result-publication";
import { stageWalkthroughDeadline } from "./walkthrough-generation-policy";
import {
  WalkthroughResumePreparation,
  type WalkthroughPass,
} from "./walkthrough-generation-resume";
import { WalkthroughProducerPass } from "./walkthrough-producer-pass";
import { WalkthroughPublisher } from "./walkthrough-result-publication";
import { hasExplanationProducer } from "./explanation-producer";
import { explanationFailureDiagnostic } from "./explanation-producer";
import { recoverNativeExplanationPass } from "./explanation-local-recovery";
import type { InsightSlotKey } from "./insight-slot-records";

/** Owns the admitted producer through durable tools, validation and guarded publication. */
export class WalkthroughGenerationService {
  private readonly artifacts: InsightArtifactStore;
  private readonly slots: InsightSlotStore;
  private readonly producer: WalkthroughProducerPass;
  private readonly publisher: WalkthroughPublisher;
  private readonly resumption: WalkthroughResumePreparation;
  private readonly owned: ReturnType<
    InsightResourceBundle["ownership"]["forScope"]
  >;
  private readonly stopping = new Set<string>();

  constructor(
    private readonly destination: PatchdeskPaths,
    private readonly preparation: ExplanationPreparationService,
    private readonly authority: InsightSlotAuthority,
    private readonly resources: InsightResourceBundle,
    private readonly producers: ExplanationProducers,
    private readonly now: () => IsoTimestamp,
    onActivity?: (run: InsightRunRef, event: InsightActivityEvent) => void,
  ) {
    this.artifacts = new InsightArtifactStore(
      destination,
      resources.authorityReader,
    );
    this.slots = new InsightSlotStore(destination, resources.authorityReader);
    this.producer = new WalkthroughProducerPass(
      this.artifacts,
      authority,
      producers,
      now,
      onActivity,
    );
    this.publisher = new WalkthroughPublisher(
      authority.explanation,
      this.artifacts,
      now,
    );
    this.resumption = new WalkthroughResumePreparation(
      this.artifacts,
      authority,
      preparation,
      now,
    );
    this.owned = resources.ownership.forScope(destination.dataDirectory());
  }

  /** Returns admitted identity and a joinable completion, without exposing a prepared-only public operation. */
  async start(
    request: GuideStartRequest,
  ): Promise<
    Result<
      { readonly run: AdmittedRun; readonly completion: Promise<void> },
      GuidePreparationFailureReason
    >
  > {
    if (
      request.selection.reasoning !== request.reasoning ||
      !hasExplanationProducer(this.producers, request.selection.provider)
    )
      return err("invalid_source");
    const operation = this.preparation.begin(request, "walkthrough");
    const admitted = await operation.admission;
    if (admitted._tag === "err") return admitted;
    const run = admitted.value;
    const controller = new AbortController();
    const completion = this.finishDrive(run, async () => {
      const prepared = await operation.result;
      if (prepared._tag === "err") return;
      const entry = this.owned.get(run.runId);
      if (entry === undefined) return;
      this.owned.set(run.runId, { ...entry, controller, preparing: false });
      await this.begin(request, run, prepared.value.root, controller);
    });
    this.resources.work.track(() => {
      this.stopping.add(run.runId);
      operation.abort();
      controller.abort();
    }, completion);
    return ok({ run, completion });
  }

  /** Explicitly acknowledges uncertain paid effects, preserving the existing deadline and history. */
  async resume(
    request: GuideResumeRequest,
  ): Promise<
    Result<{ readonly completion: Promise<void> }, GuideResumeFailure>
  > {
    if (!("transport" in request)) return err("invalid");
    const recovered = await this.recover({
      profileId: request.profileId,
      reviewId: request.reviewId,
      type: "walkthrough",
    });
    if (recovered._tag === "err") return err("storage");
    if (this.owned.has(request.runId)) {
      const active = await this.authority.status.activeRun({
        profileId: request.profileId,
        reviewId: request.reviewId,
        type: "walkthrough",
      });
      if (
        active._tag === "err" ||
        active.value === undefined ||
        active.value.runId !== request.runId
      )
        return err("busy");
      const snapshot = await this.authority.explanation.produce(
        active.value,
        async () => ok(undefined),
      );
      if (
        snapshot._tag === "err" ||
        snapshot.value.state.status !== "paused" ||
        snapshot.value.state.nativeExecution === undefined
      )
        return err("busy");
      const native = await nativeTurnStatus(
        this.artifacts,
        { run: active.value },
        snapshot.value.state,
      );
      const preflight = await nativePreflightMayOwnProcess(
        this.artifacts,
        { run: active.value },
        snapshot.value.state,
      );
      if (preflight._tag === "err" || preflight.value) return err("busy");
      if (native._tag === "err" || !native.value.ceased) return err("busy");
      this.owned.delete(request.runId);
    }
    const resumed = await this.resumption.resume(request);
    if (resumed._tag === "err") return resumed;
    const pass = resumed.value;
    const id = parseInsightRunId(pass.run.runId);
    if (id._tag === "err") return err("invalid");
    const controller = new AbortController();
    this.owned.set(pass.run.runId, {
      ...pass.run,
      runId: id.value,
      controller,
      preparing: false,
    });
    const completion = this.finishDrive(pass.run, () =>
      this.runPass(pass, controller),
    );
    this.resources.work.track(() => {
      this.stopping.add(pass.run.runId);
      controller.abort();
    }, completion);
    return ok({ completion });
  }

  /** Frozen receipts can finish validation and publication after reopen without spawning a CLI. */
  async recover(
    key: InsightSlotKey,
  ): Promise<Result<void, "storage_unavailable">> {
    if (key.type !== "walkthrough") return ok(undefined);
    const planned = await recoverNativeExplanationPass(
      this.artifacts,
      this.authority,
      this.preparation,
      key,
      this.owned,
    );
    if (planned._tag === "err") return planned;
    if (planned.value === undefined) return ok(undefined);
    if (planned.value.deadline.kind !== "walkthrough-deadline/1")
      return err("storage_unavailable");
    const pass: WalkthroughPass = {
      ...planned.value.pass,
      deadlineAt: planned.value.deadline.deadlineAt,
    };
    const slot = await this.slots.readCurrent(
      key.profileId,
      key.reviewId,
      "walkthrough",
    );
    if (slot._tag === "err" || slot.value === undefined)
      return err("storage_unavailable");
    const baseline = {
      version: slot.value.record.version,
      digest: slotPointerDigest(slot.value),
    };
    const controller = new AbortController();
    const id = parseInsightRunId(pass.run.runId);
    if (id._tag === "err") return err("storage_unavailable");
    this.owned.set(pass.run.runId, {
      ...pass.run,
      runId: id.value,
      controller,
      preparing: false,
    });
    const completion = this.finishDrive(pass.run, () =>
      this.conclude(pass, { _tag: "finished" }, controller, baseline, false),
    );
    this.resources.work.track(() => {
      this.stopping.add(pass.run.runId);
      controller.abort();
    }, completion);
    await completion;
    return ok(undefined);
  }

  private async finishDrive(
    run: InsightRunRef,
    drive: () => Promise<void>,
  ): Promise<void> {
    try {
      await drive();
    } catch {
      /* Unknown storage outcomes keep ownership for cancel/recovery. */
    } finally {
      const shutdown = this.stopping.delete(run.runId);
      const state = await this.authority.explanation.produce(run, async () =>
        ok(undefined),
      );
      const native =
        state._tag === "ok" &&
        state.value.state.nativeExecution !== undefined &&
        state.value.state.status === "paused"
          ? await nativeTurnStatus(this.artifacts, { run }, state.value.state)
          : undefined;
      const preflight =
        state._tag === "ok" && state.value.state.status === "paused"
          ? await nativePreflightMayOwnProcess(
              this.artifacts,
              { run },
              state.value.state,
            )
          : ok(false);
      if (
        shutdown ||
        (state._tag === "ok" &&
          preflight._tag === "ok" &&
          !preflight.value &&
          (native === undefined ||
            (native._tag === "ok" && native.value.ceased)) &&
          (isTerminalStatus(state.value.state.status) ||
            state.value.state.status === "complete" ||
            state.value.state.status === "paused"))
      )
        this.owned.delete(run.runId);
    }
  }

  private async begin(
    request: GuideStartRequest,
    run: AdmittedRun,
    root: InsightArtifactReference,
    controller: AbortController,
  ): Promise<void> {
    const { profileId, reviewId } = run;
    const [prepared, snapshot] = await Promise.all([
      this.artifacts.readObject(
        profileId,
        reviewId,
        walkthroughPreparedInputCodec,
        root,
      ),
      this.authority.explanation.produce(run, async () => ok(undefined)),
    ]);
    if (prepared._tag === "err" || snapshot._tag === "err") {
      await this.settle(run, "storage_unavailable", "generation");
      return;
    }
    if (prepared.value.hunks.count === 0) {
      await this.settle(run, "validation_rejected", "capture");
      return;
    }
    const evidence = await this.preparation.evidenceReference(
      prepared.value,
      request.sessionId,
      run,
    );
    if (evidence === undefined) {
      await this.settle(run, "evidence_missing", "capture");
      return;
    }
    const policy = await stageWalkthroughDeadline(
      this.artifacts,
      run,
      snapshot.value.state.authorization,
      prepared.value,
      this.now(),
    );
    const store = new InsightResultStore(this.artifacts, profileId, reviewId);
    const [receipts, dispatches] = await Promise.all([
      store.emptyIndex("WalkthroughReceipt1"),
      store.emptyIndex("WalkthroughDispatchIntent1"),
    ]);
    if (
      policy._tag === "err" ||
      receipts._tag === "err" ||
      dispatches._tag === "err"
    ) {
      await this.settle(run, "storage_unavailable", "generation");
      return;
    }
    const runtime = await this.artifacts.writeObject(
      profileId,
      reviewId,
      walkthroughRuntimeCodec,
      {
        preparation: root,
        phase: "building",
        receipts: receipts.value,
        frozen: null,
        result: null,
      },
    );
    if (runtime._tag === "err") {
      await this.settle(run, "storage_unavailable", "generation");
      return;
    }
    const began = await this.authority.explanation.begin(
      {
        ...run,
        walkthroughRuntime: runtime.value,
        dispatches: dispatches.value,
        policy: policy.value.policy,
        authorization: policy.value.authorization,
      },
      () => this.preparation.representedInputs(request, request),
    );
    if (began._tag === "err") {
      if (began.error === "stale_source")
        await this.settle(run, "evidence_changed", "generation");
      return;
    }
    await this.runPass(
      {
        run,
        request,
        generation: run.generation,
        cancelEpoch: run.cancelEpoch,
        evidence,
        deadlineAt: policy.value.deadlineAt,
      },
      controller,
    );
  }

  private async runPass(
    pass: WalkthroughPass,
    controller: AbortController,
  ): Promise<void> {
    const { run } = pass;
    const slot = await this.slots.readCurrent(
      run.profileId,
      run.reviewId,
      "walkthrough",
    );
    if (slot._tag === "err" || slot.value === undefined) {
      await this.settle(run, "storage_unavailable", "generation");
      return;
    }
    const baseline = {
      version: slot.value.record.version,
      digest: slotPointerDigest(slot.value),
    };
    const permit = await this.resources.permits.generation(
      `walkthrough-generation:${run.profileId}:${run.reviewId}`,
      controller.signal,
    );
    if (permit._tag === "err") {
      if (!this.stopping.has(run.runId))
        await this.settle(run, "cancelled", "generation");
      return;
    }
    let generated: Awaited<ReturnType<WalkthroughProducerPass["run"]>>;
    try {
      generated = await this.producer.run(pass, controller);
    } finally {
      permit.value.release();
    }
    if (this.stopping.has(run.runId)) return;
    await this.conclude(
      pass,
      generated.outcome,
      controller,
      baseline,
      generated.expired,
    );
  }

  private async conclude(
    pass: WalkthroughPass,
    outcome: ExplanationProducerOutcome,
    controller: AbortController,
    baseline: GuideBaseline,
    expired: boolean,
  ): Promise<void> {
    const { run } = pass;
    const read = await this.authority.explanation.produce(run, async () =>
      ok(undefined),
    );
    if (read._tag === "err") return;
    const { state } = read.value;
    if (
      state.generation !== pass.generation ||
      isTerminalStatus(state.status) ||
      state.status === "complete" ||
      state.status === "paused"
    )
      return;
    let nativeKnown = outcome._tag === "failed" && outcome.effectKnown;
    if (
      state.nativeExecution !== undefined &&
      state.nativeExecution.starts.count > 0
    ) {
      const native = await nativeTurnStatus(this.artifacts, { run }, state);
      if (
        native._tag === "err" ||
        (native.value.generation === state.generation && !native.value.ceased)
      ) {
        await this.authority.explanation.produce(
          run,
          async ({ state: current }) =>
            current.status === "running" &&
            current.generation === pass.generation &&
            current.cancelEpoch === pass.cancelEpoch
              ? ok({
                  status: "paused",
                  usageUnknown: true,
                  failure: {
                    code: "paid_dispatch_unknown",
                    phase: "generation",
                    recovery: "resume_required",
                  },
                })
              : ok(undefined),
        );
        return;
      }
      if (native.value.generation === state.generation)
        nativeKnown = native.value.known;
    }
    if (state.status === "cancelling" || controller.signal.aborted) {
      // Process cessation does not resolve an unknown tool mutation.
      if (!nativeKnown) return;
      await this.settle(run, "cancelled", "generation");
      return;
    }
    if (
      state.cancelEpoch !== pass.cancelEpoch ||
      state.walkthroughRuntime === undefined
    )
      return;
    const runtime = await this.artifacts.readObject(
      run.profileId,
      run.reviewId,
      walkthroughRuntimeCodec,
      state.walkthroughRuntime,
    );
    if (runtime._tag === "err") {
      await this.settle(run, "storage_unavailable", "validation");
      return;
    }
    if (runtime.value.frozen === null) {
      const diagnostic = explanationFailureDiagnostic(
        outcome,
        pass.request.selection.provider,
      );
      const preflight = await nativePreflightMayOwnProcess(
        this.artifacts,
        { run },
        state,
      );
      if (preflight._tag === "err") return;
      if (
        !nativeKnown ||
        (state.nativeExecution === undefined &&
          outcome._tag === "failed" &&
          !outcome.effectKnown)
      ) {
        await this.authority.explanation.produce(
          run,
          async ({ state: current }) =>
            current.status === "running" &&
            current.generation === pass.generation &&
            current.cancelEpoch === pass.cancelEpoch
              ? ok({
                  status: "paused",
                  ...definedProps({
                    usageUnknown:
                      explanationStartCount(current) > 0
                        ? (true as const)
                        : undefined,
                  }),
                  failure: {
                    code: preflight.value
                      ? "producer_unsettled"
                      : "paid_dispatch_unknown",
                    phase: "generation",
                    recovery: "resume_required",
                  },
                })
              : ok(undefined),
        );
      } else
        await this.settle(
          run,
          diagnostic === "unsupported_codex_version"
            ? "capability_unavailable"
            : expired
              ? "resource_exhausted"
              : "unresolved_work",
          "generation",
          diagnostic,
        );
      return;
    }
    let validatedRoot = state.walkthroughRuntime;
    let result = runtime.value.result;
    if (runtime.value.phase === "validating") {
      const validated = await this.resources.jobs.validateWalkthrough(
        {
          destinationRoot: this.destination.dataDirectory(),
          profileId: run.profileId,
          reviewId: run.reviewId,
          runId: run.runId,
          binding: state.binding,
          preparation: runtime.value.preparation,
          runtime: state.walkthroughRuntime,
          generation: pass.generation,
          cancelEpoch: pass.cancelEpoch,
        },
        { signal: controller.signal },
      );
      if (this.stopping.has(run.runId)) return;
      if (validated._tag === "err") {
        await this.settle(
          run,
          validated.error.reason === "aborted"
            ? "cancelled"
            : validated.error.reason === "rejected"
              ? "validation_rejected"
              : "storage_unavailable",
          "validation",
        );
        return;
      }
      const advanced = await this.artifacts.writeObject(
        run.profileId,
        run.reviewId,
        walkthroughRuntimeCodec,
        {
          ...runtime.value,
          phase: "validated",
          result: validated.value.result,
        },
      );
      if (advanced._tag === "err") {
        await this.settle(run, "storage_unavailable", "validation");
        return;
      }
      const marked = await this.authority.explanation.produce(
        run,
        async ({ state: current }) =>
          current.status === "running" &&
          current.generation === pass.generation &&
          current.cancelEpoch === pass.cancelEpoch &&
          current.walkthroughRuntime?.hash === state.walkthroughRuntime?.hash
            ? ok({ status: current.status, walkthroughRuntime: advanced.value })
            : err("not_active" as const),
      );
      if (marked._tag === "err") {
        if (marked.error === "not_active")
          await this.settle(run, "cancelled", "validation");
        return;
      }
      validatedRoot = advanced.value;
      result = validated.value.result;
    }
    if (result === null) {
      await this.settle(run, "validation_rejected", "validation");
      return;
    }
    const published = await this.publisher.publish(
      run,
      {
        generation: pass.generation,
        cancelEpoch: pass.cancelEpoch,
        runtime: validatedRoot,
        result,
        slotVersion: baseline.version,
        slotDigest: baseline.digest,
        sessionId: pass.request.sessionId,
        headSha: pass.request.headSha,
        baseSha: pass.request.baseSha,
        patchHash: pass.request.expectedHash,
      },
      async () => {
        const represented = await this.preparation.representedInputs(
          pass.request,
          pass.request,
        );
        return represented._tag === "ok"
          ? ok(undefined)
          : err("stale" as const);
      },
    );
    if (published._tag === "err")
      await this.settle(
        run,
        published.error === "stale"
          ? "evidence_changed"
          : "validation_rejected",
        "publication",
      );
  }

  private async settle(
    run: InsightRunRef,
    code: InsightFailureRecord["code"],
    phase: InsightFailureRecord["phase"],
    diagnostic?: ExplanationFailureDiagnostic,
  ): Promise<void> {
    await this.authority.settleRun({ ...run, code, phase, diagnostic });
  }
}
