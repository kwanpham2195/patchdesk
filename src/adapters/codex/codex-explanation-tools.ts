import { createHash } from "node:crypto";
import type {
  CodexDiagnostic,
  CodexDiagnosticFields,
  CodexDiagnosticObserver,
} from "./codex-explanation-diagnostics";
import { toJsonSchema, type JsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import {
  guideOpenGroupInputSchema,
  guideAddMembersInputSchema,
  guideFinishInputSchema,
  guideLookupInputSchema,
  guideChildFrameSchema,
  type GuideChildFrame,
  type GuideAppOutcome,
} from "#src/domain/guide-protocol";
import {
  walkthroughInputSchemas,
  walkthroughChildFrameSchema,
  type WalkthroughToolCall,
  type WalkthroughAppOutcome,
} from "#src/domain/walkthrough-protocol";
import type { ExplanationConnectionIdentity } from "#src/domain/explanation-channel";
import { insightArtifactIdSchema } from "#src/domain/insight-artifact-scalars";
import type {
  CodexRpcMessage,
  OutgoingRpcMessage,
} from "./codex-app-server-rpc";

const guideSchemas = {
  open_group: guideOpenGroupInputSchema,
  add_members: guideAddMembersInputSchema,
  finish: guideFinishInputSchema,
  lookup_receipt: guideLookupInputSchema,
};
const guideDescriptions = {
  open_group:
    "Open the next logical group with a short title and explanation. Returns the assigned groupId.",
  add_members:
    "Add file IDs from the captured inventory, each with a short relevance note, to an open group. A batch must fit the encoded byte limit; split larger batches.",
  finish:
    "Close writing once every intended group and membership is accepted. Patchdesk validates and publishes afterwards.",
  lookup_receipt:
    "Read the receipt of an earlier opId, or learn that none was accepted.",
};
/** Canonical functions use existing host schemas; there is no namespace wrapper. */
export function codexExplanationDeclarations(
  kind: "guide" | "walkthrough",
): ReadonlyArray<{
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}> {
  const schemas = kind === "guide" ? guideSchemas : walkthroughInputSchemas;
  return Object.entries(schemas).map(([name, schema]) => ({
    type: "function" as const,
    name,
    description:
      kind === "guide"
        ? (Object.entries(guideDescriptions).find(
            ([key]) => key === name,
          )?.[1] ?? "")
        : name === "lookup_receipt"
          ? "Read the exact original receipt of an opId without creating an operation."
          : `Apply ${name} in reading order. Each mutation needs a unique opId.`,
    inputSchema: toJsonSchema(schema, { errorMode: "ignore" }),
  }));
}

type GuideCall = Extract<GuideChildFrame, { kind: "tool" }>["call"];
export type CodexExplanationBinding =
  | {
      readonly kind: "guide";
      readonly tool: (call: GuideCall) => Promise<GuideAppOutcome>;
    }
  | {
      readonly kind: "walkthrough";
      readonly tool: (
        call: WalkthroughToolCall,
      ) => Promise<WalkthroughAppOutcome>;
    };
const identity = v.pipe(
  v.string(),
  v.nonEmpty(),
  v.check((value) => Buffer.byteLength(value) <= 128),
);
const callParams = v.strictObject({
  threadId: identity,
  turnId: identity,
  callId: identity,
  namespace: v.null_(),
  tool: v.string(),
  arguments: v.unknown(),
});
type PendingCall = {
  readonly id: number;
  readonly fingerprint: string;
  readonly params: v.InferOutput<typeof callParams>;
};
/** Bounds the complete wire envelope, including LF and escaped inner receipt JSON. */
function codexExplanationReplyFits(message: OutgoingRpcMessage): boolean {
  return Buffer.byteLength(JSON.stringify(message), "utf8") + 1 <= 32768;
}

/** Serial operations and bounded replay state belong to one native connection. */
export class CodexExplanationTools {
  private readonly queue: PendingCall[] = [];
  private readonly seen = new Set<number>();
  private readonly active = new Map<number, string>();
  private readonly replies = new Map<
    number,
    { readonly fingerprint: string; readonly message: OutgoingRpcMessage }
  >();
  private greatestId = -1;
  private turnId: string | undefined;
  private threadId: string | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  private correlation = 0;

  constructor(
    private readonly binding: CodexExplanationBinding,
    private readonly hostIdentity: ExplanationConnectionIdentity,
    private readonly send: (message: OutgoingRpcMessage) => void,
    private readonly fallback: (
      id: number,
      method: string,
    ) => OutgoingRpcMessage,
    private readonly halt: (effectKnown: boolean) => void,
    private readonly finish: () => Promise<void>,
    private readonly diagnostic?: CodexDiagnosticObserver,
  ) {}

  get halted(): boolean {
    return this.closed;
  }

  bindThread(threadId: string): boolean {
    if (this.closed) return false;
    if (!v.is(identity, threadId)) {
      this.stop(false, ["host_refusal", "thread_identity_invalid"]);
      return false;
    }
    this.threadId = threadId;
    return true;
  }

  bindTurn(turnId: string): boolean {
    const refusal = !v.is(identity, turnId)
      ? "turn_identity_invalid"
      : !v.is(insightArtifactIdSchema, turnId)
        ? "turn_artifact_invalid"
        : this.queue.some((call) => call.params.turnId !== turnId)
          ? "queued_turn_mismatch"
          : undefined;
    if (refusal !== undefined) {
      this.stop(false, ["host_refusal", refusal]);
      return false;
    }
    this.turnId = turnId;
    this.drain();
    return !this.closed;
  }

  receive(message: CodexRpcMessage, bytes: number): void {
    if (this.closed) return;
    const { id, method } = message;
    const namespace = v.safeParse(
      v.looseObject({ namespace: v.optional(v.unknown()) }),
      message.params,
    );
    const fields: CodexDiagnosticFields = {
      rpcIdKind:
        id === undefined
          ? "missing"
          : v.is(v.string(), id)
            ? "string"
            : Number.isSafeInteger(id) && id >= 0 && !Object.is(id, -0)
              ? "valid_number"
              : "invalid_number",
      namespaceKind:
        !namespace.success || !Object.hasOwn(namespace.output, "namespace")
          ? "missing"
          : namespace.output.namespace === null
            ? "null"
            : v.is(v.string(), namespace.output.namespace)
              ? "string"
              : "other",
      bytes,
    };
    if (
      !v.is(v.pipe(v.number(), v.safeInteger()), id) ||
      id < 0 ||
      Object.is(id, -0) ||
      method === undefined
    ) {
      this.stop(
        true,
        [
          "host_refusal",
          fields.rpcIdKind !== "valid_number"
            ? "rpc_id_invalid"
            : "rpc_method_missing",
        ],
        fields,
      );
      return;
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ method, params: message.params }))
      .digest("hex");
    if (id <= this.greatestId - 256) {
      this.stop(true, ["host_refusal", "rpc_id_stale"], fields);
      return;
    }
    if (this.seen.has(id)) {
      const pending = this.active.get(id);
      const reply = this.replies.get(id);
      if (pending === fingerprint) return;
      if (reply?.fingerprint === fingerprint) {
        this.send(reply.message);
        return;
      }
      this.stop(
        true,
        [
          "host_refusal",
          pending !== undefined || reply !== undefined
            ? "rpc_replay_conflict"
            : "rpc_replay_evicted",
        ],
        fields,
      );
      return;
    }
    this.greatestId = Math.max(id, this.greatestId);
    for (const previous of this.seen)
      if (previous <= this.greatestId - 256) this.seen.delete(previous);
    this.seen.add(id);
    if (method !== "item/tool/call") {
      this.complete(id, fingerprint, this.fallback(id, method));
      return;
    }
    const parsed = v.safeParse(callParams, message.params);
    const refusal =
      bytes > 32768
        ? "request_limit"
        : !parsed.success
          ? "params_invalid"
          : this.threadId === undefined
            ? "thread_unbound"
            : parsed.output.threadId !== this.threadId
              ? "thread_mismatch"
              : this.turnId !== undefined &&
                  parsed.output.turnId !== this.turnId
                ? "turn_mismatch"
                : !Object.hasOwn(
                      this.binding.kind === "guide"
                        ? guideSchemas
                        : walkthroughInputSchemas,
                      parsed.output.tool,
                    )
                  ? "tool_not_allowed"
                  : Buffer.byteLength(JSON.stringify(parsed.output.arguments)) >
                      32768
                    ? "arguments_limit"
                    : undefined;
    if (refusal !== undefined || !parsed.success) {
      this.stop(true, ["host_refusal", refusal ?? "params_invalid"], {
        ...fields,
        binding:
          this.threadId === undefined
            ? "unbound"
            : !parsed.success
              ? "unparsed"
              : parsed.output.threadId !== this.threadId
                ? "thread_mismatch"
                : this.turnId !== undefined &&
                    parsed.output.turnId !== this.turnId
                  ? "turn_mismatch"
                  : "matched",
      });
      return;
    }
    if (this.queue.length >= 16) {
      this.stop(true, ["host_refusal", "queue_full"], fields);
      return;
    }
    this.active.set(id, fingerprint);
    this.queue.push({ id, fingerprint, params: parsed.output });
    this.drain();
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }
  async join(): Promise<void> {
    await this.running;
  }

  private stop(
    effectKnown: boolean,
    event: CodexDiagnostic,
    fields: CodexDiagnosticFields = {},
  ): void {
    this.diagnostic?.(event, {
      ...fields,
      queued: this.queue.length,
      active: Math.min(1, this.active.size - this.queue.length),
      seen: this.seen.size,
      cached: this.replies.size,
    });
    this.close();
    this.halt(effectKnown);
  }
  private drain(): void {
    if (
      this.closed ||
      this.queue.length === 0 ||
      this.turnId === undefined ||
      this.running !== undefined
    )
      return;
    this.running = this.consume()
      .catch(() =>
        this.stop(false, ["execution_unknown", "tool_callback_threw"]),
      )
      .finally(() => {
        this.running = undefined;
        if (!this.closed && this.queue.length > 0) this.drain();
      });
  }

  private async consume(): Promise<void> {
    while (!this.closed) {
      const call = this.queue.shift();
      if (call === undefined) return;
      const frame = {
        kind: "tool",
        ...this.hostIdentity,
        correlation: ++this.correlation,
        call: { tool: call.params.tool, input: call.params.arguments },
      };
      const frameBytes = Buffer.byteLength(JSON.stringify(frame));
      const refusal =
        frameBytes > 32768
          ? "frame_limit"
          : Buffer.byteLength(JSON.stringify(frame.call)) > 32768
            ? "call_limit"
            : undefined;
      if (refusal !== undefined) {
        this.stop(true, ["host_refusal", refusal], { bytes: frameBytes });
        return;
      }
      let outcome: GuideAppOutcome | WalkthroughAppOutcome;
      if (this.binding.kind === "guide") {
        const parsed = v.safeParse(guideChildFrameSchema, frame);
        if (!parsed.success || parsed.output.kind !== "tool") {
          this.stop(true, ["host_refusal", "guide_frame_invalid"]);
          return;
        }
        outcome = await this.binding.tool(parsed.output.call);
      } else {
        const parsed = v.safeParse(walkthroughChildFrameSchema, frame);
        if (!parsed.success || parsed.output.kind !== "tool") {
          this.stop(true, ["host_refusal", "walkthrough_frame_invalid"]);
          return;
        }
        outcome = await this.binding.tool(parsed.output.call);
      }
      if (outcome.status === "unknown") {
        this.stop(false, ["execution_unknown", "tool_effect_unknown"]);
        return;
      }
      if (
        outcome.status !== "receipt" &&
        outcome.status !== "not_found" &&
        outcome.status !== "refused"
      ) {
        this.stop(false, ["execution_unknown", "tool_outcome_invalid"]);
        return;
      }
      const text = JSON.stringify(
        outcome.status === "receipt"
          ? { accepted: true, sequence: outcome.sequence, ...outcome.result }
          : outcome.status === "not_found"
            ? { found: false }
            : { refused: outcome.reason },
      );
      const reply = {
        id: call.id,
        result: {
          contentItems: [{ type: "inputText", text }],
          success: outcome.status !== "refused",
        },
      };
      if (call.params.tool === "finish" && outcome.status === "receipt") {
        this.diagnostic?.(["finish_accepted", "finish_signal"]);
        this.close();
        await this.finish();
      }
      if (!codexExplanationReplyFits(reply)) {
        this.stop(true, ["host_refusal", "reply_limit"]);
        return;
      }
      this.complete(call.id, call.fingerprint, reply);
    }
  }

  private complete(
    id: number,
    fingerprint: string,
    message: OutgoingRpcMessage,
  ): void {
    this.active.delete(id);
    this.replies.set(id, { fingerprint, message });
    if (this.replies.size > 16) {
      const oldest = this.replies.keys().next().value;
      if (oldest !== undefined) this.replies.delete(oldest);
    }
    this.send(message);
  }
}
