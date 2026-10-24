import { expect, it } from "vitest";
import * as v from "valibot";
import { guideGroupIdSchema } from "#src/domain/guide";
import { CodexExplanationTools } from "#src/adapters/codex/codex-explanation-tools";
import type {
  CodexRpcMessage,
  OutgoingRpcMessage,
} from "#src/adapters/codex/codex-app-server-rpc";
import type { GuideAppOutcome } from "#src/domain/guide-protocol";
import type { CodexDiagnostic } from "#src/adapters/codex/codex-explanation-diagnostics";
import {
  deferred,
  hostIdentity,
  toolMessage,
} from "./codex-explanation-fixture";

function fixture(
  pending?: Promise<GuideAppOutcome>,
  binding: "bound" | "unbound" = "bound",
) {
  const events: CodexDiagnostic[] = [],
    replies: OutgoingRpcMessage[] = [],
    stops: boolean[] = [];
  let calls = 0;
  const tools = new CodexExplanationTools(
    {
      kind: "guide",
      tool: async () => {
        calls++;
        return pending === undefined ? { status: "not_found" } : await pending;
      },
    },
    hostIdentity,
    (reply) => replies.push(reply),
    (id) => ({ id, result: {} }),
    (known) => stops.push(known),
    async () => undefined,
    (event) => events.push(event),
  );
  if (binding === "bound") {
    tools.bindThread("thread-canary");
    tools.bindTurn("turn-canary");
  }
  return { tools, events, replies, stops, calls: () => calls };
}

