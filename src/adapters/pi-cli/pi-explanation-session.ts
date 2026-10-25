import { createHash } from "node:crypto";
import * as v from "valibot";
import type { NativeSessionAttemptStore } from "#src/adapters/storage/native-session-attempt-store";
import type {
  ExplanationProducerOutcome,
  NativeExplanationProducer,
} from "#src/services/explanation-producer";
import type { NativeTurnEvent } from "#src/domain/native-explanation-turn";
import { PiExplanationBridge } from "./pi-explanation-bridge";
import type { PiRpcClient, PiRpcRunInput } from "./pi-rpc-client";
import { piInsightSessionStateSchema } from "./pi-rpc-client";
import type { PiRpcChannel } from "./pi-rpc-channel";
import type { CodexExplanationBinding } from "#src/adapters/codex/codex-explanation-tools";

type ExplanationInput =
  | Parameters<NativeExplanationProducer["invokeGuide"]>[0]
  | Parameters<NativeExplanationProducer["invokeWalkthroughSession"]>[0];
const toolEventSchema = v.looseObject({
  toolCallId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  toolName: v.picklist(["read", "grep", "find", "ls", "bash"]),
});
const failure = (
  effectKnown: boolean,
  detail: string,
  reason:
    | "runtime_unavailable"
    | "execution_failed"
    | "timed_out"
    | "cancelled" = "runtime_unavailable",
): ExplanationProducerOutcome => ({
  _tag: "failed",
  reason,
  effectKnown,
  detail,
});

