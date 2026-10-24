import { afterEach, expect, it, vi } from "vitest";
import { RpcChild } from "#src/adapters/codex/codex-app-server-rpc";
import type {
  CodexDiagnostic,
  CodexDiagnosticFields,
} from "#src/adapters/codex/codex-explanation-diagnostics";
import {
  ExplanationProcess,
  asExplanationChild,
} from "./codex-explanation-fixture";

afterEach(() => vi.useRealTimers());
async function fixture() {
  const process = new ExplanationProcess();
  const events: {
    event: CodexDiagnostic;
    fields: CodexDiagnosticFields;
    stopping: boolean;
  }[] = [];
  const child = new RpcChild(
    () => asExplanationChild(process),
    (event, fields, stopping) => events.push({ event, fields, stopping }),
  );
  await child.start("fixture", undefined);
  process.onRequest = () => true;
  return { process, child, events };
}
it.each([
  "stdin_error",
  "process_error",
  "process_exit",
  "stream_limit",
  "dynamic_request_limit",
  "envelope_invalid",
  "decode_or_route_threw",
] as const)("classifies %s before settling transport failure", async (code) => {
  const f = await fixture(),
    request = f.child.request("fixture", {});
  f.child.onServerRequest = () => undefined;
  if (code === "stdin_error")
    f.process.stdin.emit("error", new Error("stdin-stack-canary"));
  else if (code === "process_error")
    f.process.emit("error", new Error("process-cause-canary"));
  else if (code === "process_exit")
    f.process.emit("exit", 255, "signal-canary");
  else if (code === "stream_limit") f.process.stdout.write("x".repeat(8388609));
  else if (code === "dynamic_request_limit")
    f.process.stdout.write(
      JSON.stringify({
        id: 1,
        method: "item/tool/call",
        params: "x".repeat(32768),
      }) + "\n",
    );
  else
    f.process.stdout.write(
      code === "envelope_invalid" ? '{"id":null}\n' : "{\n",
    );
  expect(f.events[0]?.event).toEqual(["transport_lost", code]);
  expect(await request).toEqual({ _tag: "err", error: "process_failed" });
  expect(JSON.stringify(f.events)).not.toContain("canary");
  if (code === "process_exit")
    expect(f.events[0]?.fields).toEqual({ exit: "nonzero", signal: "other" });
  await f.child.stop();
});
it.each([
  "request_timeout",
  "request_aborted",
  "request_stopped",
  "remote_rpc_error",
  "rpc_result_invalid",
] as const)("records %s without inventing a run deadline", async (code) => {
  vi.useFakeTimers();
  const f = await fixture(),
    abort = new AbortController();
  const request = f.child.request("fixture", {}, abort.signal, 10);
  const id = f.process.received.at(-1)?.id;
  if (code === "request_timeout") await vi.advanceTimersByTimeAsync(10);
  else if (code === "request_aborted") abort.abort("abort-canary");
  else if (code === "request_stopped") await f.child.stop();
  else
    f.process.write(
      code === "remote_rpc_error"
        ? { id, error: { code: "code-canary", message: "message-canary" } }
        : { id, result: "result-canary" },
    );
  expect((await request)._tag).toBe("err");
  expect(f.events[0]?.event).toEqual(["rpc_detail", code]);
  expect(JSON.stringify(f.events)).not.toContain("canary");
  await f.child.stop();
});
it("marks synchronous cancel-write failures as stopping before callbacks", async () => {
  const f = await fixture();
  f.child.bindTurn("thread", "turn");
  f.process.stdin.on("data", () =>
    f.process.stdin.emit("error", new Error("cancel-canary")),
  );
  await f.child.stop();
  expect(f.events[0]).toMatchObject({
    event: ["transport_lost", "stdin_error"],
    stopping: true,
  });
});

