import { randomUUID } from "node:crypto";
import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { walkthroughRuntimeCodec } from "#src/domain/walkthrough-result";
import { walkthroughPreparedInputCodec } from "#src/domain/walkthrough-preparation";
import {
  insightAuthorizationCodec,
  insightRunPolicyCodec,
  insightBindingCodec,
  insightDomainIdentityCodec,
  insightProvenanceCodec,
  insightFailureRecordCodec,
} from "#src/domain/insight-run-binding-contract";
import { parseReviewSessionId, type IsoTimestamp } from "#src/domain/ids";
import { encodeInsightArtifactCanonicalJson } from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import type {
  GuideResumeRequest,
  GuideResumeFailure,
} from "./guide-generation-resume";
import type { GuideStartRequest } from "./guide-generation-service";
import type { InsightSlotAuthority } from "./insight-slot-authority";
import type { InsightRunRef } from "./insight-slot-records";
import type { ExplanationPreparationService } from "./explanation-preparation-service";
import type { InsightEvidenceReference } from "./insight-evidence-reference";
import { nativeTurnStatus } from "./native-explanation-turns";

/** A resumed generation uses the original exact deadline, evidence, selection and spent/unknown dispatch history. */
export type WalkthroughPass = {
  readonly run: InsightRunRef;
  readonly request: GuideStartRequest;
  readonly generation: number;
  readonly cancelEpoch: number;
  readonly evidence: InsightEvidenceReference;
  readonly deadlineAt: string;
};

/** Explicit Resume checks the acknowledged newest request, never replays it, and stages a new empty generation. */
export class WalkthroughResumePreparation {
  constructor(
    private readonly artifacts: InsightArtifactStore,
    private readonly authority: InsightSlotAuthority,
    private readonly preparation: ExplanationPreparationService,
    private readonly now: () => IsoTimestamp,
  ) {}

