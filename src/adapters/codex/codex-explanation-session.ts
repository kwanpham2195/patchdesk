import { insightFailureDiagnostic } from "#src/domain/insight-failure-diagnostic";
import { CODEX_EXPLANATION_SUPPORTED_VERSIONS } from "#src/domain/codex-explanation-version";
import {
  createCodexActivityEmitter,
  type InsightActivitySink,
} from "./codex-activity";
import { InsightProcessCleanupError } from "#src/adapters/process/insight-process-cleanup";
import { insightArtifactIdSchema } from "#src/domain/insight-artifact-scalars";
import { createHash } from "node:crypto";
import * as v from "valibot";
import type { CodexRunInput } from "./codex-app-server-client";
import {
  RpcChild,
  type CodexProcessFactory,
  type CodexRpcMessage,
} from "./codex-app-server-rpc";
import {
  discoverCodexInsightSession,
  validateCodexInsightSession,
  type CodexInsightHomeFactory,
  type CodexInsightHome,
} from "./codex-insight-home";
import {
  codexInsightIsolationArgs,
  parseCodexInsightThread,
} from "./codex-insight-policy";
import { paginateModelList } from "./codex-model-catalog";
import {
  CodexExplanationTools,
  codexExplanationDeclarations,
  type CodexExplanationBinding,
} from "./codex-explanation-tools";
import type { ExplanationConnectionIdentity } from "#src/domain/explanation-channel";
import type { NativeTurnEvent } from "#src/domain/native-explanation-turn";
import type {
  ExplanationDeadline,
  ExplanationProducerOutcome,
  NativeExplanationLifecycle,
} from "#src/services/explanation-producer";

