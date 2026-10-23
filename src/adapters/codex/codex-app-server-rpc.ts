import type { ChildProcess, SpawnOptions } from "node:child_process";
import * as v from "valibot";
import { err, ok, type Result } from "#src/domain/result";
import { stopInsightProcess } from "#src/adapters/process/insight-process-cleanup";
import { isNotFound } from "#src/adapters/storage/json-file";
import { allowlistedCodexEnvironment } from "./codex-insight-policy";
import type { CodexAppServerFailure } from "./codex-app-server-client";
import type { CodexActivityEmitter } from "./codex-activity";
const CLIENT_NAME = "patchdesk";
const CLIENT_VERSION = "0.1.0";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
const FILE_APPROVAL_METHOD = "item/fileChange/requestApproval";
const PERMISSIONS_APPROVAL_METHOD = "item/permissions/requestApproval";

type PendingRequest = {
  readonly resolve: (value: JsonObject) => void;
  readonly reject: (cause: RpcFailure) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export type RpcFailure =
  | "cancelled"
  | "timeout"
  | "process_unavailable"
  | "process_failed"
  | "stopped"
  | "invalid_rpc_result"
  | {
      readonly _tag: "rpc_error";
      readonly code?: string | number | undefined;
      readonly message?: string | undefined;
    };

export type CodexProcessFactory = (
  file: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

/**
 * One line of the Codex app-server's stdio protocol, either direction: a response, a
 * server-to-client request, or a notification. `params`/`result`/`error` are left as `unknown`
 * here and parsed into their method-specific shape at the point each is consumed, so one
 * malformed field never invalidates the whole envelope.
 */
export const codexRpcMessageSchema = v.looseObject({
  id: v.optional(v.union([v.string(), v.number()])),
  method: v.optional(v.string()),
  params: v.optional(v.unknown()),
  result: v.optional(v.unknown()),
  error: v.optional(v.unknown()),
});
export type CodexRpcMessage = v.InferOutput<typeof codexRpcMessageSchema>;

/** The `id`+`method`+`params` and `id`+`result`/`error` shapes this client writes to the child. */
export type OutgoingRpcMessage =
  | { readonly method: string; readonly params: unknown }
  | { readonly id: string; readonly method: string; readonly params: unknown }
  | { readonly id: string | number; readonly result: unknown }
  | {
      readonly id: string | number;
      readonly error: { readonly code: number; readonly message: string };
    };

const rpcErrorSchema = v.looseObject({
  code: v.optional(v.union([v.string(), v.number()])),
  message: v.optional(v.string()),
});

/** Bare "is a plain object" gate for a field the wire protocol leaves as `unknown`. */

/**
 * A generic JSON value. Every RPC response's `result` is one of these before it is parsed into
 * its own method-specific shape (thread/start, turn/start, model/list, ...); each caller runs
 * its own schema over it rather than reading it as `unknown`.
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };
const jsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null_(),
    v.array(jsonValueSchema),
    v.record(v.string(), jsonValueSchema),
  ]),
);
/** An RPC response's `result`, confirmed to be a plain object. */
const jsonObjectSchema = v.record(v.string(), jsonValueSchema);
export type JsonObject = v.InferOutput<typeof jsonObjectSchema>;

export class RpcChild {
  nativeVersion: string | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(message: CodexRpcMessage) => void>();
  private child: ChildProcess | undefined;
  private buffer = Buffer.alloc(0);
  onServerRequest:
    | ((message: CodexRpcMessage, bytes: number) => void)
    | undefined;
  onFailure: (() => void) | undefined;
  private nextId = 0;
  private stopped = false;
  private broken = false;
  private stopPromise: Promise<void> | undefined;
  private ownsProcessGroup = false;
  private turnId: string | undefined;
  private threadId: string | undefined;
  activity: CodexActivityEmitter | undefined;

  constructor(private readonly processFactory: CodexProcessFactory) {}

  /** Synchronous admission evidence for a bound interrupt write, not an acknowledgment or cessation proof. */
  get canRequest(): boolean {
    return (
      this.child?.stdin !== null &&
      this.child?.stdin !== undefined &&
      !this.stopped &&
      !this.broken
    );
  }

  async start(
    executablePath: string,
    cwd: string | undefined,
    signal?: AbortSignal,
    isolationArgs: ReadonlyArray<string> = [],
    home?: string,
  ): Promise<Result<void, CodexAppServerFailure>> {
    if (signal?.aborted)
      return err({ reason: "cancelled", phase: "initialize" });
    try {
      this.ownsProcessGroup = isolationArgs.length !== 0;
      const spawnOptions: SpawnOptions = {
        detached: this.ownsProcessGroup,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env:
          home === undefined
            ? allowlistedCodexEnvironment()
            : { ...allowlistedCodexEnvironment(), CODEX_HOME: home },
      };
      this.child = this.processFactory(
        executablePath,
        [
          ...isolationArgs,
          ...(home === undefined
            ? []
            : ["-c", 'cli_auth_credentials_store="ephemeral"']),
          "app-server",
        ],
        cwd === undefined ? spawnOptions : { ...spawnOptions, cwd },
      );
      if (
        this.child.stdin === null ||
        this.child.stdout === null ||
        this.child.stderr === null
      ) {
        await this.stop();
        return err({ reason: "runtime_unavailable", phase: "initialize" });
      }
      this.child.stdout.on("data", (chunk: Buffer | string) =>
        this.read(chunk),
      );
      this.child.stderr.on("data", () => undefined);
      this.child.stdin.on("error", () => this.failPending());
      this.child.once("error", () => this.failPending());
      this.child.once("exit", () => this.failPending());
      const clientInfo = {
        name: CLIENT_NAME,
        title: "Patchdesk",
        version: CLIENT_VERSION,
      };
      const params =
        isolationArgs.length === 0
          ? { clientInfo }
          : { clientInfo, capabilities: { experimentalApi: true } };
      const initialized = await this.request("initialize", params, signal);
      if (initialized._tag === "err") {
        await this.stop();
        return err({
          reason: classifyRpcFailure(initialized.error),
          phase: "initialize",
        });
      }
      const userAgent = v.safeParse(v.string(), initialized.value.userAgent);
      this.nativeVersion = userAgent.success
        ? new RegExp(
            `^${CLIENT_NAME}/([0-9]+\\.[0-9]+\\.[0-9]+)(?:\\s|$)`,
          ).exec(userAgent.output)?.[1]
        : undefined;
      this.send({ method: "initialized", params: {} });
      return ok(undefined);
    } catch (cause: unknown) {
      await this.stop();
      return err({ reason: classifyThrownFailure(cause), phase: "initialize" });
    }
  }

  async request<P>(
    method: string,
    params: P,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Result<JsonObject, RpcFailure>> {
    if (
      this.child?.stdin === null ||
      this.child?.stdin === undefined ||
      this.stopped ||
      this.broken
    )
      return err("process_unavailable");
    if (signal?.aborted) return err("cancelled");
    const id = String(++this.nextId);
    return new Promise((resolveResult) => {
      const timer = setTimeout(
        () => {
          const pending = this.pending.get(id);
          if (pending === undefined) return;
          this.pending.delete(id);
          pending.reject("timeout");
        },
        Math.min(REQUEST_TIMEOUT_MS, Math.max(1, timeoutMs)),
      );
      const resolve = (value: JsonObject): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolveResult(ok(value));
      };
      const reject = (cause: RpcFailure): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolveResult(err(cause));
      };
      this.pending.set(id, { resolve, reject, timer });
      const onAbort = (): void => {
        signal?.removeEventListener("abort", onAbort);
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          resolveResult(err("cancelled"));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.send({ id, method, params });
    });
  }

  bindTurn(threadId: string, turnId?: string): void {
    this.threadId = threadId;
    this.turnId = turnId;
  }

  cancel(): void {
    if (this.threadId !== undefined && this.turnId !== undefined)
      this.send({
        method: "turn/interrupt",
        params: { threadId: this.threadId, turnId: this.turnId },
      });
  }

  stop(): Promise<void> {
    // Repeated shutdown must preserve failed cessation so the private home remains guarded.
    this.stopPromise ??= (async () => {
      this.cancel();
      this.stopped = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject("stopped");
      }
      this.pending.clear();
      this.listeners.clear();
      if (this.child !== undefined)
        await stopInsightProcess(this.child, this.ownsProcessGroup);
      this.child = undefined;
    })();
    return this.stopPromise;
  }

  listenersAdd(listener: (message: CodexRpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: OutgoingRpcMessage): void {
    if (
      this.child?.stdin === null ||
      this.child?.stdin === undefined ||
      this.stopped ||
      this.broken
    )
      return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      const part = bytes.subarray(offset, end < 0 ? bytes.length : end);
      if (this.buffer.length + part.length > MAX_STREAM_BYTES) {
        this.failPending();
        return;
      }
      this.buffer = Buffer.concat([this.buffer, part]);
      if (end < 0) return;
      const line = this.buffer;
      this.buffer = Buffer.alloc(0);
      offset = end + 1;
      if (line.length === 0) continue;
      if (
        this.onServerRequest !== undefined &&
        line.length + 1 > 32768 &&
        dynamicToolLine(line)
      ) {
        this.failPending();
        return;
      }
      try {
        const parsed = v.safeParse(
          codexRpcMessageSchema,
          JSON.parse(line.toString("utf8")),
        );
        if (parsed.success) this.route(parsed.output, line.length + 1);
        else this.failPending();
      } catch {
        this.failPending();
      }
    }
  }

  private route(message: CodexRpcMessage, bytes: number): void {
    const { id, method } = message;
    if (id !== undefined && method === undefined) {
      const pending = this.pending.get(String(id));
      if (pending === undefined) return;
      this.pending.delete(String(id));
      const errorParsed = v.safeParse(rpcErrorSchema, message.error);
      if (errorParsed.success) {
        const { code, message: errorMessage } = errorParsed.output;
        const base = { _tag: "rpc_error" as const };
        const withCode = code === undefined ? base : { ...base, code };
        const rpcError =
          errorMessage === undefined
            ? withCode
            : { ...withCode, message: errorMessage };
        pending.reject(rpcError);
      } else {
        const result = message.result;
        if (result === undefined || !v.is(jsonObjectSchema, result))
          pending.reject("invalid_rpc_result");
        else pending.resolve(result);
      }
      return;
    }
    if (method === "item/tool/call" && this.onServerRequest !== undefined) {
      this.onServerRequest(message, bytes);
      return;
    }
    if (id !== undefined && method !== undefined) {
      if (this.onServerRequest !== undefined)
        this.onServerRequest(message, bytes);
      else this.send(this.serverReply(id, method));
      return;
    }
    if (method !== undefined)
      for (const listener of this.listeners) listener(message);
  }

  serverReply(id: string | number, method: string): OutgoingRpcMessage {
    if (method === PERMISSIONS_APPROVAL_METHOD)
      return { id, result: { permissions: {}, scope: "turn" } };
    if (method === FILE_APPROVAL_METHOD || method === COMMAND_APPROVAL_METHOD) {
      if (method === COMMAND_APPROVAL_METHOD)
        this.activity?.approvalAnswered("declined");
      return { id, result: { decision: "decline" } };
    }
    return { id, error: { code: -32601, message: "unsupported_request" } };
  }

  private failPending(): void {
    this.broken = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject("process_failed");
    }
    this.pending.clear();
    this.onFailure?.();
  }
}

