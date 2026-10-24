import { expect, it } from "vitest";
import * as v from "valibot";
import type { LogEntryInput } from "#src/domain/log-entry";
import { guideGroupIdSchema } from "#src/domain/guide";
import type { GuideAppOutcome } from "#src/domain/guide-protocol";
import { CodexExplanationTools } from "#src/adapters/codex/codex-explanation-tools";
import { CodexExplanationDiagnostics } from "#src/adapters/codex/codex-explanation-diagnostics";
import {
  explanationFixture,
  hostIdentity,
  toolMessage,
} from "./codex-explanation-fixture";

it("retains unknown cessation when the owned stop throws and never cleans the home", async () => {
  const entries: LogEntryInput[] = [],
    f = explanationFixture((entry) => entries.push(entry));
  let homeCleanups = 0,
    stops = 0;
  f.controls.cleanup = async () => {
    homeCleanups++;
  };
  const run = f.client.runExplanation(f.input);
  await f.bound.promise;
  const child = f.children.at(-1);
  if (child === undefined) throw new Error("missing generating child");
  child.onStop = () => {
    stops++;
    throw new Error("stop-canary");
  };
  child.write(toolMessage(7, { tool: "unknown-tool" }));
  expect(await run).toMatchObject({
    _tag: "failed",
    effectKnown: false,
    detail: "native_cleanup_unknown",
  });
  expect(stops).toBe(1);
  expect(homeCleanups).toBe(0);
  expect(f.receipts).toEqual([]);
  expect(f.finish.signal.aborted).toBe(false);
  expect(f.observations).toContainEqual({ kind: "cessation_unknown" });
  expect(
    f.observations.some((event) => event.kind === "cessation_confirmed"),
  ).toBe(false);
  expect(
    entries.find((entry) => entry.meta?.event === "trigger")?.meta,
  ).toMatchObject({ category: "host_refusal", code: "tool_not_allowed" });
  expect(entries.at(-1)?.meta).toMatchObject({
    event: "final",
    category: "host_refusal",
    result: "failed",
    effect: "unknown",
    cessation: "unknown",
    homeCleanup: "not_attempted",
  });
  expect(entries).toHaveLength(4);
});

it("preserves real tool refusal and interrupt behavior when the injected sink throws", async () => {
  const results = [];
  for (const enabled of [false, true]) {
    const entries: LogEntryInput[] = [];
    const f = explanationFixture(
      enabled
        ? (entry) => {
            entries.push(entry);
            throw new Error("sink-canary");
          }
        : undefined,
    );
    let calls = 0;
    const run = f.client.runExplanation({
      ...f.input,
      binding: {
        kind: "guide",
        tool: async () => {
          calls++;
          return { status: "not_found" };
        },
      },
    });
    await f.bound.promise;
    f.children.at(-1)?.write(toolMessage(9, { tool: "unknown-tool" }));
    results.push({
      result: await run,
      calls,
      observations: f.observations,
      receipts: f.receipts,
      wire: f.children.at(-1)?.received,
    });
    if (enabled)
      expect(
        entries.find((entry) => entry.meta?.event === "trigger")?.meta,
      ).toMatchObject({ category: "host_refusal", code: "tool_not_allowed" });
  }
  expect(results[1]).toEqual(results[0]);
  expect(results[0]).toMatchObject({
    result: { _tag: "failed", effectKnown: true },
    calls: 0,
    receipts: [],
  });
  expect(
    results[0]?.wire?.filter((message) => message.method === "turn/interrupt"),
  ).toHaveLength(1);
});

it("keeps an accepted session finish and receipt when its reply is oversized", async () => {
  const entries: LogEntryInput[] = [],
    f = explanationFixture((entry) => entries.push(entry)),
    receipts: string[] = [];
  const groupId = v.parse(guideGroupIdSchema, "g" + "1".repeat(32768));
  // The callback deliberately returns the wrong receipt variant after acceptance to exercise the defensive reply bound.
  const run = f.client.runExplanation({
    ...f.input,
    binding: {
      kind: "guide",
      tool: async (call): Promise<GuideAppOutcome> => {
        receipts.push(call.input.opId);
        f.finish.abort();
        return { status: "receipt", sequence: 1, result: { groupId } };
      },
    },
  });
  await f.bound.promise;
  f.children.at(-1)?.write(toolMessage(7, { tool: "finish" }));
  expect(await run).toEqual({ _tag: "finished" });
  expect(receipts).toEqual(["operation-canary"]);
  expect(
    f.children.at(-1)?.received.filter((message) => message.id === 7),
  ).toEqual([]);
  expect(
    entries.find((entry) => entry.meta?.event === "trigger")?.meta,
  ).toMatchObject({ category: "finish_accepted", code: "finish_signal" });
  expect(entries.at(-1)?.meta).toMatchObject({
    category: "finish_accepted",
    result: "finished",
    effect: "known",
    cessation: "confirmed",
    homeCleanup: "succeeded",
  });
});

it("records reply refusal as secondary after the tool accepted finish", async () => {
  const entries: LogEntryInput[] = [],
    accepted: string[] = [],
    order: string[] = [],
    stops: boolean[] = [];
  const d = new CodexExplanationDiagnostics(
    "guide",
    hostIdentity.connection,
    (entry) => entries.push(entry),
  );
  d.phase = "running";
  const groupId = v.parse(guideGroupIdSchema, "g" + "1".repeat(32768));
  const tools = new CodexExplanationTools(
    {
      kind: "guide",
      tool: async (call) => {
        accepted.push(call.input.opId);
        order.push("receipt");
        return { status: "receipt", sequence: 1, result: { groupId } };
      },
    },
    hostIdentity,
    () => order.push("reply"),
    (id) => ({ id, result: {} }),
    (known) => stops.push(known),
    async () => {
      order.push("finish");
    },
    (event, fields) => d.observe(event, fields),
  );
  tools.bindThread("thread-canary");
  tools.bindTurn("turn-canary");
  tools.receive(toolMessage(7, { tool: "finish" }), 256);
  await tools.join();
  expect(accepted).toEqual(["operation-canary"]);
  expect(order).toEqual(["receipt", "finish"]);
  expect(stops).toEqual([true]);
  expect(entries.map((entry) => entry.meta)).toMatchObject([
    {
      event: "trigger",
      category: "finish_accepted",
      code: "finish_signal",
      order: 1,
    },
    {
      event: "secondary",
      category: "host_refusal",
      code: "reply_limit",
      order: 2,
    },
  ]);
});
