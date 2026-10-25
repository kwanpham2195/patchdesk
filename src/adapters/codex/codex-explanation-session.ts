import {
  CodexExplanationDiagnostics,
  type CodexDiagnostic,
  type CodexCleanupFailureStep,
  type CodexStopFailureCause,
} from "./codex-explanation-diagnostics";
import {
  codexExplanationFailure as failed,
  createCodexExplanationTurnListener,
  parseCodexExplanationStartedTurn,
  observeCodexExplanationRpc,
  type CodexExplanationInput,
  type CodexExplanationTurnNotification,
} from "./codex-explanation-protocol";
import { createCodexActivityEmitter } from "./codex-activity";
import { InsightProcessCleanupError } from "#src/adapters/process/insight-process-cleanup";
import { createHash } from "node:crypto";
import { RpcChild, type CodexProcessFactory } from "./codex-app-server-rpc";
import {
  discoverCodexInsightSession,
  type CodexInsightHomeFactory,
  type CodexInsightHome,
} from "./codex-insight-home";
import { codexInsightIsolationArgs } from "./codex-insight-policy";
import { prepareCodexExplanationThread } from "./codex-explanation-thread";
import {
  CodexExplanationTools,
  codexExplanationDeclarations,
} from "./codex-explanation-tools";
import type { NativeTurnEvent } from "#src/domain/native-explanation-turn";
import type { ExplanationProducerOutcome } from "#src/services/explanation-producer";

