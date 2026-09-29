import type { ChildProcess, SpawnOptions } from "node:child_process";
import * as v from "valibot";

import { err, ok, type Result } from "../../domain/result";

const REQUEST_TIMEOUT_MS = 30_000;
/** `agent_end` echoes the whole prompt (up to 6 MiB for an Analysis) plus tool results in one record; anything longer is a broken stream. */
const MAX_RECORD_BYTES = 32 * 1024 * 1024;

/** Extension dialogs block the run until answered; the fire-and-forget methods expect no reply. */
const EXTENSION_DIALOG_METHODS = new Set([
  "select",
  "confirm",
  "input",
  "editor",
]);

/** Spawns one child process; tests replace it with a fake `pi`. */
export type PiProcessFactory = (
  file: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

/**
 * One stdout record of `pi --mode rpc`: a command response, a session event,
 * or an extension UI request. Fields each consumer needs are parsed where it
 * reads them, so one malformed field never drops the whole record.
 */
const piRpcRecordSchema = v.looseObject({
  type: v.string(),
  id: v.optional(v.string()),
  command: v.optional(v.string()),
  success: v.optional(v.boolean()),
  data: v.optional(v.unknown()),
  error: v.optional(v.string()),
  method: v.optional(v.string()),
});
export type PiRpcRecord = v.InferOutput<typeof piRpcRecordSchema>;

/** Why one RPC command got no successful response. */
export type PiRpcRequestFailure =
  | { readonly _tag: "cancelled" }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "process_exited" }
  | { readonly _tag: "command_failed"; readonly message: string };

type PendingRequest = {
  readonly resolve: (result: Result<PiRpcRecord, PiRpcRequestFailure>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** Owns one `pi --mode rpc` child: LF-only JSONL framing, command correlation, and extension dialogs. */
export class PiRpcChannel {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(record: PiRpcRecord) => void>();
  private readonly exitListeners = new Set<() => void>();
  private buffer = "";
  private nextId = 0;
  private exited = false;

  private constructor(private readonly child: ChildProcess) {}

  /** Spawns the child and wires its streams; a spawn that throws or has no pipes is a missing runtime. */
  static open(
    processFactory: PiProcessFactory,
    executablePath: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions,
  ): Result<PiRpcChannel, "spawn_failed"> {
    let child: ChildProcess;
    try {
      child = processFactory(executablePath, args, options);
    } catch {
      return err("spawn_failed");
    }
    if (
      child.stdin === null ||
      child.stdout === null ||
      child.stderr === null
    ) {
      child.kill();
      return err("spawn_failed");
    }
    const channel = new PiRpcChannel(child);
    child.stdout.on("data", (chunk: Buffer | string) => channel.read(chunk));
    // pi writes diagnostics to stderr; it must be drained or a full pipe stalls the child.
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => channel.markExited());
    child.once("error", () => channel.markExited());
    child.once("exit", () => channel.markExited());
    return ok(channel);
  }

  /** Sends one command and resolves with its correlated response record. */
  async request(
    command: { readonly type: string } & Readonly<Record<string, string>>,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Result<PiRpcRecord, PiRpcRequestFailure>> {
    if (this.exited) return err({ _tag: "process_exited" });
    if (signal?.aborted) return err({ _tag: "cancelled" });
    const id = `patchdesk-${++this.nextId}`;
    return await new Promise((resolve) => {
      const onAbort = (): void => settle(err({ _tag: "cancelled" }));
      const settle = (
        result: Result<PiRpcRecord, PiRpcRequestFailure>,
      ): void => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const timer = setTimeout(
        () => settle(err({ _tag: "timeout" })),
        Math.max(1, Math.min(REQUEST_TIMEOUT_MS, timeoutMs)),
      );
      this.pending.set(id, { resolve: settle, timer });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.send({ ...command, id });
    });
  }

  /** Writes one record without waiting for a response, such as `abort`. */
  send(record: Readonly<Record<string, string | boolean>>): void {
    if (this.exited || this.child.stdin === null) return;
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  /** Observes every session event; returns the unsubscribe function. */
  onEvent(listener: (record: PiRpcRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Observes the child exiting or its pipes failing; returns the unsubscribe function. */
  onExit(listener: () => void): () => void {
    if (this.exited) listener();
    else this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Closes stdin, which asks pi to shut down, then kills the child. */
  stop(): void {
    this.markExited();
    this.child.stdin?.end();
    this.child.kill();
  }

  private read(chunk: Buffer | string): void {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    // Split on LF only: U+2028 and U+2029 are valid inside a JSON string.
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RECORD_BYTES) {
      this.stop();
      return;
    }
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = v.safeParse(piRpcRecordSchema, value);
      if (parsed.success) this.route(parsed.output);
    }
  }

  private route(record: PiRpcRecord): void {
    if (record.type === "response") {
      if (record.id === undefined) return;
      const pending = this.pending.get(record.id);
      if (pending === undefined) return;
      pending.resolve(
        record.success === true
          ? ok(record)
          : err({ _tag: "command_failed", message: record.error ?? "" }),
      );
      return;
    }
    if (record.type === "extension_ui_request") {
      // No person watches a run, so every dialog is cancelled at once rather than left to block it.
      if (
        record.id !== undefined &&
        record.method !== undefined &&
        EXTENSION_DIALOG_METHODS.has(record.method)
      )
        this.send({
          type: "extension_ui_response",
          id: record.id,
          cancelled: true,
        });
      return;
    }
    for (const listener of this.listeners) listener(record);
  }

  private markExited(): void {
    if (this.exited) return;
    this.exited = true;
    for (const pending of [...this.pending.values()])
      pending.resolve(err({ _tag: "process_exited" }));
    for (const listener of this.exitListeners) listener();
    this.exitListeners.clear();
  }
}
