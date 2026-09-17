import { describe, expect, it } from "vitest";

import type { InsightActivityEvent } from "../../src/adapters/codex/codex-activity";
import {
  InsightActivityBuffer,
  type InsightActivitySnapshot,
} from "../../src/services/insight-activity-buffer";

function bufferWith(
  events: ReadonlyArray<InsightActivityEvent>,
): InsightActivityBuffer {
  const buffer = new InsightActivityBuffer();
  for (const event of events) buffer.append(event);
  return buffer;
}

describe("InsightActivityBuffer", () => {
  it.each<{
    readonly name: string;
    readonly events: ReadonlyArray<InsightActivityEvent>;
    readonly snapshot: Partial<InsightActivitySnapshot>;
  }>([
    {
      name: "reports preparing before the turn starts",
      events: [],
      snapshot: { phase: "preparing", commands: [] },
    },
    {
      name: "tolerates a turn with no reasoning",
      events: [{ _tag: "turn_started" }],
      snapshot: { phase: "turn", reasoningLine: undefined, commands: [] },
    },
    {
      name: "updates a completed command in place",
      events: [
        { _tag: "turn_started" },
        { _tag: "command_started", id: "a", command: "git diff" },
        { _tag: "command_started", id: "b", command: "rg guard" },
        {
          _tag: "command_completed",
          id: "a",
          command: "git diff",
          status: "completed",
          exitCode: 0,
          durationMs: 400,
        },
      ],
      snapshot: {
        phase: "turn",
        commands: [
          {
            id: "a",
            command: "git diff",
            status: "completed",
            exitCode: 0,
            durationMs: 400,
          },
          { id: "b", command: "rg guard", status: "in_progress" },
        ],
      },
    },
    {
      name: "keeps a declined command without exit code or duration",
      events: [
        {
          _tag: "command_completed",
          id: "a",
          command: "rm -rf src",
          status: "declined",
        },
      ],
      snapshot: {
        phase: "turn",
        commands: [{ id: "a", command: "rm -rf src", status: "declined" }],
      },
    },
    {
      name: "does not reopen a finished command on a late start",
      events: [
        {
          _tag: "command_completed",
          id: "a",
          command: "pwd",
          status: "failed",
          exitCode: 1,
        },
        { _tag: "command_started", id: "a", command: "pwd" },
      ],
      snapshot: {
        phase: "turn",
        commands: [{ id: "a", command: "pwd", status: "failed", exitCode: 1 }],
      },
    },
    {
      name: "shows the last summary line with markdown markers stripped",
      events: [
        { _tag: "reasoning_delta", itemId: "r1", delta: "**Reading the" },
        { _tag: "reasoning_delta", itemId: "r1", delta: " diff**\n\nSome" },
        {
          _tag: "reasoning_delta",
          itemId: "r1",
          delta: " detail\n## Checking citations\n<!-- hidden -->\n\n",
        },
      ],
      snapshot: { phase: "turn", reasoningLine: "Checking citations" },
    },
    {
      name: "resets the reasoning line when a new reasoning item starts",
      events: [
        { _tag: "reasoning_delta", itemId: "r1", delta: "**Old thought**" },
        { _tag: "reasoning_delta", itemId: "r2", delta: "**New" },
      ],
      snapshot: { phase: "turn", reasoningLine: undefined },
    },
  ])("$name", ({ events, snapshot }) => {
    expect(bufferWith(events).snapshot()).toMatchObject(snapshot);
  });

  it("caps the command rows and drops the oldest", () => {
    const events: Array<InsightActivityEvent> = [];
    for (let index = 0; index < 205; index += 1)
      events.push({
        _tag: "command_started",
        id: `cmd-${String(index)}`,
        command: "pwd",
      });
    const { commands } = bufferWith(events).snapshot();
    expect(commands).toHaveLength(200);
    expect(commands[0]?.id).toBe("cmd-5");
    expect(commands.at(-1)?.id).toBe("cmd-204");
  });

  it("keeps only the reasoning tail", () => {
    const buffer = bufferWith([
      { _tag: "reasoning_delta", itemId: "r1", delta: "old line\n" },
      { _tag: "reasoning_delta", itemId: "r1", delta: "x".repeat(10_000) },
    ]);
    expect(buffer.snapshot().reasoningLine).toBe("x".repeat(4096));
  });
});
