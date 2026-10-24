import { expect, it } from "vitest";
import { CodexExplanationTools } from "#src/adapters/codex/codex-explanation-tools";
import {
  RpcChild,
  type OutgoingRpcMessage,
} from "#src/adapters/codex/codex-app-server-rpc";
import type { ExplanationConnectionIdentity } from "#src/domain/explanation-channel";
import type {
  CodexDiagnostic,
  CodexDiagnosticFields,
} from "#src/adapters/codex/codex-explanation-diagnostics";
import {
  ExplanationProcess,
  asExplanationChild,
  hostIdentity,
  toolMessage,
} from "./codex-explanation-fixture";

function fixture(
  kind: "guide" | "walkthrough",
  identity: ExplanationConnectionIdentity = hostIdentity,
) {
  const events: {
    event: CodexDiagnostic;
    fields: CodexDiagnosticFields | undefined;
  }[] = [];
  const replies: OutgoingRpcMessage[] = [],
    stops: boolean[] = [];
  let calls = 0;
  const tool = async () => {
    calls++;
    return { status: "not_found" as const };
  };
  const tools = new CodexExplanationTools(
    kind === "guide" ? { kind, tool } : { kind, tool },
    identity,
    (reply) => replies.push(reply),
    (id) => ({ id, result: {} }),
    (known) => stops.push(known),
    async () => undefined,
    (event, fields) => events.push({ event, fields }),
  );
  tools.bindThread("thread-canary");
  tools.bindTurn("turn-canary");
  return { tools, events, replies, stops, calls: () => calls };
}

it.each([32768, 32769])(
  "checks the actual host frame at %s bytes",
  async (bytes) => {
    const identity = { ...hostIdentity, connection: "c".repeat(64) },
      f = fixture("guide", identity);
    const frame = (fileId: string) => ({
      kind: "tool",
      ...identity,
      correlation: 1,
      call: {
        tool: "add_members",
        input: {
          opId: "op",
          groupId: "g1",
          members: [{ fileId, relevance: "x" }],
        },
      },
    });
    const fileId =
      "f" +
      "1".repeat(bytes - Buffer.byteLength(JSON.stringify(frame(""))) - 1);
    const actual = frame(fileId);
    const request = toolMessage(0, {
      tool: "add_members",
      arguments: actual.call.input,
    });
    const wireBytes = Buffer.byteLength(JSON.stringify(request)) + 1;
    expect(Buffer.byteLength(JSON.stringify(actual))).toBe(bytes);
    expect(wireBytes).toBeLessThanOrEqual(32768);
    expect(Buffer.byteLength(JSON.stringify(actual.call))).toBeLessThan(32768);
    f.tools.receive(request, wireBytes);
    await f.tools.join();
    expect(f.calls()).toBe(bytes === 32768 ? 1 : 0);
    expect(f.replies).toHaveLength(bytes === 32768 ? 1 : 0);
    expect(f.events.map((item) => item.event)).toEqual(
      bytes === 32768 ? [] : [["host_refusal", "frame_limit"]],
    );
    if (bytes === 32769) expect(f.events[0]?.fields?.bytes).toBe(bytes);
  },
);

it("rejects invalid Walkthrough frames before the operation callback", async () => {
  const f = fixture("walkthrough");
  const request = toolMessage(0, {
    arguments: { opId: "op", extra: "source-canary" },
  });
  f.tools.receive(request, Buffer.byteLength(JSON.stringify(request)) + 1);
  await f.tools.join();
  expect(f.events.map((item) => item.event)).toEqual([
    ["host_refusal", "walkthrough_frame_invalid"],
  ]);
  expect(f.stops).toEqual([true]);
  expect(f.calls()).toBe(0);
  expect(f.replies).toEqual([]);
});

it("rejects normalized arguments that expand beyond the limit inside a small wire request", async () => {
  const f = fixture("guide"),
    process = new ExplanationProcess();
  const rpc = new RpcChild(() => asExplanationChild(process));
  expect((await rpc.start("fixture", undefined))._tag).toBe("ok");
  rpc.onServerRequest = (message, bytes) => f.tools.receive(message, bytes);
  const argumentsText =
    '{"values":[' + Array.from({ length: 1600 }, () => "1e20").join(",") + "]}";
  const wire =
    '{"id":0,"method":"item/tool/call","params":{"threadId":"thread-canary","turnId":"turn-canary","callId":"call-canary","namespace":null,"tool":"lookup_receipt","arguments":' +
    argumentsText +
    "}}\n";
  expect(Buffer.byteLength(wire)).toBeLessThan(32768);
  expect(
    Buffer.byteLength(JSON.stringify(JSON.parse(argumentsText))),
  ).toBeGreaterThan(32768);
  process.stdout.write(wire);
  await f.tools.join();
  expect(f.events.map((item) => item.event)).toEqual([
    ["host_refusal", "arguments_limit"],
  ]);
  expect(f.events[0]?.fields?.bytes).toBe(Buffer.byteLength(wire));
  expect(f.stops).toEqual([true]);
  expect(f.calls()).toBe(0);
  expect(f.replies).toEqual([]);
  await rpc.stop();
});

it.each([32768, 32769])(
  "enforces dynamic request wire size including LF at %s bytes",
  async (bytes) => {
    const process = new ExplanationProcess(),
      routed: number[] = [],
      events: CodexDiagnostic[] = [];
    const rpc = new RpcChild(
      () => asExplanationChild(process),
      (event) => events.push(event),
    );
    await rpc.start("fixture", undefined);
    rpc.onServerRequest = (_message, count) => routed.push(count);
    const envelope = (padding: string) =>
      toolMessage(0, { arguments: { padding } });
    const padding = "x".repeat(
      bytes - Buffer.byteLength(JSON.stringify(envelope(""))) - 1,
    );
    const wire = JSON.stringify(envelope(padding)) + "\n";
    expect(Buffer.byteLength(wire)).toBe(bytes);
    process.stdout.write(wire);
    expect(routed).toEqual(bytes === 32768 ? [32768] : []);
    expect(events).toEqual(
      bytes === 32768 ? [] : [["transport_lost", "dynamic_request_limit"]],
    );
    await rpc.stop();
  },
);
