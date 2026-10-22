import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createModels,
  type Api,
  type Model,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import * as v from "valibot";

import { InsightEvidenceStore } from "#app/adapters/storage/insight-evidence-store";
import type { PatchdeskPaths } from "#app/adapters/storage/patchdesk-paths";
import { sanitizedInsightFailureDetail } from "#app/domain/insight-failure-diagnostic";
import {
  guideAddMembersInputSchema,
  guideFinishInputSchema,
  guideLookupInputSchema,
  guideOpenGroupInputSchema,
  type GuideRefusalReason,
} from "#app/domain/guide-protocol";
import { loadInsightEvidenceReference } from "#app/services/insight-evidence-reference";
import { composeGuideSessionPrompt } from "#app/services/guide-operation";
import { openGuideChannel, type GuideChannel } from "./guide-child-channel";
import { ExplanationChannelError } from "./explanation-child-channel";
import {
  EXPLANATION_FETCH_APIS,
  ExplanationDispatchRefused,
  createRecordedFetch,
  type ExplanationSessionState,
} from "./explanation-request-dispatch";
import {
  createEvidenceTools,
  jsonSchemaFor,
  type GuideSessionInvocation,
} from "./patchdesk-insight-agent";
import type { PatchdeskChildResult } from "./patchdesk-insight-runner";

const MAX_SYSTEM_PROMPT_BYTES = 32_768;

const REFUSAL_GUIDANCE = {
  stale_identity: "This run's identity is no longer current. Stop.",
  closed: "Writing is closed. Do not call another tool.",
  unknown_group:
    "That group ID was not assigned by open_group. Use a returned groupId.",
  unknown_file:
    "That file ID is not in the captured inventory. Use only inventory IDs.",
  duplicate_member:
    "A file may appear only once within a group. Remove the duplicate and resend.",
  op_conflict:
    "That opId was already used for a different payload. Use a new opId.",
  invalid_input:
    "The input was refused. A group needs a title, an explanation and at least one member before finish.",
  too_large:
    "The call is too large. Split the membership batch and keep the same group.",
  sensitive: "The content looks like a credential or secret and was refused.",
  storage:
    "Patchdesk could not record this call. Use lookup_receipt with the same opId before retrying.",
  cancelled: "The run was cancelled. Stop.",
  unsupported: "The call is not supported.",
} satisfies Record<GuideRefusalReason, string>;

function textContent(text: string) {
  return { type: "text" as const, text };
}

/** Builds the four mutation/lookup tools; every one is a request on the private channel. */
function createGuideSessionTools(
  channel: GuideChannel,
  state: ExplanationSessionState,
  onStop: () => void,
): ReadonlyArray<AgentTool> {
  const tool = <TSchema extends v.GenericSchema>(
    name: "open_group" | "add_members" | "finish" | "lookup_receipt",
    schema: TSchema,
    description: string,
  ): AgentTool => ({
    name,
    label: name,
    description,
    parameters: jsonSchemaFor(schema),
    // Mutations are applied in the order the model made them.
    executionMode: "sequential",
    async execute(_id, args) {
      if (state.finished) throw new Error(REFUSAL_GUIDANCE.closed);
      if (state.halted || state.unconfirmed)
        throw new Error("Patchdesk could not confirm this call. Stop.");
      const parsed = v.safeParse(schema, args);
      if (!parsed.success)
        throw new Error("The tool input does not match its schema.");
      let outcome;
      try {
        outcome = await channel.call({
          kind: "tool",
          // SAFETY: the schema passed for `name` is the closed input schema the frame union selects by tool name.
          call: { tool: name, input: parsed.output } as never,
        });
      } catch (cause: unknown) {
        if (
          cause instanceof ExplanationChannelError &&
          cause.reason === "frame_too_large"
        )
          throw new Error(REFUSAL_GUIDANCE.too_large);
        throw cause;
      }
      if (outcome.status === "unknown") {
        // Patchdesk cannot say whether this call was recorded: stop here rather than spend on a guess.
        state.halted = true;
        onStop();
        throw new Error("Patchdesk could not confirm this call. Stop.");
      }
      if (outcome.status === "refused")
        throw new Error(REFUSAL_GUIDANCE[outcome.reason]);
      if (outcome.status === "not_found")
        return {
          content: [textContent(JSON.stringify({ found: false }))],
          details: undefined,
        };
      if (outcome.status !== "receipt")
        throw new Error("Patchdesk answered unexpectedly.");
      const finished = name === "finish";
      if (finished) {
        state.finished = true;
        onStop();
      }
      return {
        content: [
          textContent(
            JSON.stringify({
              accepted: true,
              sequence: outcome.sequence,
              ...outcome.result,
            }),
          ),
        ],
        details: undefined,
        terminate: finished,
      };
    },
  });
  return [
    tool(
      "open_group",
      guideOpenGroupInputSchema,
      "Open the next logical group with a short title and explanation. Returns the assigned groupId.",
    ),
    tool(
      "add_members",
      guideAddMembersInputSchema,
      "Add file IDs from the captured inventory, each with a short relevance note, to an open group. A batch must fit the encoded byte limit; split larger batches.",
    ),
    tool(
      "finish",
      guideFinishInputSchema,
      "Close writing once every intended group and membership is accepted. Patchdesk validates and publishes afterwards.",
    ),
    tool(
      "lookup_receipt",
      guideLookupInputSchema,
      "Read the receipt of an earlier opId, or learn that none was accepted.",
    ),
  ];
}