export type CodexExplanationInput = {
  readonly run: CodexRunInput;
  readonly binding: CodexExplanationBinding;
  readonly identity: ExplanationConnectionIdentity;
  readonly lifecycle: NativeExplanationLifecycle;
  readonly deadline: ExplanationDeadline;
  readonly signal: AbortSignal;
  readonly onActivity?: InsightActivitySink | undefined;
};
const failed = (
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

/** Owns a fresh private native connection; no thread is resumed or generating command retried. */
export async function runCodexExplanation(
  executable: string,
  processFactory: CodexProcessFactory,
  homeFactory: CodexInsightHomeFactory,
  input: CodexExplanationInput,
): Promise<ExplanationProducerOutcome> {
  const remaining = () =>
    input.deadline.kind === "no-total-deadline/1"
      ? 0
      : Math.max(0, Date.parse(input.deadline.deadlineAt) - Date.now());
  if (input.signal.aborted) return failed(true, "cancelled", "cancelled");
  if (Buffer.byteLength(input.run.prompt) > 65536)
    return failed(true, "prompt_too_large");
  let home: CodexInsightHome | undefined;
  let child: RpcChild | undefined;
  let admitted = false;
  let toolEffectUnknown = false;
  let cessation = false;
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
      // request writes synchronously and owns an ID; its acknowledgment never gates the finish reply.
      interruptTask = child.request("turn/interrupt", { threadId, turnId });
      interruptObservation = observe({ kind: "interrupt_requested" });
    }
    return interruptObservation ?? Promise.resolve();
  };
  const onAbort = (): void => {
    tools?.close();
    void interrupt().catch(() => undefined);
    resolveEnd(failed(true, "cancelled", "cancelled"));
  };
  const onFinish = (): void => {
    tools?.close();
    void interrupt().then(
      () => resolveEnd({ _tag: "finished" }),
      () => resolveEnd(failed(false, "native_observation_unknown")),
    );
  };
  const declarations = codexExplanationDeclarations(input.binding.kind);
  const createConnection = () => {
    const connection = new RpcChild(processFactory);
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
        await interrupt();
        resolveEnd({ _tag: "finished" });
      },
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
      if (prepared._tag === "err") return failed(true, prepared.error);
      home = prepared.value;
      const expected = await discoverCodexInsightSession(
        () => createConnection().connection,
        executable,
        input.run.worktreePath,
        home,
        input.signal,
        CODEX_EXPLANATION_SUPPORTED_VERSIONS,
      );
      if (expected._tag === "err")
        return failed(true, expected.error.detail ?? expected.error.phase);
      const created = createConnection();
      child = created.connection;
      tools = created.connectionTools;
      const opened = await child.start(
        executable,
        input.run.worktreePath,
        input.signal,
        [...codexInsightIsolationArgs(), ...expected.value.args],
        home.directory,
      );
      if (opened._tag === "err") return failed(true, opened.error.phase);
      const nativeVersion = child.nativeVersion;
      if (
        nativeVersion === undefined ||
        !CODEX_EXPLANATION_SUPPORTED_VERSIONS.some(
          (version) => version === nativeVersion,
        )
      )
        return failed(true, "unsupported_codex_version");
      const valid = await validateCodexInsightSession(
        child,
        input.run.worktreePath,
        home,
        expected.value,
        input.signal,
      );
      if (valid._tag === "err") return failed(true, valid.error.phase);
      const models = await paginateModelList(child, input.signal);
      if (
        models._tag === "err" ||
        !models.value.some(
          (model) =>
            model.id === input.run.model &&
            model.reasoning.includes(input.run.reasoning),
        )
      )
        return failed(true, "model_list");
      const thread = await child.request(
        "thread/start",
        {
          model: input.run.model,
          cwd: input.run.worktreePath,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          config: { model_reasoning_effort: input.run.reasoning },
          developerInstructions: "",
          ephemeral: true,
          dynamicTools: declarations,
        },
        input.signal,
      );
      if (thread._tag === "err") return failed(true, "thread_start");
      threadId = parseCodexInsightThread(thread.value, input.run);
      if (threadId === undefined || !tools.bindThread(threadId))
        return failed(true, "native_policy_unsupported");
      if (!(await home.unchanged(remaining())))
        return failed(true, "native_auth_unsupported");
      if (
        tools.halted ||
        input.signal.aborted ||
        input.lifecycle.finishSignal.aborted
      )
        return failed(true, "cancelled", "cancelled");
      if (input.deadline.kind === "walkthrough-deadline/1" && remaining() === 0)
        return failed(true, "deadline", "timed_out");
      const start = await input.lifecycle.start({
        version: nativeVersion,
        prompt: input.run.prompt,
        toolContractHash: createHash("sha256")
          .update(JSON.stringify(declarations))
          .digest("hex"),
      });
      if (start._tag === "err")
        return failed(start.error === "refused", "native_start_" + start.error);
      admitted = true;
      await observe({ kind: "accepted_start" });
      const activity = createCodexActivityEmitter(
        input.onActivity,
        input.run.worktreePath,
      );
      child.activity = activity;
      const early: Array<{
        readonly threadId: string;
        readonly turnId: string;
        readonly ended: boolean;
      }> = [];
      const onMessage = (message: CodexRpcMessage): void => {
        const activityIdentity = v.safeParse(
          v.looseObject({ threadId: v.string(), turnId: v.string() }),
          message.params,
        );
        if (
          turnId !== undefined &&
          activityIdentity.success &&
          activityIdentity.output.threadId === threadId &&
          activityIdentity.output.turnId === turnId
        )
          activity.notification(message);
        if (
          message.method !== "turn/started" &&
          message.method !== "turn/completed"
        )
          return;
        const parsed = v.safeParse(turnMessageSchema, message.params);
        if (!parsed.success || early.length >= 16) {
          tools?.close();
          resolveEnd(failed(false, "invalid_native_turn"));
          return;
        }
        const candidate = {
          threadId: parsed.output.threadId,
          turnId: parsed.output.turn.id,
          ended: message.method === "turn/completed",
        };
        if (turnId === undefined) early.push(candidate);
        else if (
          candidate.threadId !== threadId ||
          candidate.turnId !== turnId
        ) {
          tools?.close();
          resolveEnd(failed(false, "native_turn_mismatch"));
        } else if (candidate.ended) {
          tools?.close();
          resolveEnd(failed(true, "native_turn_ended", "execution_failed"));
        }
      };
      remove = child.listenersAdd(onMessage);
      input.signal.addEventListener("abort", onAbort, { once: true });
      input.lifecycle.finishSignal.addEventListener("abort", onFinish, {
        once: true,
      });
      if (input.deadline.kind === "walkthrough-deadline/1")
        timer = setTimeout(() => {
          tools?.close();
          void interrupt().catch(() => undefined);
          resolveEnd(failed(true, "deadline", "timed_out"));
        }, remaining());
      if (tools.halted) return failed(false, "native_connection_stopped");
      if (input.signal.aborted) return failed(true, "cancelled", "cancelled");
      if (input.deadline.kind === "walkthrough-deadline/1" && remaining() === 0)
        return failed(true, "deadline", "timed_out");
      // Once intent is durable, reconcile even an abort racing with the start response.
      activity.turnStarted();
      const started = await child.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.run.prompt, text_elements: [] }],
        effort: input.run.reasoning,
      });
      if (started._tag === "err")
        result = failed(false, "native_turn_start_unknown");
      else {
        const parsed = v.safeParse(turnStartSchema, started.value);
        if (
          !parsed.success ||
          early.some(
            (candidate) =>
              candidate.threadId !== threadId ||
              candidate.turnId !== parsed.output.turn.id,
          )
        )
          result = failed(false, "native_turn_start_mismatch");
        else {
          turnId = parsed.output.turn.id;
          await observe({
            kind: "provider_turn",
            turnId: parsed.output.turn.id,
          });
          if (input.signal.aborted) onAbort();
          else if (early.some((candidate) => candidate.ended))
            resolveEnd(failed(true, "native_turn_ended", "execution_failed"));
          else tools.bindTurn(turnId);
          result = await end;
        }
      }
      return result;
    })();
  } catch (cause) {
    discoveryCleanupUnknown = cause instanceof InsightProcessCleanupError;
    result = failed(
      !admitted && !discoveryCleanupUnknown,
      "native_execution_unknown",
    );
  } finally {
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
        if (toolEffectUnknown)
          result = failed(false, "native_tool_effect_unknown");
        await observe({
          kind: "ended",
          outcome:
            result._tag === "finished" || result.effectKnown
              ? "known"
              : "unknown",
        });
      } catch {
        result = failed(false, "native_observation_unknown");
      }
    }
    try {
      await child?.stop();
      await interruptTask;
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
      cessation = false;
      result = failed(false, "native_cleanup_unknown");
      if (admitted)
        await input.lifecycle.observe({ kind: "cessation_unknown" });
    }
    if (cessation && home !== undefined) {
      try {
        await home.cleanup();
      } catch {
        result = failed(false, "native_home_cleanup_failed");
      }
    }
  }
  return result;
}
