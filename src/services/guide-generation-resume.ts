import { randomUUID } from "node:crypto";

import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { guidePreparedInputCodec } from "#src/domain/guide-preparation";
import {
  guideDispatchIntentCodec,
  guideRuntimeCodec,
} from "#src/domain/guide-result";
import {
  parseReviewSessionId,
  type IsoTimestamp,
  type ReviewId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import { insightArtifactIdSchema } from "#src/domain/insight-artifact-scalars";
import {
  insightAuthorizationCodec,
  insightBindingCodec,
  insightDomainIdentityCodec,
  insightFailureRecordCodec,
  insightProvenanceCodec,
} from "#src/domain/insight-run-binding-contract";
import { err, ok, type Result } from "#src/domain/result";
import * as v from "valibot";
import type { GuidePass } from "./guide-result-publication";
import type { ExplanationResumeInput } from "./explanation-run-transactions";
import type { GuidePreparationService } from "./guide-preparation-service";
import type { InsightSlotAuthority } from "./insight-slot-authority";

/** The explicit acknowledgment a Resume carries: the run, generation and the unresolved dispatch evidence it names. */
export type GuideResumeRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly runId: string;
  readonly expectedGeneration: number;
  /** How many recorded provider requests the maintainer acknowledges as possibly sent. */
  readonly acknowledgedDispatches: number;
  /** SHA-256 of the newest of those requests, so the acknowledgment names real evidence, not just a count. */
  readonly lastRequestHash: string;
};

export type GuideResumeFailure =
  | "not_found"
  | "stale"
  | "busy"
  | "invalid"
  | "storage";

/** How a refused Resume reads in the coordinator's failure vocabulary. */
export function guideResumeFailure(
  reason: GuideResumeFailure,
):
  | "not_found"
  | "stale_request"
  | "already_running"
  | "not_available"
  | "storage_unavailable" {
  switch (reason) {
    case "not_found":
      return "not_found";
    case "stale":
      return "stale_request";
    case "busy":
      return "already_running";
    case "invalid":
      return "not_available";
    case "storage":
      return "storage_unavailable";
  }
}

const MAX_TEXT_BYTES = 4_096;

/**
 * Reads the paused run's durable evidence and stages everything a Resume records before any lock: the `resume`
 * Authorization (previous authorization, possible spend acknowledged, the unknown-dispatch disposition) and the next
 * generation's empty GuideRuntime1. It reads the unresolved dispatch intents but never replays or reinterprets one:
 * the new pass is a new generation from the same verified prepared inputs, and the earlier receipts, dispatch
 * intents, usage and published output stay as they are.
 */
export class GuideResumePreparation {
  constructor(
    private readonly artifacts: InsightArtifactStore,
    private readonly authority: InsightSlotAuthority,
    private readonly preparation: GuidePreparationService,
    private readonly now: () => IsoTimestamp,
  ) {}

  async prepare(
    request: GuideResumeRequest,
  ): Promise<
    Result<
      { readonly pass: GuidePass; readonly resume: ExplanationResumeInput },
      GuideResumeFailure
    >
  > {
    const { profileId, reviewId } = request;
    const active = await this.authority.status.activeRun({
      profileId,
      reviewId,
      type: "guide",
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
      state.failure === null ||
      state.guidePreparation === undefined ||
      state.guideRuntime === undefined ||
      state.generation !== request.expectedGeneration ||
      state.dispatches.count !== request.acknowledgedDispatches ||
      state.dispatches.count === 0
    )
      return err("stale");
    const store = new InsightResultStore(this.artifacts, profileId, reviewId);
    const [failure, newest, binding, previous] = await Promise.all([
      this.artifacts.readObject(
        profileId,
        reviewId,
        insightFailureRecordCodec,
        state.failure,
      ),
      store.readIndex(
        "GuideDispatchIntent1",
        state.dispatches,
        state.dispatches.count - 1,
        1,
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
        insightAuthorizationCodec,
        state.authorization,
      ),
    ]);
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the preceding batch occupies all four authority read permits
    const prepared = await this.artifacts.readObject(
      profileId,
      reviewId,
      guidePreparedInputCodec,
      state.guidePreparation,
    );
    if (
      failure._tag === "err" ||
      newest._tag === "err" ||
      binding._tag === "err" ||
      previous._tag === "err" ||
      prepared._tag === "err"
    )
      return err("storage");
    if (
      failure.value.code !== "paid_dispatch_unknown" ||
      failure.value.recovery !== "resume_required"
    )
      return err("stale");
    const entry = newest.value[0];
    const intent =
      entry === undefined
        ? undefined
        : await this.artifacts.readObject(
            profileId,
            reviewId,
            guideDispatchIntentCodec,
            entry.value,
          );
    if (intent === undefined || intent._tag === "err") return err("storage");
    if (intent.value.requestHash !== request.lastRequestHash)
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
    const [sessionId, model] = await Promise.all([
      store.readText(identity.value.sessionId, MAX_TEXT_BYTES),
      store.readText(selection.value.model, MAX_TEXT_BYTES),
    ]);
    const reasoning = selection.value.reasoning;
    if (sessionId._tag === "err" || model._tag === "err") return err("storage");
    if (
      selection.value.provider !== "pi" ||
      (reasoning !== "low" && reasoning !== "medium" && reasoning !== "high")
    )
      return err("invalid");
    const parsedSession = parseReviewSessionId(sessionId.value);
    if (parsedSession._tag === "err") return err("invalid");
    const disposition = await this.artifacts.writeTextRoot(
      profileId,
      reviewId,
      `Maintainer acknowledged ${state.dispatches.count} recorded request(s) of generation ${state.generation} whose responses are unknown, newest ${request.lastRequestHash}. A new generation ${state.generation + 1} starts from the same prepared inputs; it does not recover those responses.`,
    );
    if (disposition._tag === "err") return err("storage");
    const [authorization, receipts] = await Promise.all([
      this.artifacts.writeObject(
        profileId,
        reviewId,
        insightAuthorizationCodec,
        {
          id: v.parse(insightArtifactIdSchema, randomUUID()),
          runId: previous.value.runId,
          kind: "resume",
          policy: previous.value.policy,
          selection: previous.value.selection,
          authorizedAt: this.now(),
          previous: previous.value.id,
          possibleSpendAcknowledged: true,
          unknownDispatchDisposition: disposition.value,
        },
      ),
      store.emptyIndex("GuideReceipt1"),
    ]);
    if (authorization._tag === "err" || receipts._tag === "err")
      return err("storage");
    const runtime = await this.artifacts.writeObject(
      profileId,
      reviewId,
      guideRuntimeCodec,
      {
        preparation: state.guidePreparation,
        phase: "building",
        receipts: receipts.value,
        frozen: null,
        result: null,
      },
    );
    if (runtime._tag === "err") return err("storage");
    const evidence = await this.preparation.evidenceReference(
      prepared.value,
      parsedSession.value,
      run,
    );
    if (evidence === undefined) return err("storage");
    return ok({
      pass: {
        request: {
          profileId,
          reviewId,
          revision: "",
          sessionId: parsedSession.value,
          expectedHash: binding.value.patchHash,
          selection: {
            provider: "pi",
            model: model.value,
            reasoning,
            language: selection.value.language,
          },
          headSha: binding.value.headSha,
          baseSha: binding.value.baseSha,
          reasoning,
        },
        run,
        generation: state.generation,
        cancelEpoch: state.cancelEpoch,
        evidence,
      },
      resume: {
        generation: state.generation,
        dispatchCount: state.dispatches.count,
        authorization: authorization.value,
        guideRuntime: runtime.value,
      },
    });
  }
}