/**
 * Runs one Guide generation. The model loop stays in this process; the only route to the app is the private channel.
 * Every provider request is recorded by the app before it is sent, retries are off (the SDK's and the runner's), and
 * a provider API whose installed adapter does not route HTTP through the supplied fetch is refused before any network.
 */
export async function runGuideSession(
  invocation: GuideSessionInvocation,
  options: {
    readonly paths: PatchdeskPaths;
    readonly signal: AbortSignal;
    readonly providers?: ReadonlyArray<Provider>;
    readonly openChannel?: typeof openGuideChannel;
  },
): Promise<PatchdeskChildResult> {
  const loaded = await loadInsightEvidenceReference(
    invocation.evidence,
    options.paths,
  );
  if (loaded._tag === "err")
    return {
      ok: false,
      reason: loaded.error.reason,
      detail: "Captured evidence is unavailable or does not match this run.",
    };
  const bundle = loaded.value;
  const prompt = composeGuideSessionPrompt(
    invocation.evidence,
    invocation.language,
  );
  if (
    Buffer.byteLength(prompt + "Complete the prepared Patchdesk operation.") >
    MAX_SYSTEM_PROMPT_BYTES
  )
    return { ok: false, reason: "invalid_input", detail: "prompt_too_large" };
  const models = createModels();
  for (const provider of options.providers ?? builtinProviders())
    models.setProvider(provider);
  const model = resolveGuideModel(models, invocation.model);
  if (model === undefined) return { ok: false, reason: "runtime_unavailable" };
  if (!EXPLANATION_FETCH_APIS.has(model.api))
    return {
      ok: false,
      reason: "runtime_unavailable",
      detail: "unsupported_route",
    };
  const channel = (options.openChannel ?? openGuideChannel)(invocation.channel);
  const state: ExplanationSessionState = {
    finished: false,
    halted: false,
    unconfirmed: false,
  };
  const recordedFetch = createRecordedFetch(channel, state);
  let abortAgent = (): void => undefined;
  let dispatchRefusal: string | undefined;
  const tools = [
    ...createGuideSessionTools(channel, state, () => abortAgent()),
    ...createEvidenceTools(bundle, new InsightEvidenceStore(options.paths)),
  ];
  const agent = new Agent({
    initialState: {
      systemPrompt: prompt,
      model,
      thinkingLevel: invocation.reasoning,
      tools,
    },
    streamFn: async (requested, context, streamOptions) => {
      const stream = models.streamSimple(requested, context, {
        ...streamOptions,
        // The SDK's own retry stays off and the runner's retry wrapper is not used on this path.
        maxRetries: 0,
        fetch: async (input, init) => {
          try {
            return await recordedFetch(input, init);
          } catch (cause: unknown) {
            if (cause instanceof ExplanationDispatchRefused)
              dispatchRefusal = cause.reason;
            throw cause;
          }
        },
      });
      // onResponse runs at headers; result resolves after SDK consumption and terminal validation, including normal SSE cancellation.
      void stream
        .result()
        .then((message) => {
          if (
            !state.halted &&
            message.stopReason !== "error" &&
            message.stopReason !== "aborted"
          )
            state.unconfirmed = false;
          else if (state.unconfirmed) {
            state.halted = true;
            abortAgent();
          }
        })
        .catch(() => {
          if (state.unconfirmed) {
            state.halted = true;
            abortAgent();
          }
        });
      return stream;
    },
    toolExecution: "parallel",
  });
  abortAgent = () => agent.abort();
  const running = agent;
  const abort = (): void => running.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal.aborted) return { ok: false, reason: "cancelled" };
    await running.prompt("Complete the prepared Patchdesk operation.");
    if (state.finished) return { ok: true, value: { finished: true } };
    if (state.halted)
      return {
        ok: false,
        reason: "execution_failed",
        detail: "outcome_unknown",
      };
    if (state.unconfirmed)
      return {
        ok: false,
        reason: "execution_failed",
        detail: "request_unconfirmed",
      };
    if (options.signal.aborted) return { ok: false, reason: "cancelled" };
    if (dispatchRefusal !== undefined)
      return {
        ok: false,
        reason: "execution_failed",
        detail: `dispatch_refused:${dispatchRefusal}`,
      };
    const failure = failureMessage(running);
    return failure === undefined
      ? { ok: false, reason: "invalid_result", detail: "finish_not_called" }
      : {
          ok: false,
          reason: "execution_failed",
          detail: sanitizedInsightFailureDetail(failure),
        };
  } catch (cause: unknown) {
    if (state.halted || state.unconfirmed)
      return {
        ok: false,
        reason: "execution_failed",
        detail: state.halted ? "outcome_unknown" : "request_unconfirmed",
      };
    return options.signal.aborted
      ? { ok: false, reason: "cancelled" }
      : {
          ok: false,
          reason: "execution_failed",
          detail: sanitizedInsightFailureDetail(cause),
        };
  } finally {
    options.signal.removeEventListener("abort", abort);
    channel.close();
  }
}

function resolveGuideModel(
  models: Models,
  specifier: string,
): Model<Api> | undefined {
  const slash = specifier.indexOf("/");
  return slash <= 0 || slash === specifier.length - 1
    ? undefined
    : models.getModel(specifier.slice(0, slash), specifier.slice(slash + 1));
}

function failureMessage(agent: Agent): string | undefined {
  if (agent.state.errorMessage !== undefined) return agent.state.errorMessage;
  const last = agent.state.messages.at(-1);
  if (last === undefined || last.role !== "assistant") return undefined;
  return last.stopReason === "error" || last.stopReason === "aborted"
    ? (last.errorMessage ?? "The model run failed without a reason")
    : undefined;
}