/** Owns a fresh private native connection; no thread is resumed or generating command retried. */
export async function runCodexExplanation(
  executable: string,
  processFactory: CodexProcessFactory,
  homeFactory: CodexInsightHomeFactory,
  input: CodexExplanationInput,
): Promise<ExplanationProducerOutcome> {
  const attempt = input.run.attempt;
  if (attempt === undefined)
    return failed(true, "native_attempt_storage_refused");
  const diagnostics = new CodexExplanationDiagnostics(
    input.binding.kind,
    input.identity.connection,
    input.diagnostic,
  );
  const recorded = (
    event: CodexDiagnostic,
    outcome: ExplanationProducerOutcome,
  ): ExplanationProducerOutcome => {
    if (outcome._tag === "failed")
      attempt.fail(
        event[0] === "preflight_refused" ? "preflight" : "execution",
        event[0] === "preflight_refused"
          ? "native_preflight"
          : "native_execution",
      );
    diagnostics.observe(event);
    return outcome;
  };
  const remaining = () =>
    input.deadline.kind === "no-total-deadline/1"
      ? 0
      : Math.max(0, Date.parse(input.deadline.deadlineAt) - Date.now());
  if (input.signal.aborted || Buffer.byteLength(input.run.prompt) > 65536) {
    const outcome = input.signal.aborted
      ? recorded(
          ["abort_observed", "signal_aborted"],
          failed(true, "cancelled", "cancelled"),
        )
      : recorded(
          ["preflight_refused", "prompt_limit"],
          failed(true, "prompt_too_large"),
        );
    diagnostics.finish(outcome, false, "not_attempted");
    return outcome;
  }
  let home: CodexInsightHome | undefined;
  let child: RpcChild | undefined;
  let admitted = false;
  let toolEffectUnknown = false;
  let cessation = false;
  let cleanupFailureStep: CodexCleanupFailureStep | undefined;
  let cleanupFailureCause: CodexStopFailureCause | undefined;
  let homeCleanup: "not_attempted" | "succeeded" | "failed" = "not_attempted";
  let discoveryCleanupUnknown = false;
  let tools: CodexExplanationTools | undefined;
  let remove: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interruptTask: ReturnType<RpcChild["request"]> | undefined;
  let interruptObservation: Promise<void> | undefined;
  let result: ExplanationProducerOutcome = failed(
    true,
    "native_preflight_failed",
  );
  let resolveEnd: (value: ExplanationProducerOutcome) => void = () => undefined;
  const end = new Promise<ExplanationProducerOutcome>((resolve) => {
    resolveEnd = resolve;
  });
  const observe = async (event: NativeTurnEvent): Promise<void> => {
    if ((await input.lifecycle.observe(event))._tag === "err") {
      attempt.fail("execution", "native_observation");
      diagnostics.observe(
        diagnostics.phase === "cleanup"
          ? ["cleanup", "observation_failed"]
          : ["observation_unknown", "lifecycle_observe_failed"],
      );
      tools?.close();
      resolveEnd(failed(false, "native_observation_unknown"));
      throw new Error("native_observation_unknown");
    }
  };
  let threadId: string | undefined;
  let turnId: string | undefined;
  let interruptSent = false;
  const interrupt = (): Promise<void> => {
    tools?.close();
    if (
      !interruptSent &&
      child !== undefined &&
      child.canRequest &&
      threadId !== undefined &&
      turnId !== undefined
    ) {
      interruptSent = true;
      attempt.record.cleanup.abort = "pending";
      // request writes synchronously and owns an ID; its acknowledgment never gates the finish reply.
      diagnostics.observe(["cleanup", "interrupt_attempted"]);
      interruptTask = child.request("turn/interrupt", { threadId, turnId });
      interruptObservation = observe({ kind: "interrupt_requested" });
    }
    return interruptObservation ?? Promise.resolve();
  };
  const onAbort = (): void => {
    diagnostics.observe(["abort_observed", "signal_aborted"]);
    tools?.close();
    void interrupt().catch(() => undefined);
    resolveEnd(failed(true, "cancelled", "cancelled"));
  };
  const onFinish = (): void => {
    diagnostics.observe(["finish_accepted", "finish_signal"]);
    tools?.close();
    void interrupt().then(
      () => resolveEnd({ _tag: "finished" }),
      () => resolveEnd(failed(false, "native_observation_unknown")),
    );
  };
  const declarations = codexExplanationDeclarations(input.binding.kind);
  const createConnection = () => {
    const connection = new RpcChild(processFactory, (event, fields, stopping) =>
      observeCodexExplanationRpc(
        diagnostics,
        event,
        fields,
        stopping,
        connection === child,
        admitted,
      ),
    );
    const connectionTools = new CodexExplanationTools(
      input.binding,
      input.identity,
      (message) => connection.send(message),
      (id, method) => {
        return connection.serverReply(id, method);
      },
      (known) => {
        if (!known) toolEffectUnknown = true;
        resolveEnd(failed(known, "native_tool_transport_stopped"));
        // An admitted start may still be awaiting its response; finally reconciles its bound interrupt before stop.
        if (connection !== child || !admitted)
          void connection.stop().catch(() => undefined);
      },
      async () => {
        diagnostics.observe(["finish_accepted", "finish_signal"]);
        await interrupt();
        resolveEnd({ _tag: "finished" });
      },
      (event, fields) => diagnostics.observe(event, fields),
    );
    connection.onServerRequest = (message, bytes) =>
      connectionTools.receive(message, bytes);
    connection.onFailure = () => {
      connectionTools.close();
      if (connection === child && admitted)
        resolveEnd(failed(false, "native_connection_lost"));
    };
    return { connection, connectionTools };
  };
  try {
    result = await (async (): Promise<ExplanationProducerOutcome> => {
      const prepared = await homeFactory(remaining());
      if (prepared._tag === "err")
        return recorded(
          ["preflight_refused", "home_prepare"],
          failed(true, prepared.error),
        );
      home = prepared.value;
      if (!(await attempt.bindCodexHome(home.directory))) {
        attempt.fail("prepare", "storage");
        return failed(true, "native_attempt_storage_refused");
      }
      const expected = await discoverCodexInsightSession(
        () => createConnection().connection,
        executable,
        input.run.worktreePath,
        home,
        input.signal,
      );
      if (expected._tag === "err")
        return recorded(
          ["preflight_refused", "discovery"],
          failed(true, expected.error.detail ?? expected.error.phase),
        );
      const created = createConnection();
      child = created.connection;
      tools = created.connectionTools;
      attempt.record.cleanup.process = "pending";
      const opened = await child.start(
        executable,
        input.run.worktreePath,
        input.signal,
        [...codexInsightIsolationArgs(), ...expected.value.args],
        home.directory,
      );
      if (opened._tag === "err")
        return recorded(
          ["preflight_refused", "connection_start"],
          failed(true, opened.error.phase),
        );
      const preparedThread = await prepareCodexExplanationThread(
        child,
        home,
        expected.value,
        input,
        tools,
        declarations,
        attempt,
      );
      if (preparedThread._tag === "err")
        return recorded(
          ["preflight_refused", preparedThread.error.code],
          failed(true, preparedThread.error.detail),
        );
      const { nativeVersion, threadId: preparedThreadId } =
        preparedThread.value;
      threadId = preparedThreadId;
      if (!(await home.unchanged(remaining())))
        return recorded(
          ["preflight_refused", "home_changed"],
          failed(true, "native_auth_unsupported"),
        );
      if (
        tools.halted ||
        input.signal.aborted ||
        input.lifecycle.finishSignal.aborted
      )
        return recorded(
          tools.halted
            ? ["host_refusal", "admission_halted"]
            : input.signal.aborted
              ? ["abort_observed", "signal_aborted"]
              : ["finish_accepted", "finish_signal"],
          failed(true, "cancelled", "cancelled"),
        );
      if (input.deadline.kind === "walkthrough-deadline/1" && remaining() === 0)
        return recorded(
          ["deadline_observed", "deadline_elapsed"],
          failed(true, "deadline", "timed_out"),
        );
      const start = await input.lifecycle.start({
        version: nativeVersion,
        prompt: input.run.prompt,
        toolContractHash: createHash("sha256")
          .update(JSON.stringify(declarations))
          .digest("hex"),
      });
      if (start._tag === "err")
        return recorded(
          start.error === "refused"
            ? ["preflight_refused", "start_commit_refused"]
            : ["start_unresolved", "start_commit_unknown"],
          failed(start.error === "refused", "native_start_" + start.error),
        );
      admitted = true;
      attempt.record.nativeStart = start.value;
      await attempt.save();
      diagnostics.phase = "running";
      await observe({ kind: "accepted_start" });
      const activity = createCodexActivityEmitter(
        input.onActivity,
        input.run.worktreePath,
      );
      child.activity = activity;
      const early: CodexExplanationTurnNotification[] = [];
      const onMessage = createCodexExplanationTurnListener(
        {
          get threadId() {
            return threadId;
          },
          get turnId() {
            return turnId;
          },
        },
        early,
        activity,
        input.lifecycle.finishSignal,
        diagnostics,
        (outcome) => {
          tools?.close();
          resolveEnd(outcome);
        },
      );
      remove = child.listenersAdd(onMessage);
      input.signal.addEventListener("abort", onAbort, { once: true });
      input.lifecycle.finishSignal.addEventListener("abort", onFinish, {
        once: true,
      });
      if (input.deadline.kind === "walkthrough-deadline/1")
        timer = setTimeout(() => {
          diagnostics.observe(["deadline_observed", "deadline_elapsed"]);
          tools?.close();
          void interrupt().catch(() => undefined);
          resolveEnd(failed(true, "deadline", "timed_out"));
        }, remaining());
      if (tools.halted)
        return recorded(
          ["host_refusal", "admission_halted"],
          failed(false, "native_connection_stopped"),
        );
      if (input.signal.aborted)
        return recorded(
          ["abort_observed", "signal_aborted"],
          failed(true, "cancelled", "cancelled"),
        );
      if (input.deadline.kind === "walkthrough-deadline/1" && remaining() === 0)
        return recorded(
          ["deadline_observed", "deadline_elapsed"],
          failed(true, "deadline", "timed_out"),
        );
      // Once intent is durable, reconcile even an abort racing with the start response.
      activity.turnStarted();
      const started = await child.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.run.prompt, text_elements: [] }],
        effort: input.run.reasoning,
      });
      if (started._tag === "err")
        result = recorded(
          ["start_unresolved", "start_rpc_failed"],
          failed(false, "native_turn_start_unknown"),
        );
      else {
        const parsed = parseCodexExplanationStartedTurn(
          started.value,
          threadId,
          early,
        );
        if (parsed._tag === "err")
          result = recorded(
            ["start_unresolved", parsed.code],
            failed(false, "native_turn_start_mismatch"),
          );
        else {
          turnId = parsed.turnId;
          // Binding makes early completion eligible before lifecycle persistence can yield to another callback.
          if (input.signal.aborted)
            diagnostics.observe(["abort_observed", "signal_aborted"]);
          else if (early.some((candidate) => candidate.ended))
            diagnostics.observe(
              input.lifecycle.finishSignal.aborted
                ? ["finish_accepted", "finish_signal"]
                : ["provider_completed_without_finish", "bound_completion"],
            );
          await observe({
            kind: "provider_turn",
            turnId: parsed.turnId,
          });
          if (input.signal.aborted) onAbort();
          else if (input.lifecycle.finishSignal.aborted) onFinish();
          else if (early.some((candidate) => candidate.ended)) {
            resolveEnd(failed(true, "native_turn_ended", "execution_failed"));
          } else tools.bindTurn(turnId);
          result = await end;
        }
      }
      return result;
    })();
  } catch (cause) {
    attempt.fail(
      admitted ? "execution" : "preflight",
      admitted ? "native_execution" : "native_preflight",
    );
    diagnostics.observe(["execution_unknown", "execution_threw"]);
    discoveryCleanupUnknown = cause instanceof InsightProcessCleanupError;
    result = failed(
      !admitted && !discoveryCleanupUnknown,
      "native_execution_unknown",
    );
  } finally {
    if (result._tag === "failed") attempt.fail("execution", "native_execution");
    if (!admitted) attempt.record.cleanup.hostWork = "not_applicable";
    diagnostics.phase = "cleanup";
    if (timer !== undefined) clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
    input.lifecycle.finishSignal.removeEventListener("abort", onFinish);
    remove?.();
    tools?.close();
    if (admitted) {
      try {
        await interrupt();
        if (!input.lifecycle.finishSignal.aborted) await child?.stop();
        await tools?.join();
        attempt.record.cleanup.hostWork = toolEffectUnknown
          ? "unknown"
          : "drained";
        if (toolEffectUnknown) {
          diagnostics.observe(["cleanup", "tool_effect_unknown"]);
          result = failed(false, "native_tool_effect_unknown");
        }
        await observe({
          kind: "ended",
          outcome:
            result._tag === "finished" || result.effectKnown
              ? "known"
              : "unknown",
        });
      } catch {
        attempt.record.cleanup.hostWork = "unknown";
        attempt.fail("cleanup", "host_work_unknown");
        diagnostics.observe(["cleanup", "observation_failed"]);
        result = failed(false, "native_observation_unknown");
      }
    }
    let cleanupStep: CodexCleanupFailureStep = "process_stop";
    try {
      await child?.stop();
      attempt.record.cleanup.process =
        child === undefined ? "not_started" : "succeeded";
      cleanupStep = "interrupt_settlement";
      const interrupted = await interruptTask;
      if (interruptTask !== undefined)
        attempt.record.cleanup.abort =
          interrupted?._tag === "ok" ? "acknowledged" : "unknown";
      cleanupStep = "cessation_observation";
      cessation = !discoveryCleanupUnknown;
      if (admitted && cessation)
        await observe({
          kind: "cessation_confirmed",
          outcome:
            result._tag === "finished" || result.effectKnown
              ? "known"
              : "unknown",
        });
    } catch {
      attempt.fail("cleanup", "native_stop");
      if (cleanupStep === "process_stop")
        attempt.record.cleanup.process = "unknown";
      cleanupFailureStep = cleanupStep;
      if (cleanupStep === "process_stop")
        cleanupFailureCause = child?.stopFailureCause ?? "unknown";
      diagnostics.observe(["cleanup", "process_stop_failed"]);
      cessation = false;
      result = failed(false, "native_cleanup_unknown");
      if (admitted)
        await input.lifecycle
          .observe({ kind: "cessation_unknown" })
          .catch(() => undefined);
    }
    if (cessation && home !== undefined) {
      await attempt.archiveCodexHistory();
      try {
        await home.cleanup();
        homeCleanup = "succeeded";
        attempt.record.cleanup.credentialHome = "succeeded";
      } catch {
        attempt.record.cleanup.credentialHome = "failed";
        attempt.fail("cleanup", "credential_cleanup");
        homeCleanup = "failed";
        diagnostics.observe(["cleanup", "home_cleanup_failed"]);
        result = failed(false, "native_home_cleanup_failed");
      }
    } else
      attempt.record.cleanup.credentialHome =
        home === undefined ? "not_applicable" : "protected";
    await attempt.save();
  }
  diagnostics.finish(
    result,
    cessation,
    homeCleanup,
    cleanupFailureStep,
    cleanupFailureCause,
    cleanupFailureStep === "process_stop"
      ? child?.stopFailureErrorCode
      : undefined,
  );
  return result;
}
