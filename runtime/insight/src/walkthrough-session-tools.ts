import type { AgentTool } from "@earendil-works/pi-agent-core";
import { walkthroughInputLimitDiagnostic } from "#app/domain/walkthrough-input-diagnostic";
import * as v from "valibot";
import {
  walkthroughAppReplySchema,
  walkthroughChildFrameSchema,
  walkthroughInputSchemas,
  type WalkthroughChildFrame,
  type WalkthroughAppOutcome,
  type WalkthroughRefusalReason,
} from "#app/domain/walkthrough-protocol";
import type { ExplanationConnectionIdentity } from "#app/domain/explanation-channel";
import {
  openExplanationChannel,
  ExplanationChannelError,
} from "./explanation-child-channel";
import type { ExplanationSessionState } from "./explanation-request-dispatch";
import { jsonSchemaFor } from "./patchdesk-insight-agent";

type Request<T> = T extends unknown
  ? Omit<T, keyof ExplanationConnectionIdentity | "correlation">
  : never;
const guidance = {
  stale_identity: "This generation is no longer current. Stop.",
  closed: "Writing is closed. Stop.",
  already_started:
    "Metadata was already accepted. Continue the current reading path.",
  not_started: "Call begin_walkthrough first.",
  unknown_chapter: "Only the most recently assigned chapter accepts sections.",
  unknown_section: "Only the most recently assigned section accepts citations.",
  unknown_hunk: "Use hunk IDs from captured citation pages.",
  duplicate_citation:
    "Cite each hunk only once in the entire reading path. Remove duplicates and resend the batch.",
  op_conflict: "This opId already names different arguments. Use a new opId.",
  invalid_input:
    "Check concise fields and reading order. Complete the current section's citations and chapter before opening another.",
  too_large: "Split the citation batch, not the logical section.",
  sensitive: "Content resembling a credential or secret was refused.",
  storage: "Use lookup_receipt with the same opId before retrying.",
  cancelled: "The run was cancelled. Stop.",
  unsupported: "The call is unsupported.",
} satisfies Record<WalkthroughRefusalReason, string>;

type WalkthroughSession = {
  readonly channel: ReturnType<
    typeof openExplanationChannel<
      Request<WalkthroughChildFrame>,
      WalkthroughAppOutcome
    >
  >;
  readonly tools: ReadonlyArray<AgentTool>;
};

/** Opens the Walkthrough-selected reply schema and constructs its six sequential tools. */
export function openWalkthroughSession(
  identity: ExplanationConnectionIdentity,
  state: ExplanationSessionState,
  onStop: () => void,
): WalkthroughSession {
  const channel = openExplanationChannel<
    Request<WalkthroughChildFrame>,
    WalkthroughAppOutcome
  >(identity, walkthroughAppReplySchema);
  return {
    channel,
    tools: createWalkthroughSessionTools(identity, channel, state, onStop),
  };
}

/** Constructs the strict sequential producer tools over the admitted channel. */
export function createWalkthroughSessionTools(
  identity: ExplanationConnectionIdentity,
  channel: Pick<WalkthroughSession["channel"], "call">,
  state: ExplanationSessionState,
  onStop: () => void,
): ReadonlyArray<AgentTool> {
  const tools = Object.entries(walkthroughInputSchemas).map(
    ([name, schema]): AgentTool => ({
      name,
      label: name,
      description:
        name === "lookup_receipt"
          ? "Read the exact original receipt of an opId without creating an operation."
          : `Apply ${name} in reading order. Each mutation needs a unique opId.`,
      parameters: jsonSchemaFor(schema),
      executionMode: "sequential",
      async execute(_id, args) {
        if (state.halted || state.unconfirmed)
          throw new Error("Patchdesk could not confirm an effect. Stop.");
        if (state.finished && name !== "lookup_receipt" && name !== "finish")
          throw new Error(guidance.closed);
        if (Buffer.byteLength(JSON.stringify(args)) > 32768)
          throw new Error(guidance.too_large);
        const input = v.safeParse(schema, args);
        if (!input.success)
          throw new Error(
            walkthroughInputLimitDiagnostic(input.issues) ??
              guidance.invalid_input,
          );
        const parsed = v.safeParse(walkthroughChildFrameSchema, {
          kind: "tool",
          ...identity,
          correlation: 1,
          call: { tool: name, input: input.output },
        });
        if (!parsed.success || parsed.output.kind !== "tool")
          throw new Error(guidance.invalid_input);
        let outcome: WalkthroughAppOutcome;
        try {
          outcome = await channel.call({
            kind: "tool",
            call: parsed.output.call,
          });
        } catch (cause: unknown) {
          if (
            cause instanceof ExplanationChannelError &&
            cause.reason === "frame_too_large"
          )
            throw new Error(guidance.too_large);
          throw cause;
        }
        if (outcome.status === "unknown") {
          state.halted = true;
          onStop();
          throw new Error("Patchdesk could not confirm an effect. Stop.");
        }
        if (outcome.status === "refused")
          throw new Error(guidance[outcome.reason]);
        if (outcome.status !== "receipt" && outcome.status !== "not_found")
          throw new Error("Unexpected channel response.");
        const text =
          outcome.status === "not_found"
            ? JSON.stringify({ found: false })
            : JSON.stringify({
                accepted: true,
                sequence: outcome.sequence,
                ...outcome.result,
              });
        const content = [{ type: "text" as const, text }];
        if (Buffer.byteLength(JSON.stringify({ content })) > 32768) {
          state.halted = true;
          onStop();
          throw new Error(guidance.too_large);
        }
        const finished = name === "finish" && outcome.status === "receipt";
        if (finished) {
          state.finished = true;
          onStop();
        }
        return { content, details: undefined, terminate: finished };
      },
    }),
  );
  return tools;
}
