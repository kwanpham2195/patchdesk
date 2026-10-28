import type { ChildProcess, SpawnOptions } from "node:child_process";
import * as v from "valibot";
import { codexRpcResultSchema } from "./codex-rpc-result-schema";
import { err, ok, type Result } from "#src/domain/result";
import {
  InsightProcessCleanupError,
  stopInsightProcess,
  type InsightProcessCleanupErrorCode,
} from "#src/adapters/process/insight-process-cleanup";
import { isNotFound } from "#src/adapters/storage/json-file";
import { allowlistedCodexEnvironment } from "./codex-insight-policy";
import type { CodexAppServerFailure } from "./codex-app-server-client";
import type { CodexActivityEmitter } from "./codex-activity";
import { dynamicToolLine } from "./codex-dynamic-tool-line";
import type {
  CodexDiscoveryStep,
  CodexDiagnostic,
  CodexDiagnosticFields,
  CodexStopFailureCause,
} from "./codex-explanation-diagnostics";
const CLIENT_NAME = "patchdesk";
const CLIENT_VERSION = "0.1.0";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
const FILE_APPROVAL_METHOD = "item/fileChange/requestApproval";
const PERMISSIONS_APPROVAL_METHOD = "item/permissions/requestApproval";

type PendingRequest = {
  readonly discoveryStep: CodexDiscoveryStep | undefined;
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

export type JsonObject = v.InferOutput<typeof codexRpcResultSchema>;

export class RpcChild {
  /** Reported release identity for durable evidence, never a compatibility allowlist. */
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
  private diagnosticStopping = false;
  private broken = false;
  private stopPromise: Promise<void> | undefined;
  stopFailureCause: CodexStopFailureCause | undefined;
  stopFailureErrorCode: InsightProcessCleanupErrorCode | undefined;
  private ownsProcessGroup = false;
  private turnId: string | undefined;
  private threadId: string | undefined;
  activity: CodexActivityEmitter | undefined;

  constructor(
    private readonly processFactory: CodexProcessFactory,
    private readonly diagnostic?: (
      event: CodexDiagnostic,
      fields: CodexDiagnosticFields,
      stopping: boolean,
    ) => void,
  ) {}

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
        this.detail("pipes_missing");
        await this.stop();
        return err({ reason: "runtime_unavailable", phase: "initialize" });
      }
      this.child.stdout.on("data", (chunk: Buffer | string) =>
        this.read(chunk),
      );
      this.child.stderr.on("data", () => undefined);
      this.child.stdin.on("error", () => this.failPending("stdin_error"));
      this.child.once("error", () => this.failPending("process_error"));
      this.child.once("exit", (code, signal) =>
        this.failPending("process_exit", {
          exit:
            code === null
              ? "none"
              : code === 0
                ? "zero"
                : Number.isInteger(code) && code >= 1 && code <= 255
                  ? "nonzero"
                  : "unknown",
          signal:
            signal === null
              ? "none"
              : signal === "SIGINT"
                ? "sigint"
                : signal === "SIGTERM"
                  ? "sigterm"
                  : signal === "SIGKILL"
                    ? "sigkill"
                    : v.is(v.string(), signal)
                      ? "other"
                      : "unknown",
        }),
      );
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
            `^${CLIENT_NAME}/([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\\s|$)`,
          ).exec(userAgent.output)?.[1]
        : undefined;
      this.send({ method: "initialized", params: {} });
      return ok(undefined);
    } catch (cause: unknown) {
      this.detail("spawn_or_initialize_threw");
      await this.stop();
      return err({ reason: classifyThrownFailure(cause), phase: "initialize" });
    }
  }

  async request<P>(
    method: string,
    params: P,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
    discoveryStep?: CodexDiscoveryStep,
  ): Promise<Result<JsonObject, RpcFailure>> {
    if (
      this.child?.stdin === null ||
      this.child?.stdin === undefined ||
      this.stopped ||
      this.broken
    ) {
      this.detail("request_unavailable", { discoveryStep });
      return err("process_unavailable");
    }
    if (signal?.aborted) {
      this.detail("request_aborted", { discoveryStep });
      return err("cancelled");
    }
    const id = String(++this.nextId);
    return new Promise((resolveResult) => {
      const timer = setTimeout(
        () => {
          const pending = this.pending.get(id);
          if (pending === undefined) return;
          this.detail("request_timeout", { discoveryStep });
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
      this.pending.set(id, { resolve, reject, timer, discoveryStep });
      const onAbort = (): void => {
        signal?.removeEventListener("abort", onAbort);
        if (this.pending.delete(id)) {
          this.detail("request_aborted", { discoveryStep });
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
    this.diagnosticStopping = true;
    // Repeated shutdown must preserve failed cessation so the private home remains guarded.
    this.stopPromise ??= (async () => {
      let failureCause: CodexStopFailureCause = "cancel_threw";
      try {
        this.cancel();
        this.stopped = true;
        failureCause = "pending_requests_threw";
        for (const pending of this.pending.values()) {
          this.detail("request_stopped", {
            discoveryStep: pending.discoveryStep,
          });
          clearTimeout(pending.timer);
          pending.reject("stopped");
        }
        this.pending.clear();
        this.listeners.clear();
        failureCause = "unknown";
        if (this.child !== undefined)
          await stopInsightProcess(
            this.child,
            this.ownsProcessGroup,
            (cause) => {
              this.stopFailureCause = cause;
            },
          );
        this.child = undefined;
      } catch (cause) {
        if (cause instanceof InsightProcessCleanupError)
          this.stopFailureErrorCode = cause.cleanupErrorCode;
        this.stopFailureCause ??=
          cause instanceof InsightProcessCleanupError
            ? cause.cleanupCause
            : failureCause;
        throw cause;
      }
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
        this.failPending("stream_limit", {
          bytes: this.buffer.length + part.length,
        });
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
        this.failPending("dynamic_request_limit", { bytes: line.length + 1 });
        return;
      }
      try {
        const parsed = v.safeParse(
          codexRpcMessageSchema,
          JSON.parse(line.toString("utf8")),
        );
        if (parsed.success) this.route(parsed.output, line.length + 1);
        else this.failPending("envelope_invalid");
      } catch {
        this.failPending("decode_or_route_threw");
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
        this.detail("remote_rpc_error", {
          discoveryStep: pending.discoveryStep,
          remoteErrorCode:
            v.is(v.number(), code) &&
            Number.isInteger(code) &&
            code >= -2147483648 &&
            code <= 2147483647
              ? code
              : undefined,
        });
        const base = { _tag: "rpc_error" as const };
        const withCode = code === undefined ? base : { ...base, code };
        const rpcError =
          errorMessage === undefined
            ? withCode
            : { ...withCode, message: errorMessage };
        pending.reject(rpcError);
      } else {
        const result = message.result;
        if (result === undefined || !v.is(codexRpcResultSchema, result)) {
          this.detail("rpc_result_invalid", {
            discoveryStep: pending.discoveryStep,
          });
          pending.reject("invalid_rpc_result");
        } else pending.resolve(result);
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

  private detail(
    code: Extract<CodexDiagnostic, readonly ["rpc_detail", string]>[1],
    fields: CodexDiagnosticFields = {},
  ): void {
    try {
      this.diagnostic?.(["rpc_detail", code], fields, this.diagnosticStopping);
    } catch {
      // Diagnostics cannot settle or interrupt an RPC request.
    }
  }

  private failPending(
    code: Extract<CodexDiagnostic, readonly ["transport_lost", string]>[1],
    fields: CodexDiagnosticFields = {},
  ): void {
    const discoveryStep = [...this.pending.values()].find(
      (pending) => pending.discoveryStep !== undefined,
    )?.discoveryStep;
    try {
      this.diagnostic?.(
        ["transport_lost", code],
        { ...fields, discoveryStep },
        this.diagnosticStopping,
      );
    } catch {
      // Diagnostic delivery cannot prevent pending requests from settling.
    }
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
