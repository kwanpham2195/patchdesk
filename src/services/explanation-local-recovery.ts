import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import { guideRuntimeCodec } from "#src/domain/guide-result";
import { walkthroughRuntimeCodec } from "#src/domain/walkthrough-result";
import { guidePreparedInputCodec } from "#src/domain/guide-preparation";
import { walkthroughPreparedInputCodec } from "#src/domain/walkthrough-preparation";
import {
  insightAuthorizationCodec,
  insightBindingCodec,
  insightDomainIdentityCodec,
  insightProvenanceCodec,
  insightRunPolicyCodec,
} from "#src/domain/insight-run-binding-contract";
import { parseReviewSessionId } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import type { GuidePass } from "./guide-result-publication";
import type { ExplanationDeadline } from "./explanation-producer";
import type { ExplanationPreparationService } from "./explanation-preparation-service";
import type { InsightSlotAuthority } from "./insight-slot-authority";
import type { InsightSlotKey } from "./insight-slot-records";
import {
  nativeTurnStatus,
  nativePreflightMayOwnProcess,
} from "./native-explanation-turns";

/** Reconstructs only a frozen, ceased native pass. It never creates a producer, Authorization or generation. */
export async function recoverNativeExplanationPass(
  artifacts: InsightArtifactStore,
  authority: InsightSlotAuthority,
  preparation: ExplanationPreparationService,
  key: InsightSlotKey,
  owned: Pick<Map<string, unknown>, "has" | "delete">,
): Promise<
  Result<
    | { readonly pass: GuidePass; readonly deadline: ExplanationDeadline }
    | undefined,
    "storage_unavailable"
  >
> {
  const active = await authority.status.activeRun(key);
  if (active._tag === "err") return err("storage_unavailable");
  const run = active.value;
  if (run === undefined) return ok(undefined);
  const read = await authority.explanation.produce(run, async () =>
    ok(undefined),
  );
  if (read._tag === "err") return err("storage_unavailable");
  const { state } = read.value;
  if (
    state.status === "running" ||
    state.status === "paused" ||
    state.status === "cancelling"
  ) {
    const preflight = await nativePreflightMayOwnProcess(
      artifacts,
      { run },
      state,
    );
    if (preflight._tag === "err") return err("storage_unavailable");
    if (preflight.value) return ok(undefined);
  }
  if (
    owned.has(run.runId) &&
    state.status !== "paused" &&
    state.status !== "cancelling"
  )
    return ok(undefined);
  if (
    state.nativeExecution === undefined ||
    state.nativeExecution.starts.count === 0 ||
    (state.status !== "running" &&
      state.status !== "paused" &&
      state.status !== "cancelling")
  )
    return ok(undefined);
  const native = await nativeTurnStatus(artifacts, { run }, state);
  if (native._tag === "err") return err("storage_unavailable");
  if (!native.value.ceased) return ok(undefined);
  owned.delete(run.runId);
  if (state.status === "cancelling") return ok(undefined);
  const runtimeRef =
    key.type === "guide" ? state.guideRuntime : state.walkthroughRuntime;
  const preparedRef =
    key.type === "guide"
      ? state.guidePreparation
      : state.walkthroughPreparation;
  if (runtimeRef === undefined || preparedRef === undefined)
    return err("storage_unavailable");
  const { profileId, reviewId } = key;
  const runtime =
    key.type === "guide"
      ? await artifacts.readObject(
          profileId,
          reviewId,
          guideRuntimeCodec,
          runtimeRef,
        )
      : await artifacts.readObject(
          profileId,
          reviewId,
          walkthroughRuntimeCodec,
          runtimeRef,
        );
  if (runtime._tag === "err") return err("storage_unavailable");
  if (runtime.value.frozen === null) return ok(undefined);
  const [authorization, binding, policy] = await Promise.all([
    artifacts.readObject(
      profileId,
      reviewId,
      insightAuthorizationCodec,
      state.authorization,
    ),
    artifacts.readObject(
      profileId,
      reviewId,
      insightBindingCodec,
      state.binding,
    ),
    artifacts.readObject(
      profileId,
      reviewId,
      insightRunPolicyCodec,
      state.policy,
    ),
  ]);
  if (
    authorization._tag === "err" ||
    binding._tag === "err" ||
    policy._tag === "err"
  )
    return err("storage_unavailable");
  const [selection, identity, prepared] = await Promise.all([
    artifacts.readObject(
      profileId,
      reviewId,
      insightProvenanceCodec,
      authorization.value.selection,
    ),
    artifacts.readObject(
      profileId,
      reviewId,
      insightDomainIdentityCodec,
      binding.value.identity,
    ),
    key.type === "guide"
      ? artifacts.readObject(
          profileId,
          reviewId,
          guidePreparedInputCodec,
          preparedRef,
        )
      : artifacts.readObject(
          profileId,
          reviewId,
          walkthroughPreparedInputCodec,
          preparedRef,
        ),
  ]);
  if (
    selection._tag === "err" ||
    identity._tag === "err" ||
    prepared._tag === "err" ||
    selection.value.provider === "pi"
  )
    return err("storage_unavailable");
  const store = new InsightResultStore(artifacts, profileId, reviewId);
  const [sessionText, model] = await Promise.all([
    store.readText(identity.value.sessionId, 4096),
    store.readText(selection.value.model, 4096),
  ]);
  if (sessionText._tag === "err" || model._tag === "err")
    return err("storage_unavailable");
  const session = parseReviewSessionId(sessionText.value);
  if (session._tag === "err") return err("storage_unavailable");
  const evidence = await preparation.evidenceReference(
    prepared.value,
    session.value,
    run,
  );
  if (evidence === undefined) return err("storage_unavailable");
  const marked = await authority.explanation.produce(
    run,
    async ({ state: current }) =>
      current.generation === state.generation &&
      current.cancelEpoch === state.cancelEpoch &&
      current.status === state.status &&
      current.nativeExecution?.observations.root.hash ===
        state.nativeExecution?.observations.root.hash &&
      (key.type === "guide"
        ? current.guideRuntime?.hash
        : current.walkthroughRuntime?.hash) === runtimeRef.hash
        ? ok({ status: "running", clearFailure: true })
        : err("not_active" as const),
  );
  if (marked._tag === "err") return err("storage_unavailable");
  return ok({
    deadline: policy.value,
    pass: {
      run,
      generation: state.generation,
      cancelEpoch: state.cancelEpoch,
      evidence,
      request: {
        profileId,
        reviewId,
        revision: "",
        sessionId: session.value,
        expectedHash: binding.value.patchHash,
        headSha: binding.value.headSha,
        baseSha: binding.value.baseSha,
        reasoning: selection.value.reasoning,
        selection: {
          provider: selection.value.provider,
          model: model.value,
          reasoning: selection.value.reasoning,
          language: selection.value.language,
        },
      },
    },
  });
}