function classifyThrownFailure(
  cause: unknown,
): CodexAppServerFailure["reason"] {
  if (isNotFound(cause)) return "runtime_unavailable";
  return "execution_failed";
}
export function classifyRpcFailure(
  cause: RpcFailure,
): CodexAppServerFailure["reason"] {
  if (cause === "cancelled") return "cancelled";
  if (cause === "timeout") return "timed_out";
  if (
    cause !== "process_unavailable" &&
    cause !== "process_failed" &&
    cause !== "stopped" &&
    cause !== "invalid_rpc_result"
  ) {
    const detail = `${cause.code ?? ""} ${cause.message ?? ""}`.toLowerCase();
    if (detail.includes("login") || detail.includes("auth"))
      return "authentication_required";
    if (detail.includes("rate") || detail.includes("concurren"))
      return "rate_limited";
    if (detail.includes("timeout")) return "timed_out";
    if (detail.includes("cancel")) return "cancelled";
    if (detail.includes("invalid")) return "invalid_result";
  }
  return "execution_failed";
}

/** Scan top-level method strings without parsing or copying oversized argument bodies. */
function dynamicToolLine(bytes: Buffer): boolean {
  let depth = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 123 || byte === 91) depth++;
    else if (byte === 125 || byte === 93) depth--;
    else if (byte === 34) {
      const start = i++;
      while (i < bytes.length && bytes[i] !== 34) {
        if (bytes[i] === 92) i++;
        i++;
      }
      if (depth !== 1 || i - start > 128) continue;
      let token: unknown;
      try {
        token = JSON.parse(bytes.subarray(start, i + 1).toString("utf8"));
      } catch {
        return false;
      }
      if (token !== "method") continue;
      let cursor = i + 1;
      while (
        bytes[cursor] === 32 ||
        bytes[cursor] === 9 ||
        bytes[cursor] === 13
      )
        cursor++;
      if (bytes[cursor++] !== 58) continue;
      while (
        bytes[cursor] === 32 ||
        bytes[cursor] === 9 ||
        bytes[cursor] === 13
      )
        cursor++;
      if (bytes[cursor] !== 34) continue;
      const valueStart = cursor++;
      while (
        cursor < bytes.length &&
        bytes[cursor] !== 34 &&
        cursor - valueStart <= 128
      ) {
        if (bytes[cursor] === 92) cursor++;
        cursor++;
      }
      if (cursor - valueStart > 128) continue;
      try {
        if (
          JSON.parse(
            bytes.subarray(valueStart, cursor + 1).toString("utf8"),
          ) === "item/tool/call"
        )
          return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}
