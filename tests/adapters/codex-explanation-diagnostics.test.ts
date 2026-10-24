import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEntryInput } from "#src/domain/log-entry";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { AppLogService } from "#src/services/app-log-service";
import { CodexExplanationDiagnostics } from "#src/adapters/codex/codex-explanation-diagnostics";
import { err, ok } from "#src/domain/result";
import {
  completion,
  deferred,
  explanationFixture,
  toolMessage,
} from "./codex-explanation-fixture";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const trigger = (entries: LogEntryInput[]) =>
  entries.find((entry) => entry.meta?.event === "trigger")?.meta;

it.each([
  ["completion", "abort", "provider_completed_without_finish"],
  ["abort", "completion", "abort_observed"],
  ["transport", "finish", "transport_lost"],
  ["finish", "transport", "finish_accepted"],
  ["completion", "transport", "provider_completed_without_finish"],
  ["transport", "completion", "transport_lost"],
  ["finish", "completion", "finish_accepted"],
  ["completion", "finish", "provider_completed_without_finish"],
  ["abort", "finish", "abort_observed"],
  ["finish", "abort", "finish_accepted"],
  ["abort", "transport", "abort_observed"],
  ["transport", "abort", "transport_lost"],
] as const)(
  "keeps %s before %s with sink parity",
  async (first, second, category) => {
    const results = [];
    for (const enabled of [false, true, "throw"]) {
      const entries: LogEntryInput[] = [];
      const f = explanationFixture(
        enabled
          ? (entry) => {
              entries.push(entry);
              if (enabled === "throw") throw new Error("sink-canary");
            }
          : undefined,
      );
      const run = f.client.runExplanation(f.input);
      await f.bound.promise;
      const child = f.children.at(-1);
      expect(child).toBeDefined();
      const act = (action: string) => {
        if (action === "completion") child?.write(completion);
        else if (action === "abort") f.abort.abort("abort-reason-canary");
        else if (action === "finish") f.finish.abort();
        else child?.stdin.emit("error", new Error("transport-canary"));
      };
      act(first);
      act(second);
      results.push({
        result: await run,
        receipts: f.receipts,
        observations: f.observations,
      });
      if (enabled) {
        expect(trigger(entries)?.category).toBe(category);
        expect(entries).toHaveLength(4);
      }
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  },
);

it("makes early bound completion eligible before lifecycle persistence yields to abort", async () => {
  const entries: LogEntryInput[] = [],
    entered = deferred<void>(),
    release = deferred<void>();
  const f = explanationFixture((entry) => entries.push(entry));
  f.controls.onTurn = (child, message) => {
    child.write(completion);
    child.write({ id: message.id, result: { turn: { id: "turn-canary" } } });
    return true;
  };
  f.controls.observe = async (event) => {
    if (event.kind === "provider_turn") {
      entered.resolve();
      await release.promise;
    }
    return ok(undefined);
  };
  const run = f.client.runExplanation(f.input);
  await entered.promise;
  expect(trigger(entries)?.category).toBe("provider_completed_without_finish");
  f.abort.abort();
  release.resolve();
  expect(await run).toMatchObject({
    _tag: "failed",
    reason: "cancelled",
    effectKnown: true,
  });
  expect(trigger(entries)?.category).toBe("provider_completed_without_finish");
});

it("keeps an abort already observed ahead of early completion binding", async () => {
  const entries: LogEntryInput[] = [],
    f = explanationFixture((entry) => entries.push(entry));
  f.controls.onTurn = (child, message) => {
    child.write(completion);
    f.abort.abort();
    child.write({ id: message.id, result: { turn: { id: "turn-canary" } } });
    return true;
  };
  await f.client.runExplanation(f.input);
  expect(trigger(entries)?.category).toBe("abort_observed");
});

it("preserves accepted finish receipts and replies when the diagnostic sink throws", async () => {
  const results = [];
  for (const throwing of [false, true]) {
    const f = explanationFixture(
      throwing
        ? () => {
            throw new Error("sink-canary");
          }
        : undefined,
    );
    const run = f.client.runExplanation(f.input);
    await f.bound.promise;
    f.children.at(-1)?.write(toolMessage(7, { tool: "finish" }));
    results.push({
      result: await run,
      receipts: f.receipts,
      replies: f.children.at(-1)?.received.filter((m) => m.id === 7),
    });
  }
  expect(results[1]).toEqual(results[0]);
  expect(results[0]).toMatchObject({
    result: { _tag: "finished" },
    receipts: ["operation-canary"],
    replies: [{ id: 7, result: { success: true } }],
  });
});

it("keeps discovery cleanup secondary and preserves refusal through failed cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-diagnostics-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root),
    logs = new AppLogService(paths);
  const entries: LogEntryInput[] = [],
    f = explanationFixture((entry) => {
      entries.push(entry);
      logs.write(entry);
    });
  f.controls.observe = async (event) =>
    event.kind === "ended" ? err("unknown") : ok(undefined);
  f.controls.cleanup = async () => {
    throw new Error("cleanup-stack-canary", { cause: "cause-canary" });
  };
  const run = f.client.runExplanation(f.input);
  await f.bound.promise;
  expect(entries.map((e) => e.meta?.event)).toEqual(["secondary"]);
  const child = f.children.at(-1);
  if (child === undefined) throw new Error("missing generating child");
  child.onStop = () => {
    child.stdin.emit(
      "error",
      new Error("stop-canary", { cause: "error-cause-canary" }),
    );
    child.emit("exit", "exit-canary", "signal-canary");
  };
  child.onRequest = (message) => {
    if (message.method !== "turn/interrupt") return false;
    child.write({
      id: message.id,
      error: { code: "code-canary", message: "message-canary" },
    });
    return true;
  };
  f.children[0]?.stdin.emit("error", new Error("late-discovery-canary"));
  child.write(
    toolMessage(3, {
      tool: "tool-canary",
      namespace: "namespace-canary",
      arguments: { source: "source-canary" },
    }),
  );
  expect(await run).toMatchObject({ _tag: "failed", effectKnown: false });
  expect(trigger(entries)).toMatchObject({
    category: "host_refusal",
    code: "params_invalid",
  });
  expect(entries.find((e) => e.meta?.event === "cleanup")?.meta?.code).toBe(
    "interrupt_attempted",
  );
  expect(entries.at(-1)?.meta).toMatchObject({
    event: "final",
    category: "host_refusal",
    cessation: "confirmed",
    homeCleanup: "failed",
    effect: "unknown",
    overflow: true,
  });
  child.stdin.emit("error", new Error("post-final-canary"));
  expect(entries).toHaveLength(4);
  await logs.flush();
  const persisted = await readFile(paths.logFile(), "utf8");
  expect(persisted).not.toContain("canary");
  expect(
    persisted
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual(logs.tail().entries);
  expect(
    logs
      .tail()
      .entries.every((entry) => entry.correlationId === "host_connection"),
  ).toBe(true);
  expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(8192);
  for (const entry of logs.tail().entries)
    expect(Buffer.byteLength(JSON.stringify(entry)) + 1).toBeLessThanOrEqual(
      2048,
    );
});

it("bounds the maximum valid projection after normalization and persistence", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
  const root = await mkdtemp(join(tmpdir(), "codex-maximum-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root),
    logs = new AppLogService(paths),
    projected: LogEntryInput[] = [];
  const d = new CodexExplanationDiagnostics(
    "walkthrough",
    "x".repeat(64),
    (entry) => {
      projected.push(entry);
      logs.write(entry);
    },
  );
  for (let i = 0; i < 65535; i++) d.observe(["cleanup", "home_cleanup_failed"]);
  d.observe(["host_refusal", "turn_notification_overflow"]);
  d.observe(["provider_completed_without_finish", "bound_completion"], {
    rpcIdKind: "invalid_number",
    namespaceKind: "missing",
    binding: "thread_mismatch",
    bytes: 8388609,
    queued: 16,
    active: 1,
    seen: 256,
    cached: 16,
    exit: "nonzero",
    signal: "unknown",
  });
  d.phase = "cleanup";
  d.observe(["cleanup", "home_cleanup_failed"]);
  d.finish(
    { _tag: "failed", reason: "execution_failed", effectKnown: false },
    false,
    "not_attempted",
  );
  d.observe(["transport_lost", "process_exit"]);
  d.finish({ _tag: "finished" }, true, "succeeded");
  await logs.flush();
  const persisted = await readFile(paths.logFile(), "utf8"),
    entries = logs.tail().entries;
  expect(entries).toHaveLength(4);
  expect(entries[2]?.meta).toMatchObject({
    order: 65535,
    orderSaturated: true,
    overflow: true,
    bytes: 8388609,
    queued: 16,
    active: 1,
    seen: 256,
    cached: 16,
  });
  expect(entries.at(-1)?.meta).toMatchObject({
    triggerOrder: 65535,
    overflow: true,
  });
  expect(persisted).toBe(
    entries.map((entry) => JSON.stringify(entry) + "\n").join(""),
  );
  const inputMaximum = Math.max(
    ...projected.map((e) => Buffer.byteLength(JSON.stringify(e)) + 1),
  );
  const normalizedMaximum = Math.max(
    ...entries.map((e) => Buffer.byteLength(JSON.stringify(e)) + 1),
  );
  expect([
    inputMaximum,
    normalizedMaximum,
    Buffer.byteLength(persisted),
  ]).toEqual([575, 633, 2002]);
});

it("omits an invalid overlong correlation and isolates a flooded throwing sink", () => {
  const entries: LogEntryInput[] = [],
    d = new CodexExplanationDiagnostics(
      "guide",
      "correlation-canary".repeat(100),
      (entry) => {
        entries.push(entry);
        throw new Error("sink-canary");
      },
    );
  d.observe(["host_refusal", "queue_full"]);
  for (let i = 0; i < 65536; i++) {
    d.observe(["host_refusal", "queue_full"]);
    d.observe(["rpc_detail", "request_timeout"]);
    d.observe(["cleanup", "stdin_error"]);
  }
  d.finish({ _tag: "finished" }, true, "succeeded");
  expect(entries).toHaveLength(4);
  expect(entries.every((entry) => entry.correlationId === undefined)).toBe(
    true,
  );
  expect(entries.at(-1)?.meta).toMatchObject({
    overflow: true,
    orderSaturated: true,
    triggerOrder: 1,
  });
});
