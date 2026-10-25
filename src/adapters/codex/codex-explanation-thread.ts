import { err, ok, type Result } from "#src/domain/result";
import type { NativeSessionAttemptStore } from "#src/adapters/storage/native-session-attempt-store";
import type { RpcChild } from "./codex-app-server-rpc";
import {
  validateCodexInsightSession,
  type CodexInsightHome,
  type CodexInsightSession,
} from "./codex-insight-home";
import {
  parseCodexInsightSelection,
  parseCodexInsightThread,
} from "./codex-insight-policy";
import { paginateModelList } from "./codex-model-catalog";
import type { CodexExplanationInput } from "./codex-explanation-protocol";
import type {
  CodexExplanationTools,
  codexExplanationDeclarations,
} from "./codex-explanation-tools";

type CodexExplanationThreadFailure = {
  readonly code:
    | "version"
    | "policy"
    | "models"
    | "thread_start"
    | "thread_binding";
  readonly detail: string;
};

/** Validate native policy and selection before binding a fresh thread to host tools. */
export async function prepareCodexExplanationThread(
  child: RpcChild,
  home: CodexInsightHome,
  expected: CodexInsightSession,
  input: CodexExplanationInput,
  tools: CodexExplanationTools,
  declarations: ReturnType<typeof codexExplanationDeclarations>,
  attempt: NativeSessionAttemptStore,
): Promise<
  Result<
    { readonly threadId: string; readonly nativeVersion: string },
    CodexExplanationThreadFailure
  >
> {
  const nativeVersion = child.nativeVersion;
  if (nativeVersion !== undefined)
    attempt.record.observed.version = nativeVersion;
  // The durable start needs actual version evidence, not a reviewed-release match.
  if (nativeVersion === undefined)
    return err({ code: "version", detail: "native_policy_unsupported" });
  const valid = await validateCodexInsightSession(
    child,
    input.run.worktreePath,
    home,
    expected,
    input.signal,
  );
  if (valid._tag === "err")
    return err({ code: "policy", detail: valid.error.phase });
  const models = await paginateModelList(child, input.signal);
  if (
    models._tag === "err" ||
    !models.value.some(
      (model) =>
        model.id === input.run.model &&
        model.reasoning.includes(input.run.reasoning),
    )
  )
    return err({ code: "models", detail: "model_list" });
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
      ephemeral: false,
      dynamicTools: declarations,
    },
    input.signal,
  );
  if (thread._tag === "err")
    return err({ code: "thread_start", detail: "thread_start" });
  const observed = parseCodexInsightSelection(thread.value);
  if (observed !== undefined) {
    attempt.record.observed = { ...attempt.record.observed, ...observed };
    attempt.record.capture = { status: "pending", completeness: "unknown" };
    await attempt.save();
  }
  const threadId = parseCodexInsightThread(
    thread.value,
    input.run,
    expected.provider,
  );
  if (threadId === undefined || !tools.bindThread(threadId))
    return err({ code: "thread_binding", detail: "native_policy_unsupported" });
  return ok({ threadId, nativeVersion });
}
