import { homedir } from "node:os";

import * as v from "valibot";

import type { CodexRpcMessage } from "./codex-app-server-client";

/** Command strings are cut here as they are parsed; the 2026-09-17 spike saw one 94-character command on an Analysis run. */
const MAX_ACTIVITY_COMMAND_CHARS = 200;
/** Longer item ids are dropped so a snapshot stays bounded. */
const MAX_ACTIVITY_ITEM_ID_CHARS = 256;
/** Reasoning tail cap in UTF-16 code units; the 2026-09-17 spike saw 0 summary deltas on gpt-5.6-luna at high effort, so the 4 KB default stands. */
export const MAX_REASONING_TAIL_CHARS = 4096;

/** One command row's lifecycle, mirroring Codex's `CommandExecutionStatus`. */
export type InsightCommandStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "declined";

/**
 * One provider-neutral observation of a running Insight turn. Commands carry no
 * output, and `command` is already bounded and stripped of worktree and home
 * prefixes.
 */
export type InsightActivityEvent =
  | { readonly _tag: "turn_started" }
  | {
      readonly _tag: "command_started";
      readonly id: string;
      readonly command: string;
    }
  | {
      readonly _tag: "command_completed";
      readonly id: string;
      readonly command: string;
      readonly status: Exclude<InsightCommandStatus, "in_progress">;
      readonly exitCode?: number | undefined;
      readonly durationMs?: number | undefined;
    }
  | {
      readonly _tag: "reasoning_delta";
      readonly itemId: string;
      readonly delta: string;
    };

/**
 * Receives activity from the adapter's RPC listener. It is called synchronously,
 * never awaited, and a throw is swallowed so it cannot fail the turn.
 */
export type InsightActivitySink = (event: InsightActivityEvent) => void;

const itemIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_ACTIVITY_ITEM_ID_CHARS),
);

// Only the fields the trace projects are read; `aggregatedOutput` is never.
const commandItemNotificationSchema = v.looseObject({
  item: v.looseObject({
    type: v.literal("commandExecution"),
    id: itemIdSchema,
    command: v.string(),
    status: v.string(),
    exitCode: v.optional(v.nullable(v.pipe(v.number(), v.integer()))),
    durationMs: v.optional(
      v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
    ),
  }),
});

const reasoningDeltaSchema = v.looseObject({
  itemId: itemIdSchema,
  delta: v.string(),
});

/** Parses the activity notifications and forwards them to one run's sink. */
export type CodexActivityEmitter = {
  readonly notification: (message: CodexRpcMessage) => void;
  readonly turnStarted: () => void;
};

/**
 * Creates the emitter one Codex turn uses. Paths under `worktreePath` become
 * relative and paths under `homePath` start with `~`, so neither absolute path
 * reaches the renderer.
 */
export function createCodexActivityEmitter(
  onActivity: InsightActivitySink | undefined,
  worktreePath: string,
  homePath: string = homedir(),
): CodexActivityEmitter {
  const emit = (event: InsightActivityEvent | undefined): void => {
    if (onActivity === undefined || event === undefined) return;
    try {
      onActivity(event);
    } catch {
      // A failing sink loses its trace, never the run.
    }
  };
  return {
    notification: (message) =>
      emit(parseCodexActivity(message, worktreePath, homePath)),
    turnStarted: () => emit({ _tag: "turn_started" }),
  };
}

function parseCodexActivity(
  { method, params }: CodexRpcMessage,
  worktreePath: string,
  homePath: string,
): InsightActivityEvent | undefined {
  if (
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/textDelta"
  ) {
    const parsed = v.safeParse(reasoningDeltaSchema, params);
    if (!parsed.success) return undefined;
    return {
      _tag: "reasoning_delta",
      itemId: parsed.output.itemId,
      delta: parsed.output.delta.slice(-MAX_REASONING_TAIL_CHARS),
    };
  }
  if (method !== "item/started" && method !== "item/completed")
    return undefined;
  const parsed = v.safeParse(commandItemNotificationSchema, params);
  if (!parsed.success) return undefined;
  const { id, status, exitCode, durationMs } = parsed.output.item;
  const command = displayCommand(
    parsed.output.item.command,
    worktreePath,
    homePath,
  );
  if (method === "item/started")
    return { _tag: "command_started", id, command };
  const completed = completedCommandStatus(status);
  if (completed === undefined) return undefined;
  return {
    _tag: "command_completed",
    id,
    command,
    status: completed,
    exitCode: exitCode ?? undefined,
    durationMs: durationMs ?? undefined,
  };
}

// An `item/completed` still reporting `inProgress`, or a status Codex adds later, leaves the row as it was.
function completedCommandStatus(
  status: string,
): Exclude<InsightCommandStatus, "in_progress"> | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      return undefined;
  }
}

function displayCommand(
  command: string,
  worktreePath: string,
  homePath: string,
): string {
  let display = command.replaceAll(`${worktreePath}/`, "");
  display = display.replaceAll(worktreePath, ".");
  if (homePath.length > 1) display = display.replaceAll(homePath, "~");
  return display.slice(0, MAX_ACTIVITY_COMMAND_CHARS);
}
