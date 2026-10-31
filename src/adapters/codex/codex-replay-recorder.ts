import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { CodexProcessFactory } from "./codex-app-server-rpc";

type RecordedLine =
  | {
      readonly kind: "spawn";
      readonly args: ReadonlyArray<string>;
      readonly t: 0;
    }
  | {
      readonly dir: "c2s" | "s2c";
      readonly t: number;
      readonly message?: unknown;
      readonly raw?: string;
    };

let recordingDirectory: string | undefined;
let recordingSequence = 0;

/** Dev only: saves each spawned Codex child's JSON-RPC traffic under `directory`, one file per child. */
export function enableCodexReplayRecording(directory: string): void {
  mkdirSync(directory, { recursive: true });
  recordingDirectory = directory;
}

/** The process factory the Codex client uses unless a test supplies one; taps the child when recording is on. */
export const spawnCodexProcess: CodexProcessFactory = (file, args, options) => {
  const child = spawn(file, [...args], options);
  if (recordingDirectory !== undefined)
    tapChild(child, recordingDirectory, args);
  return child;
};

function tapChild(
  child: ChildProcess,
  directory: string,
  args: ReadonlyArray<string>,
): void {
  recordingSequence += 1;
  const path = join(
    directory,
    `${Date.now()}-${String(recordingSequence).padStart(3, "0")}.jsonl`,
  );
  const started = Date.now();
  const write = (record: RecordedLine): void => {
    try {
      appendFileSync(path, `${JSON.stringify(record)}\n`);
    } catch {
      // A recording failure must not change the run it observes.
    }
  };
  write({ kind: "spawn", args, t: 0 });
  const line = (dir: "c2s" | "s2c", text: string): void => {
    if (text.trim().length === 0) return;
    try {
      write({ dir, t: Date.now() - started, message: JSON.parse(text) });
    } catch {
      write({ dir, t: Date.now() - started, raw: text });
    }
  };
  if (child.stdin !== null) {
    const original = child.stdin.write.bind(child.stdin);
    // SAFETY: the tap only observes the chunk and forwards the original arguments unchanged.
    child.stdin.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
      for (const part of chunk.toString().split("\n")) line("c2s", part);
      return original(chunk, ...rest);
    }) as typeof child.stdin.write;
  }
  let pending = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) line("s2c", part);
  });
}