it.each(["stdin", "stdout", "stderr"] as const)(
  "classifies a missing %s pipe without starting a request",
  async (pipe) => {
    const process = new ExplanationProcess(),
      child = asExplanationChild(process),
      events: CodexDiagnostic[] = [];
    child[pipe] = null;
    const rpc = new RpcChild(
      () => child,
      (event) => events.push(event),
    );
    expect(await rpc.start("fixture", undefined)).toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable", phase: "initialize" },
    });
    expect(events).toEqual([["rpc_detail", "pipes_missing"]]);
    expect(process.received).toEqual([]);
    await rpc.stop();
  },
);

it.each(["spawn", "initialize"] as const)(
  "safely classifies a thrown %s failure",
  async (stage) => {
    const process = new ExplanationProcess(),
      events: CodexDiagnostic[] = [];
    process.onRequest = () => {
      throw new Error("initialize-canary", { cause: "cause-canary" });
    };
    const rpc = new RpcChild(
      () => {
        if (stage === "spawn")
          throw new Error("spawn-canary", { cause: "cause-canary" });
        return asExplanationChild(process);
      },
      (event) => events.push(event),
    );
    expect(await rpc.start("fixture", undefined)).toMatchObject({
      _tag: "err",
      error: { reason: "execution_failed", phase: "initialize" },
    });
    expect(events[0]).toEqual(["rpc_detail", "spawn_or_initialize_threw"]);
    expect(JSON.stringify(events)).not.toContain("canary");
    await rpc.stop();
  },
);

it("classifies an unavailable request without spawning", async () => {
  const events: CodexDiagnostic[] = [];
  let spawns = 0;
  const rpc = new RpcChild(
    () => {
      spawns++;
      return asExplanationChild(new ExplanationProcess());
    },
    (event) => events.push(event),
  );
  expect(await rpc.request("fixture", {})).toEqual({
    _tag: "err",
    error: "process_unavailable",
  });
  expect(events).toEqual([["rpc_detail", "request_unavailable"]]);
  expect(spawns).toBe(0);
  await rpc.stop();
});

it("classifies an already aborted request without writing it", async () => {
  const f = await fixture(),
    abort = new AbortController(),
    before = f.process.received.length;
  abort.abort("abort-reason-canary");
  expect(await f.child.request("fixture", {}, abort.signal)).toEqual({
    _tag: "err",
    error: "cancelled",
  });
  expect(f.events.map((item) => item.event)).toEqual([
    ["rpc_detail", "request_aborted"],
  ]);
  expect(f.process.received).toHaveLength(before);
  await f.child.stop();
});

const exits = [
  [0, "zero"],
  [1, "nonzero"],
  [255, "nonzero"],
  [null, "none"],
  [-1, "unknown"],
  [256, "unknown"],
  [1.5, "unknown"],
  [undefined, "unknown"],
  ["exit-canary", "unknown"],
] as const;
const signals = [
  [null, "none"],
  ["SIGINT", "sigint"],
  ["SIGTERM", "sigterm"],
  ["SIGKILL", "sigkill"],
  ["signal-canary", "other"],
  [undefined, "unknown"],
  [42, "unknown"],
] as const;
it.each(
  exits.flatMap(([exit, expectedExit]) =>
    signals.map(([signal, expectedSignal]) => ({
      exit,
      signal,
      expectedExit,
      expectedSignal,
    })),
  ),
)(
  "projects exit $exit and signal $signal to fixed enums",
  async ({ exit, signal, expectedExit, expectedSignal }) => {
    const f = await fixture(),
      request = f.child.request("fixture", {});
    f.process.emit("exit", exit, signal);
    expect(f.events).toEqual([
      {
        event: ["transport_lost", "process_exit"],
        fields: { exit: expectedExit, signal: expectedSignal },
        stopping: false,
      },
    ]);
    expect(await request).toEqual({ _tag: "err", error: "process_failed" });
    expect(JSON.stringify(f.events)).not.toContain("canary");
    await f.child.stop();
  },
);