/** Pi RPC keeps retries/compaction native; only the operation service's finish can complete a Guide. */
export async function runPiExplanation(input: {
  readonly request: ExplanationInput;
  readonly binding: CodexExplanationBinding;
  readonly run: PiRpcRunInput;
  readonly client: PiRpcClient;
  readonly attempt: NativeSessionAttemptStore;
  readonly declarations: ReadonlyArray<object>;
}): Promise<ExplanationProducerOutcome> {
  const { request, run, attempt } = input;
  let channel: PiRpcChannel | undefined;
  let admitted = false;
  let receiptDelivered = false;
  let observerUnknown = false;
  let connectionUnknown = false;
  let outcome: ExplanationProducerOutcome = failure(
    true,
    "pi_preflight_failed",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let removeEvents: (() => void) | undefined;
  let removeExit: (() => void) | undefined;
  const activeTools = new Set<string>();
  let resolveEnd: (result: ExplanationProducerOutcome) => void = () =>
    undefined;
  const end = new Promise<ExplanationProducerOutcome>((resolve) => {
    resolveEnd = resolve;
  });
  const bridge = new PiExplanationBridge(
    request.identity,
    input.binding,
    () => {
      connectionUnknown = true;
      attempt.fail("execution", "host_work_unknown");
      resolveEnd(failure(false, "pi_operation_unknown"));
    },
    () => {
      receiptDelivered = true;
      completeFinish();
    },
  );
  const observe = async (event: NativeTurnEvent): Promise<boolean> => {
    const result = await request.lifecycle
      .observe(event)
      .catch(() => undefined);
    if (result?._tag !== "ok") {
      observerUnknown = true;
      attempt.fail("execution", "native_observation");
      bridge.closeAdmission();
      resolveEnd(failure(false, "pi_observation_unknown"));
      return false;
    }
    return true;
  };
  const onAbort = (): void => {
    bridge.closeAdmission();
    resolveEnd(failure(true, "cancelled", "cancelled"));
  };
  const onFinish = (): void => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    bridge.closeAdmission();
    // Never abort the Bash helper while its accepted finish receipt is still returning.
    timer ??= setTimeout(
      () => resolveEnd(failure(false, "pi_finish_settlement_unknown")),
      30_000,
    );
  };
  function completeFinish(): void {
    if (
      receiptDelivered &&
      activeTools.size === 0 &&
      request.lifecycle.finishSignal.aborted
    )
      resolveEnd({ _tag: "finished" });
  }
  try {
    outcome = await (async (): Promise<ExplanationProducerOutcome> => {
      if (request.signal.aborted)
        return failure(true, "cancelled", "cancelled");
      const environment = await bridge.open();
      const opened = await input.client.openExplanation(
        run,
        attempt.sessionDirectory,
        environment,
        request.signal,
      );
      if (opened._tag === "err") {
        attempt.fail("preflight", "native_preflight");
        return failure(true, opened.error.phase);
      }
      channel = opened.value.channel;
      attempt.record.observed.version = opened.value.version;
      attempt.record.cleanup.process = "pending";
      removeEvents = channel.onEvent((event) => {
        if (
          event.type === "tool_execution_start" ||
          event.type === "tool_execution_end"
        ) {
          const tool = v.safeParse(toolEventSchema, event);
          if (
            !tool.success ||
            (event.type === "tool_execution_start" && activeTools.size >= 16)
          ) {
            connectionUnknown = true;
            bridge.closeAdmission();
            resolveEnd(failure(false, "pi_tool_identity_unknown"));
            return;
          }
          if (event.type === "tool_execution_start")
            activeTools.add(tool.output.toolCallId);
          else {
            activeTools.delete(tool.output.toolCallId);
            completeFinish();
          }
        }
        if (event.type === "agent_settled") {
          if (request.lifecycle.finishSignal.aborted) completeFinish();
          else
            resolveEnd(
              failure(true, "pi_settled_without_finish", "execution_failed"),
            );
        }
      });
      removeExit = channel.onExit(() => {
        connectionUnknown = true;
        resolveEnd(failure(false, "pi_connection_lost"));
      });
      const state = await channel.request(
        { type: "get_state" },
        request.signal,
      );
      const parsed =
        state._tag === "ok"
          ? v.safeParse(piInsightSessionStateSchema, state.value.data)
          : undefined;
      if (parsed?.success === true) {
        attempt.record.observed = {
          ...attempt.record.observed,
          nativeProvider: parsed.output.model.provider,
          model: `${parsed.output.model.provider}/${parsed.output.model.id}`,
          reasoning: parsed.output.thinkingLevel,
          nativeSessionId: parsed.output.sessionId,
        };
      }
      if (
        parsed?.success !== true ||
        `${parsed.output.model.provider}/${parsed.output.model.id}` !==
          run.model ||
        parsed.output.thinkingLevel !== run.reasoning
      ) {
        attempt.fail("preflight", "native_preflight");
        return failure(true, "pi_session_state_mismatch");
      }
      if (
        !(await attempt.bindHistory(
          parsed.output.sessionFile,
          parsed.output.sessionId,
        ))
      ) {
        attempt.fail("preflight", "storage");
        return failure(true, "pi_history_binding_refused");
      }
      request.signal.addEventListener("abort", onAbort, { once: true });
      request.lifecycle.finishSignal.addEventListener("abort", onFinish, {
        once: true,
      });
      if (request.signal.aborted)
        return failure(true, "cancelled", "cancelled");
      if (connectionUnknown)
        return failure(true, "pi_preflight_connection_lost");
      if (request.deadline.kind === "walkthrough-deadline/1") {
        const remaining = Date.parse(request.deadline.deadlineAt) - Date.now();
        if (remaining <= 0) return failure(true, "pi_deadline", "timed_out");
        deadlineTimer = setTimeout(() => {
          bridge.closeAdmission();
          resolveEnd(failure(true, "pi_deadline", "timed_out"));
        }, remaining);
      }
      const start = await request.lifecycle.start({
        version: opened.value.version,
        prompt: run.prompt,
        toolContractHash: createHash("sha256")
          .update(JSON.stringify(input.declarations))
          .digest("hex"),
      });
      if (start._tag === "err") {
        attempt.fail(
          "start",
          start.error === "refused"
            ? "native_start_refused"
            : "native_start_unknown",
        );
        return failure(start.error === "refused", "pi_start_" + start.error);
      }
      admitted = true;
      attempt.record.nativeStart = start.value;
      attempt.record.cleanup.abort = "pending";
      // Storage must still be usable after durable intent and before any paid native command.
      if (!(await attempt.save())) {
        attempt.fail("start", "storage");
        return failure(true, "pi_attempt_storage_refused");
      }
      if (request.signal.aborted)
        return failure(true, "cancelled", "cancelled");
      if (connectionUnknown) return failure(false, "pi_connection_lost");
      if (
        request.deadline.kind === "walkthrough-deadline/1" &&
        Date.parse(request.deadline.deadlineAt) <= Date.now()
      )
        return failure(true, "pi_deadline", "timed_out");
      bridge.admit();
      const accepted = await channel.request({
        type: "prompt",
        message: run.prompt,
      });
      if (accepted._tag === "err") {
        attempt.fail("start", "native_start_unknown");
        return failure(false, "pi_prompt_ack_unknown");
      }
      if (!(await observe({ kind: "accepted_start" })))
        return failure(false, "pi_observation_unknown");
      if (request.signal.aborted) onAbort();
      return await end;
    })();
  } catch {
    attempt.fail(
      admitted ? "execution" : "preflight",
      admitted ? "native_execution" : "native_preflight",
    );
    outcome = failure(!admitted, "pi_execution_unknown");
  } finally {
    bridge.closeAdmission();
    if (timer !== undefined) clearTimeout(timer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    request.signal.removeEventListener("abort", onAbort);
    request.lifecycle.finishSignal.removeEventListener("abort", onFinish);
    if (outcome._tag === "failed")
      attempt.fail("execution", "native_execution");
    const drained = await bridge.drain();
    attempt.record.cleanup.hostWork = drained ? "drained" : "unknown";
    if (!drained) {
      attempt.fail("cleanup", "host_work_unknown");
      outcome = failure(false, "pi_host_work_unknown");
    }
    let ack = !admitted;
    if (admitted && channel !== undefined) {
      attempt.record.cleanup.abort = "pending";
      try {
        // A correlated ACK proves native idle within the accepted limited cleanup scope.
        const interrupt = channel.request({ type: "abort" });
        await observe({ kind: "interrupt_requested" });
        ack = (await interrupt)._tag === "ok";
      } catch {
        ack = false;
      }
      attempt.record.cleanup.abort = ack ? "acknowledged" : "unknown";
      if (!ack) {
        attempt.fail("cleanup", "native_abort");
        outcome = failure(false, "pi_abort_unknown");
      }
    }
    if (admitted)
      await observe({
        kind: "ended",
        outcome:
          outcome._tag === "finished" || outcome.effectKnown
            ? "known"
            : "unknown",
      });
    let stopped = true;
    try {
      await channel?.stop();
      attempt.record.cleanup.process =
        channel === undefined ? "not_started" : "succeeded";
    } catch {
      stopped = false;
      attempt.record.cleanup.process = "unknown";
      attempt.fail("cleanup", "native_stop");
      outcome = failure(false, "pi_stop_unknown");
    }
    removeEvents?.();
    removeExit?.();
    try {
      await bridge.close();
    } catch {
      stopped = false;
      attempt.fail("cleanup", "native_stop");
      outcome = failure(false, "pi_bridge_cleanup_unknown");
    }
    if (admitted) {
      if (ack && drained && stopped && !observerUnknown) {
        if (
          !(await observe({
            kind: "cessation_confirmed",
            outcome:
              outcome._tag === "finished" || outcome.effectKnown
                ? "known"
                : "unknown",
          }))
        )
          outcome = failure(false, "pi_observation_unknown");
      } else {
        await observe({ kind: "cessation_unknown" });
        outcome = failure(false, "pi_cleanup_unknown");
      }
    }
    if (observerUnknown) outcome = failure(false, "pi_observation_unknown");
    await attempt.capture();
  }
  return outcome;
}
