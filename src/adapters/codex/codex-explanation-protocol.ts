import * as v from "valibot";
import { insightFailureDiagnostic } from "#src/domain/insight-failure-diagnostic";
import { insightArtifactIdSchema } from "#src/domain/insight-artifact-scalars";
import type { ExplanationConnectionIdentity } from "#src/domain/explanation-channel";
import type {
  ExplanationDeadline,
  ExplanationProducerOutcome,
  NativeExplanationLifecycle,
} from "#src/services/explanation-producer";
import type { CodexRunInput } from "./codex-app-server-client";
import type { CodexRpcMessage, JsonObject } from "./codex-app-server-rpc";
import type {
  CodexActivityEmitter,
  InsightActivitySink,
} from "./codex-activity";
import type { CodexExplanationBinding } from "./codex-explanation-tools";
import type {
  CodexDiagnostic,
  CodexDiagnosticFields,
  CodexDiagnosticSink,
  CodexExplanationDiagnostics,
} from "./codex-explanation-diagnostics";

/** Host-owned invocation inputs; native notifications never supply lifecycle authority. */
export type CodexExplanationInput = {
  readonly run: CodexRunInput;
  readonly binding: CodexExplanationBinding;
  readonly identity: ExplanationConnectionIdentity;
  readonly lifecycle: NativeExplanationLifecycle;
  readonly deadline: ExplanationDeadline;
  readonly signal: AbortSignal;
  readonly onActivity?: InsightActivitySink | undefined;
  readonly diagnostic?: CodexDiagnosticSink | undefined;
};

/** Preserves the public failure projection independently of internal diagnostics. */
export const codexExplanationFailure = (
  effectKnown: boolean,
  detail: string,
  reason:
    | "runtime_unavailable"
    | "cancelled"
    | "timed_out"
    | "execution_failed" = "runtime_unavailable",
): ExplanationProducerOutcome => {
  if (detail === "unsupported_codex_version")
    return {
      _tag: "failed",
      reason,
      effectKnown,
      ...insightFailureDiagnostic(
        "runtime_unavailable",
        "native_policy_unsupported",
        detail,
      ),
    };
  return { _tag: "failed", reason, detail, effectKnown };
};

const turnMessageSchema = v.looseObject({
  threadId: v.string(),
  turn: v.looseObject({ id: v.string() }),
});
const turnStartSchema = v.looseObject({
  turn: v.looseObject({ id: insightArtifactIdSchema }),
});
/** Early notifications become terminal evidence only after their response binding validates. */
export type CodexExplanationTurnNotification = {
  readonly threadId: string;
  readonly turnId: string;
  readonly ended: boolean;
};

/** Validates the start response before comparing any queued notification bindings. */
export function parseCodexExplanationStartedTurn(
  value: JsonObject,
  threadId: string | undefined,
  early: ReadonlyArray<CodexExplanationTurnNotification>,
):
  | {
      readonly _tag: "ok";
      readonly turnId: v.InferOutput<typeof insightArtifactIdSchema>;
    }
  | {
      readonly _tag: "err";
      readonly code: "start_response_invalid" | "start_binding_mismatch";
    } {
  const parsed = v.safeParse(turnStartSchema, value);
  if (
    !parsed.success ||
    early.some(
      (candidate) =>
        candidate.threadId !== threadId ||
        candidate.turnId !== parsed.output.turn.id,
    )
  )
    return {
      _tag: "err",
      code: !parsed.success
        ? "start_response_invalid"
        : "start_binding_mismatch",
    };
  return { _tag: "ok", turnId: parsed.output.turn.id };
}

/** Uses live binding getters so callbacks retain the session's original read order. */
export function createCodexExplanationTurnListener(
  binding: {
    readonly threadId: string | undefined;
    readonly turnId: string | undefined;
  },
  early: CodexExplanationTurnNotification[],
  activity: CodexActivityEmitter,
  finishSignal: AbortSignal,
  diagnostics: CodexExplanationDiagnostics,
  stop: (outcome: ExplanationProducerOutcome) => void,
): (message: CodexRpcMessage) => void {
  return (message) => {
    const activityIdentity = v.safeParse(
      v.looseObject({ threadId: v.string(), turnId: v.string() }),
      message.params,
    );
    if (
      binding.turnId !== undefined &&
      activityIdentity.success &&
      activityIdentity.output.threadId === binding.threadId &&
      activityIdentity.output.turnId === binding.turnId
    )
      activity.notification(message);
    if (
      message.method !== "turn/started" &&
      message.method !== "turn/completed"
    )
      return;
    const parsed = v.safeParse(turnMessageSchema, message.params);
    if (!parsed.success || early.length >= 16) {
      diagnostics.observe([
        "host_refusal",
        !parsed.success
          ? "turn_notification_invalid"
          : "turn_notification_overflow",
      ]);
      stop(codexExplanationFailure(false, "invalid_native_turn"));
      return;
    }
    const candidate = {
      threadId: parsed.output.threadId,
      turnId: parsed.output.turn.id,
      ended: message.method === "turn/completed",
    };
    if (binding.turnId === undefined) early.push(candidate);
    else if (
      candidate.threadId !== binding.threadId ||
      candidate.turnId !== binding.turnId
    ) {
      diagnostics.observe(["host_refusal", "turn_notification_mismatch"]);
      stop(codexExplanationFailure(false, "native_turn_mismatch"));
    } else if (candidate.ended) {
      diagnostics.observe(
        finishSignal.aborted
          ? ["finish_accepted", "finish_signal"]
          : ["provider_completed_without_finish", "bound_completion"],
      );
      stop(
        codexExplanationFailure(true, "native_turn_ended", "execution_failed"),
      );
    }
  };
}

/** Discovery and intentional-stop facts cannot become generating-child transport triggers. */
export function observeCodexExplanationRpc(
  diagnostics: CodexExplanationDiagnostics,
  event: CodexDiagnostic,
  fields: CodexDiagnosticFields,
  stopping: boolean,
  selected: boolean,
  admitted: boolean,
): void {
  const phase =
    diagnostics.phase === "cleanup" || stopping
      ? "cleanup"
      : selected && admitted
        ? "running"
        : "preflight";
  if (
    phase === "cleanup" &&
    event[0] === "transport_lost" &&
    (event[1] === "process_exit" ||
      event[1] === "stdin_error" ||
      event[1] === "process_error")
  )
    diagnostics.observe(
      ["cleanup", event[1]],
      fields,
      selected ? phase : "preflight",
      !selected,
    );
  else if (phase !== "cleanup")
    diagnostics.observe(event, fields, phase, !selected || !admitted);
}