it.each([0, 1, Number.MAX_SAFE_INTEGER])(
  "admits numeric server ID %s",
  async (id) => {
    const f = fixture();
    f.tools.receive(toolMessage(id), 100);
    await f.tools.join();
    expect(f.calls()).toBe(1);
    expect(f.replies).toHaveLength(1);
    expect(f.stops).toEqual([]);
  },
);
it.each([-0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "id-canary", undefined])(
  "refuses invalid server ID %s",
  (id) => {
    const f = fixture();
    f.tools.receive({ ...toolMessage(), id }, 100);
    expect(f.events).toEqual([["host_refusal", "rpc_id_invalid"]]);
    expect(f.calls()).toBe(0);
    expect(f.stops).toEqual([true]);
  },
);
it.each([
  [{ namespace: "namespace-canary" }, "params_invalid"],
  [{ namespace: undefined }, "params_invalid"],
  [{ callId: "é".repeat(65) }, "params_invalid"],
  [{ callId: "é".repeat(64) + "x" }, "params_invalid"],
  [{ threadId: "wrong-thread" }, "thread_mismatch"],
  [{ turnId: "wrong-turn" }, "turn_mismatch"],
  [{ tool: "unknown-tool" }, "tool_not_allowed"],
  [
    { arguments: { opId: "op", extra: "source-canary" } },
    "guide_frame_invalid",
  ],
] as const)("refuses malformed tool parameters %j", async (params, code) => {
  const f = fixture();
  f.tools.receive(toolMessage(1, params), 100);
  await f.tools.join();
  expect(f.events).toEqual([["host_refusal", code]]);
  expect(f.calls()).toBe(0);
  expect(f.stops).toEqual([true]);
});
it("admits a null namespace and a 128-byte identity", async () => {
  const f = fixture();
  f.tools.receive(toolMessage(0, { callId: "é".repeat(64) }), 32768);
  await f.tools.join();
  expect(f.calls()).toBe(1);
  expect(f.stops).toEqual([]);
});
it("refuses a request one byte above the inclusive wire limit", () => {
  const f = fixture();
  f.tools.receive(toolMessage(), 32769);
  expect(f.events).toEqual([["host_refusal", "request_limit"]]);
  expect(f.calls()).toBe(0);
});
it("refuses an oversized host frame before invoking the operation", async () => {
  const f = fixture();
  f.tools.receive(
    toolMessage(0, { arguments: { opId: "op", extra: "x".repeat(32600) } }),
    32768,
  );
  await f.tools.join();
  expect(f.events).toEqual([["host_refusal", "frame_limit"]]);
  expect(f.calls()).toBe(0);
});
it("bounds the queue at sixteen waiting calls plus one active call", async () => {
  const pending = deferred<GuideAppOutcome>(),
    f = fixture(pending.promise);
  for (let id = 0; id < 17; id++) f.tools.receive(toolMessage(id), 100);
  expect(f.calls()).toBe(1);
  expect(f.stops).toEqual([]);
  f.tools.receive(toolMessage(17), 100);
  pending.resolve({ status: "not_found" });
  await f.tools.join();
  expect(f.events).toEqual([["host_refusal", "queue_full"]]);
  expect(f.calls()).toBe(1);
});
it("replays identical active and cached requests without another operation", async () => {
  const pending = deferred<GuideAppOutcome>(),
    f = fixture(pending.promise),
    message = toolMessage();
  f.tools.receive(message, 100);
  f.tools.receive(message, 100);
  expect(f.calls()).toBe(1);
  pending.resolve({ status: "not_found" });
  await f.tools.join();
  f.tools.receive(message, 100);
  expect(f.replies).toHaveLength(2);
  expect(f.replies[1]).toEqual(f.replies[0]);
  expect(f.calls()).toBe(1);
  expect(f.events).toEqual([]);
});
it("refuses a conflicting replay without another mutation", async () => {
  const f = fixture();
  f.tools.receive(toolMessage(), 100);
  await f.tools.join();
  f.tools.receive(toolMessage(0, { callId: "different" }), 100);
  expect(f.events).toEqual([["host_refusal", "rpc_replay_conflict"]]);
  expect(f.calls()).toBe(1);
});
it("refuses a replay evicted from the sixteen-reply cache", async () => {
  const f = fixture();
  for (let id = 0; id < 17; id++) {
    f.tools.receive(toolMessage(id), 100);
    await f.tools.join();
  }
  f.tools.receive(toolMessage(0), 100);
  expect(f.events).toEqual([["host_refusal", "rpc_replay_evicted"]]);
  expect(f.calls()).toBe(17);
});
it("refuses an ID at the stale 256-ID boundary", async () => {
  const f = fixture();
  f.tools.receive(toolMessage(256), 100);
  await f.tools.join();
  f.tools.receive(toolMessage(0), 100);
  expect(f.events).toEqual([["host_refusal", "rpc_id_stale"]]);
  expect(f.calls()).toBe(1);
});
it("keeps denial replies nonterminal", async () => {
  const f = fixture();
  const message: CodexRpcMessage = {
    id: 1,
    method: "item/commandExecution/requestApproval",
  };
  f.tools.receive(message, 100);
  await f.tools.join();
  expect(f.replies).toHaveLength(1);
  expect(f.calls()).toBe(0);
  expect(f.events).toEqual([]);
});

it.each([32768, 32769])(
  "enforces the encoded reply boundary at %s bytes",
  async (bytes) => {
    const reply = (groupId: string) => ({
      id: 0,
      result: {
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({ accepted: true, sequence: 1, groupId }),
          },
        ],
        success: true,
      },
    });
    const groupId = v.parse(
      guideGroupIdSchema,
      "g" +
        "1".repeat(bytes - Buffer.byteLength(JSON.stringify(reply(""))) - 2),
    );
    const outcome: GuideAppOutcome = {
      status: "receipt",
      sequence: 1,
      result: { groupId },
    };
    const f = fixture(Promise.resolve(outcome));
    f.tools.receive(toolMessage(), 100);
    await f.tools.join();
    expect(f.calls()).toBe(1);
    expect(f.events).toEqual(
      bytes === 32768 ? [] : [["host_refusal", "reply_limit"]],
    );
    expect(f.replies).toHaveLength(bytes === 32768 ? 1 : 0);
    if (bytes === 32768)
      expect(Buffer.byteLength(JSON.stringify(f.replies[0])) + 1).toBe(bytes);
  },
);