  /** Advances a paused run only under a fresh represented-input and deadline guard. */
  async resume(
    request: GuideResumeRequest,
  ): Promise<Result<WalkthroughPass, GuideResumeFailure>> {
    if (!("transport" in request)) return err("invalid");
    const { profileId, reviewId } = request;
    const active = await this.authority.status.activeRun({
      profileId,
      reviewId,
      type: "walkthrough",
    });
    if (active._tag === "err") return err("storage");
    const run = active.value;
    if (run === undefined || run.runId !== request.runId)
      return err("not_found");
    const read = await this.authority.explanation.produce(run, async () =>
      ok(undefined),
    );
    if (read._tag === "err") return err("storage");
    const { state } = read.value;
    if (
      state.status !== "paused" ||
      state.generation !== request.expectedGeneration ||
      state.walkthroughPreparation === undefined ||
      state.walkthroughRuntime === undefined ||
      state.failure === null
    )
      return err("stale");
    const store = new InsightResultStore(this.artifacts, profileId, reviewId);
    const native =
      state.nativeExecution === undefined
        ? undefined
        : await nativeTurnStatus(this.artifacts, { run }, state);
    if (state.nativeExecution === undefined) return err("stale");
    if (
      native?._tag !== "ok" ||
      native.value.generation !== state.generation ||
      !native.value.ceased ||
      request.acknowledgedStarts !== state.nativeExecution?.starts.count ||
      request.lastStartHash !== native.value.newest.hash
    )
      return err("stale");
    const policy = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightRunPolicyCodec,
      state.policy,
    );
    if (policy._tag === "err") return err("storage");
    if (
      policy.value.kind !== "walkthrough-deadline/1" ||
      Date.parse(this.now()) >= Date.parse(policy.value.deadlineAt)
    )
      return err("stale");
    const deadlineAt = policy.value.deadlineAt;
    const [previous, binding, prepared, failure] = await Promise.all([
      this.artifacts.readObject(
        profileId,
        reviewId,
        insightAuthorizationCodec,
        state.authorization,
      ),
      this.artifacts.readObject(
        profileId,
        reviewId,
        insightBindingCodec,
        state.binding,
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
        insightFailureRecordCodec,
        state.failure,
      ),
    ]);
    if (
      previous._tag === "err" ||
      binding._tag === "err" ||
      prepared._tag === "err" ||
      failure._tag === "err"
    )
      return err("storage");
    if (
      binding.value.kind !== "walkthrough" ||
      encodeInsightArtifactCanonicalJson(previous.value.policy) !==
        encodeInsightArtifactCanonicalJson(state.policy) ||
      failure.value.code !== "paid_dispatch_unknown" ||
      failure.value.recovery !== "resume_required"
    )
      return err("stale");
    const [identity, selection] = await Promise.all([
      this.artifacts.readObject(
        profileId,
        reviewId,
        insightDomainIdentityCodec,
        binding.value.identity,
      ),
      this.artifacts.readObject(
        profileId,
        reviewId,
        insightProvenanceCodec,
        previous.value.selection,
      ),
    ]);
    if (identity._tag === "err" || selection._tag === "err")
      return err("storage");
    const [sessionText, model] = await Promise.all([
      store.readText(identity.value.sessionId, 4096),
      store.readText(selection.value.model, 4096),
    ]);
    if (sessionText._tag === "err" || model._tag === "err")
      return err("storage");
    const session = parseReviewSessionId(sessionText.value);
    const reasoning = selection.value.reasoning;
    if (session._tag === "err" || selection.value.provider === "pi")
      return err("invalid");
    const start: GuideStartRequest = {
      profileId,
      reviewId,
      revision: "",
      sessionId: session.value,
      expectedHash: binding.value.patchHash,
      headSha: binding.value.headSha,
      baseSha: binding.value.baseSha,
      selection: {
        provider: selection.value.provider,
        model: model.value,
        reasoning,
        language: selection.value.language,
      },
      reasoning,
    };
    const evidence = await this.preparation.evidenceReference(
      prepared.value,
      session.value,
      run,
    );
    if (evidence === undefined) return err("storage");
    const [disposition, receipts] = await Promise.all([
      this.artifacts.writeTextRoot(
        profileId,
        reviewId,
        `Acknowledged ${request.acknowledgedStarts} native starts, newest ${request.lastStartHash}; generation ${state.generation + 1} may spend again and cannot recover the previous response.`,
      ),
      store.emptyIndex("WalkthroughReceipt1"),
    ]);
    if (disposition._tag === "err" || receipts._tag === "err")
      return err("storage");
    const [authorization, runtime] = await Promise.all([
      this.artifacts.writeObject(
        profileId,
        reviewId,
        insightAuthorizationCodec,
        {
          ...previous.value,
          id: randomUUID(),
          kind: "resume",
          previous: previous.value.id,
          authorizedAt: this.now(),
          possibleSpendAcknowledged: true,
          unknownDispatchDisposition: disposition.value,
        },
      ),
      this.artifacts.writeObject(profileId, reviewId, walkthroughRuntimeCodec, {
        preparation: state.walkthroughPreparation,
        phase: "building",
        receipts: receipts.value,
        frozen: null,
        result: null,
      }),
    ]);
    if (authorization._tag === "err" || runtime._tag === "err")
      return err("storage");
    const resumed = await this.authority.explanation.resume(
      run,
      {
        generation: state.generation,
        native: {
          startCount: state.nativeExecution.starts.count,
          startsRoot: state.nativeExecution.starts.root.hash,
          observationsRoot: state.nativeExecution.observations.root.hash,
        },
        authorization: authorization.value,
        walkthroughRuntime: runtime.value,
      },
      async () => {
        if (Date.parse(this.now()) >= Date.parse(deadlineAt))
          return err("stale" as const);
        const represented = await this.preparation.representedInputs(
          start,
          start,
        );
        return represented._tag === "ok"
          ? ok(undefined)
          : err("stale" as const);
      },
    );
    return resumed._tag === "err"
      ? err(
          resumed.error === "not_active" || resumed.error === "stale"
            ? "stale"
            : "storage",
        )
      : ok({
          run,
          request: start,
          evidence,
          generation: state.generation + 1,
          cancelEpoch: state.cancelEpoch + 1,
          deadlineAt,
        });
  }
}
