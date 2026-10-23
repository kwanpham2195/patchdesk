import type { InsightFailureDiagnostic } from "#src/domain/insight-failure-diagnostic";
import { CODEX_EXPLANATION_VERSION_MESSAGE } from "#src/domain/codex-explanation-version";
import type { InsightActivitySink } from "#src/adapters/codex/codex-activity";
import type { ExplanationConnectionIdentity } from "#src/domain/explanation-channel";
import type {
  GuideChildFrame,
  GuideAppOutcome,
} from "#src/domain/guide-protocol";
import type {
  WalkthroughChildFrame,
  WalkthroughAppOutcome,
} from "#src/domain/walkthrough-protocol";
import type {
  InsightLanguage,
  InsightProvider,
  InsightReasoning,
} from "#src/domain/insight-provider";
import type { InsightArtifactReference } from "#src/domain/insight-artifact-scalars";
import type { NativeTurnEvent } from "#src/domain/native-explanation-turn";
import type { Result } from "#src/domain/result";
import type { InsightEvidenceReference } from "./insight-evidence-reference";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import {
  insightAuthorizationCodec,
  insightProvenanceCodec,
} from "#src/domain/insight-run-binding-contract";
import { ok } from "#src/domain/result";
import type { ExplanationRunTransactions } from "./explanation-run-transactions";
import type { GuidePass } from "./guide-result-publication";

/** Finish is accepted by the operation service, not inferred from this terminal report. */
export type ExplanationProducerOutcome =
  | { readonly _tag: "finished" }
  | (InsightFailureDiagnostic & {
      readonly _tag: "failed";
      readonly reason:
        | "cancelled"
        | "authentication_required"
        | "rate_limited"
        | "runtime_unavailable"
        | "timed_out"
        | "execution_failed"
        | "invalid_result"
        | "analysis_incomplete"
        | "evidence_unavailable"
        | "evidence_mismatch";
      readonly detail?: string;
      readonly effectKnown: boolean;
    });

/** Generation deadlines are explicit; discovery and individual RPC deadlines remain transport-owned. */
export type ExplanationDeadline =
  | { readonly kind: "no-total-deadline/1" }
  | { readonly kind: "walkthrough-deadline/1"; readonly deadlineAt: string };

/** Only the native adapter's fixed version preflight refusal can acquire this label. */
export function explanationVersionDiagnostic(
  outcome: ExplanationProducerOutcome,
  provider: InsightProvider,
): "unsupported_codex_version" | undefined {
  return provider === "codex-cli-account" &&
    outcome._tag === "failed" &&
    outcome.effectKnown &&
    outcome.reason === "runtime_unavailable" &&
    outcome.phase === "native_policy_unsupported" &&
    outcome.code === "unsupported_codex_version" &&
    outcome.detail === CODEX_EXPLANATION_VERSION_MESSAGE
    ? "unsupported_codex_version"
    : undefined;
}

type ProducerInput = {
  readonly profileId: string;
  readonly sessionId: string;
  readonly model: string;
  readonly reasoning: InsightReasoning;
  readonly language: InsightLanguage;
  readonly evidence: InsightEvidenceReference;
  readonly identity: ExplanationConnectionIdentity;
  readonly deadline: ExplanationDeadline;
  readonly signal: AbortSignal;
  readonly onActivity?: InsightActivitySink | undefined;
};

/** API execution alone receives the exact-request FD3 channel. */
export type ApiExplanationProducer = {
  readonly transport: "api";
  invokeGuide(
    input: ProducerInput & {
      readonly handler: (frame: GuideChildFrame) => Promise<GuideAppOutcome>;
    },
  ): Promise<ExplanationProducerOutcome>;
  invokeWalkthroughSession(
    input: ProducerInput & {
      readonly handler: (
        frame: WalkthroughChildFrame,
      ) => Promise<WalkthroughAppOutcome>;
    },
  ): Promise<ExplanationProducerOutcome>;
};

/** The native adapter must commit before sending and confirm owned descendant cessation before returning success. */
export type NativeExplanationLifecycle = {
  start(input: {
    readonly version: string;
    readonly prompt: string;
    readonly toolContractHash: string;
  }): Promise<Result<InsightArtifactReference, "refused" | "unknown">>;
  observe(event: NativeTurnEvent): Promise<Result<void, "unknown">>;
  /** A separate successful-stop signal, never the run's cancellation signal. */
  readonly finishSignal: AbortSignal;
};

/** Native callers can submit logical operations only; no request-commit permission is exposed. */
export type NativeExplanationProducer = {
  readonly transport: "native";
  invokeGuide(
    input: ProducerInput & {
      readonly lifecycle: NativeExplanationLifecycle;
      readonly tool: (
        call: Extract<GuideChildFrame, { kind: "tool" }>["call"],
      ) => Promise<GuideAppOutcome>;
    },
  ): Promise<ExplanationProducerOutcome>;
  invokeWalkthroughSession(
    input: ProducerInput & {
      readonly lifecycle: NativeExplanationLifecycle;
      readonly tool: (
        call: Extract<WalkthroughChildFrame, { kind: "tool" }>["call"],
      ) => Promise<WalkthroughAppOutcome>;
    },
  ): Promise<ExplanationProducerOutcome>;
};

/** Frozen provenance selects an injected transport, independently of API runtime availability. */
export type ExplanationProducers = {
  readonly pi?: ApiExplanationProducer;
  readonly "codex-cli-account"?: NativeExplanationProducer;
  readonly "pi-cli-account"?: NativeExplanationProducer;
};

/** Availability does not enable the public capability table. */
export function hasExplanationProducer(
  producers: ExplanationProducers,
  provider: InsightProvider,
): boolean {
  return producers[provider] !== undefined;
}

/** Uses the durable Authorization, and refuses a pass whose in-memory selection disagrees. */
export async function selectExplanationProducer(
  producers: ExplanationProducers,
  artifacts: InsightArtifactStore,
  authority: Pick<ExplanationRunTransactions, "produce">,
  pass: GuidePass,
): Promise<ApiExplanationProducer | NativeExplanationProducer | undefined> {
  const read = await authority.produce(pass.run, async () => ok(undefined));
  if (
    read._tag === "err" ||
    read.value.state.generation !== pass.generation ||
    read.value.state.cancelEpoch !== pass.cancelEpoch
  )
    return undefined;
  const { profileId, reviewId } = pass.run;
  const authorization = await artifacts.readObject(
    profileId,
    reviewId,
    insightAuthorizationCodec,
    read.value.state.authorization,
  );
  if (authorization._tag === "err") return undefined;
  const selection = await artifacts.readObject(
    profileId,
    reviewId,
    insightProvenanceCodec,
    authorization.value.selection,
  );
  if (selection._tag === "err") return undefined;
  const model = await new InsightResultStore(
    artifacts,
    profileId,
    reviewId,
  ).readText(selection.value.model, 4096);
  if (
    model._tag === "err" ||
    selection.value.provider !== pass.request.selection.provider ||
    model.value !== pass.request.selection.model ||
    selection.value.reasoning !== pass.request.reasoning
  )
    return undefined;
  return producers[selection.value.provider];
}