it.each(["", "é".repeat(64) + "x"])(
  "refuses thread binding identity %j",
  (threadId) => {
    const f = fixture(undefined, "unbound");
    expect(f.tools.bindThread(threadId)).toBe(false);
    expect(f.events).toEqual([["host_refusal", "thread_identity_invalid"]]);
    expect(f.stops).toEqual([false]);
    expect(f.calls()).toBe(0);
  },
);

it.each([
  ["", "turn_identity_invalid"],
  ["é".repeat(64) + "x", "turn_identity_invalid"],
  ["invalid/turn", "turn_artifact_invalid"],
] as const)("refuses turn binding %j", (turnId, code) => {
  const f = fixture(undefined, "unbound");
  f.tools.bindThread("thread-canary");
  expect(f.tools.bindTurn(turnId)).toBe(false);
  expect(f.events).toEqual([["host_refusal", code]]);
  expect(f.stops).toEqual([false]);
  expect(f.calls()).toBe(0);
});

it("admits bindings at their inclusive 128-byte limits", async () => {
  const f = fixture(undefined, "unbound");
  const threadId = "é".repeat(64),
    turnId = "t".repeat(128);
  expect(f.tools.bindThread(threadId)).toBe(true);
  expect(f.tools.bindTurn(turnId)).toBe(true);
  f.tools.receive(toolMessage(0, { threadId, turnId }), 512);
  await f.tools.join();
  expect(f.calls()).toBe(1);
  expect(f.replies).toHaveLength(1);
  expect(f.events).toEqual([]);
});

it("rejects a queued call when the admitted turn binding disagrees", () => {
  const f = fixture(undefined, "unbound");
  f.tools.bindThread("thread-canary");
  f.tools.receive(toolMessage(0, { turnId: "other-turn" }), 100);
  expect(f.tools.bindTurn("turn-canary")).toBe(false);
  expect(f.events).toEqual([["host_refusal", "queued_turn_mismatch"]]);
  expect(f.stops).toEqual([false]);
  expect(f.calls()).toBe(0);
});

it("refuses a tool request before any thread binding", () => {
  const f = fixture(undefined, "unbound");
  f.tools.receive(toolMessage(), 100);
  expect(f.events).toEqual([["host_refusal", "thread_unbound"]]);
  expect(f.stops).toEqual([true]);
  expect(f.calls()).toBe(0);
});

it("refuses an active replay conflict without starting a second operation", async () => {
  const pending = deferred<GuideAppOutcome>(),
    f = fixture(pending.promise);
  f.tools.receive(toolMessage(), 100);
  f.tools.receive(toolMessage(0, { callId: "conflicting-call" }), 100);
  expect(f.calls()).toBe(1);
  expect(f.events).toEqual([["host_refusal", "rpc_replay_conflict"]]);
  expect(f.stops).toEqual([true]);
  pending.resolve({ status: "not_found" });
  await f.tools.join();
  expect(f.calls()).toBe(1);
  expect(f.replies).toHaveLength(1);
});

it("admits an unseen ID just inside the 256-ID replay window", async () => {
  const f = fixture();
  f.tools.receive(toolMessage(255), 100);
  await f.tools.join();
  f.tools.receive(toolMessage(0), 100);
  await f.tools.join();
  expect(f.calls()).toBe(2);
  expect(f.replies).toMatchObject([{ id: 255 }, { id: 0 }]);
  expect(f.events).toEqual([]);
});

it.each([
  ["unknown", "tool_effect_unknown"],
  ["invalid", "tool_outcome_invalid"],
  ["throws", "tool_callback_threw"],
] as const)("stops after the tool callback %s outcome", async (kind, code) => {
  const outcome: Promise<GuideAppOutcome> =
    kind === "throws"
      ? Promise.reject(new Error("callback-canary"))
      : Promise.resolve(
          kind === "unknown" ? { status: "unknown" } : { status: "stored" },
        );
  const f = fixture(outcome);
  f.tools.receive(toolMessage(), 100);
  await f.tools.join();
  expect(f.calls()).toBe(1);
  expect(f.events).toEqual([["execution_unknown", code]]);
  expect(f.stops).toEqual([false]);
  expect(f.replies).toEqual([]);
});
