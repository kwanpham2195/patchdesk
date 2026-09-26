import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import * as v from "valibot";

import type { PatchdeskPaths } from "../../adapters/storage/patchdesk-paths";
import { whenLoginShellEnvironmentImported } from "../../adapters/process/login-shell-import";
import { loggableMetaValue } from "../../domain/log-entry";
import { parseReviewId } from "../../domain/ids";
import { err } from "../../domain/result";
import { readObjectField } from "../../services/read-object-field";
import {
  MCP_SOCKET_ENV,
  mcpSocketBounds,
  mcpSocketRequestSchema,
  resolveMcpSocketPath,
  type McpSocketBounds,
  type McpSocketReply,
  type McpToolRefusal,
} from "../../mcp/socket-protocol";
import { isMcpToolName } from "../../mcp/tool-manifest";
import type { LogWriter } from "../local-api-container";
import {
  dispatchMcpTool,
  type McpRefusedCall,
  type McpToolReply,
  type McpToolTable,
} from "./mcp-tool-dispatcher";

/** How binding ended: `in_use` is another live instance on the path, left alone. */
export type McpSocketListenOutcome = "listening" | "in_use" | "failed";

export type McpSocketListener = {
  readonly listening: Promise<McpSocketListenOutcome>;
  stop(): Promise<void>;
};

export type McpSocketListenerOptions = {
  readonly socketPath: () => Promise<string>;
  readonly tools: McpToolTable;
  readonly logs: LogWriter;
  /** Refused and failed calls also go to the diagnostics Settings lists. */
  readonly recordRefusal?: (refused: McpRefusedCall) => Promise<void>;
  readonly bounds?: McpSocketBounds;
  /** How long `stop` waits for calls still running; defaults to 3 s so quitting never stalls on one. */
  readonly stopGraceMs?: number;
};

/**
 * The socket path the desktop app listens on. `PATCHDESK_MCP_SOCKET` is read
 * only after the login-shell import settles, as every main-process read of
 * `process.env` is (ADR 0038).
 */
export async function desktopMcpSocketPath(
  paths: PatchdeskPaths,
): Promise<string> {
  await whenLoginShellEnvironmentImported();
  return resolveMcpSocketPath(process.env[MCP_SOCKET_ENV], paths);
}

/**
 * The app side of the MCP shim (ADR 0052 "Transport"): a Unix socket in a
 * `0700` directory, `0600` itself, answering one JSON line per connection.
 * It binds beside startup rather than before it, so waiting on the socket
 * path never delays the window.
 */
export function startMcpSocketListener(
  options: McpSocketListenerOptions,
): McpSocketListener {
  const bounds = options.bounds ?? mcpSocketBounds;
  const connections = new Set<Socket>();
  // Calls still running when the listener stops; stop waits a grace period for them, so a tool or diagnostics write rarely outlives it.
  const answering = new Set<Promise<void>>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    answerConnection(socket, options, bounds, (answer) => {
      const settled = answer.catch((cause: unknown) => {
        options.logs.write({
          process: "main",
          level: "error",
          topic: "mcp",
          message: "reply failed",
          meta: { error: loggableMetaValue(cause) },
        });
        socket.destroy();
      });
      answering.add(settled);
      void settled.then(() => answering.delete(settled));
    });
  });
  const listening = listen(server, options);
  return {
    listening,
    async stop() {
      if ((await listening) !== "listening") return;
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      let grace: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([
        Promise.all(answering).then(() => true),
        new Promise<false>((resolve) => {
          grace = setTimeout(
            () => resolve(false),
            options.stopGraceMs ?? 3_000,
          );
        }),
      ]);
      clearTimeout(grace);
      if (!finished)
        options.logs.write({
          process: "main",
          level: "warn",
          topic: "mcp",
          message: "stopped with calls still running",
          meta: { calls: answering.size },
        });
    },
  };
}

async function listen(
  server: Server,
  options: McpSocketListenerOptions,
): Promise<McpSocketListenOutcome> {
  const { logs } = options;
  let socketPath: string | undefined;
  try {
    socketPath = await options.socketPath();
    const directory = dirname(socketPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await isPrivateDirectory(directory))) {
      logs.write({
        process: "main",
        level: "error",
        topic: "mcp",
        message: "socket directory is not private",
        meta: { socketPath },
      });
      return "failed";
    }
    const existing = await probeExistingSocket(socketPath);
    if (existing === "live") {
      logs.write({
        process: "main",
        level: "warn",
        topic: "mcp",
        message: "socket in use by another instance",
        meta: { socketPath },
      });
      return "in_use";
    }
    if (existing === "stale") {
      await unlink(socketPath);
      logs.write({
        process: "main",
        level: "info",
        topic: "mcp",
        message: "stale socket removed",
        meta: { socketPath },
      });
    }
    const path = socketPath;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    // A late accept error with no listener would reach `uncaughtException` and exit the app.
    server.on("error", (cause) => {
      logs.write({
        process: "main",
        level: "error",
        topic: "mcp",
        message: "socket error",
        meta: { error: loggableMetaValue(cause) },
      });
    });
    logs.write({
      process: "main",
      level: "info",
      topic: "mcp",
      message: "listening",
      meta: { socketPath },
    });
    return "listening";
  } catch (cause: unknown) {
    server.close();
    logs.write({
      process: "main",
      level: "error",
      topic: "mcp",
      message: "listen failed",
      meta: { socketPath: socketPath ?? null, error: loggableMetaValue(cause) },
    });
    return "failed";
  }
}

/** The socket's only access control is its directory: it must be ours and closed to group and others. */
async function isPrivateDirectory(directory: string): Promise<boolean> {
  const stats = await lstat(directory);
  return (
    stats.isDirectory() &&
    stats.uid === process.getuid?.() &&
    (stats.mode & 0o077) === 0
  );
}

/** A refused connection is a file a crashed instance left; only a socket file is ever removed. */
async function probeExistingSocket(
  socketPath: string,
): Promise<"none" | "live" | "stale"> {
  const stats = await lstat(socketPath).catch(() => undefined);
  if (stats === undefined) return "none";
  if (!stats.isSocket())
    throw new Error(
      "The MCP socket path is taken by a file that is not a socket",
    );
  return await new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve("live");
    });
    probe.once("error", (cause: NodeJS.ErrnoException) => {
      resolve(cause.code === "ECONNREFUSED" ? "stale" : "live");
    });
  });
}

function answerConnection(
  socket: Socket,
  options: McpSocketListenerOptions,
  bounds: McpSocketBounds,
  track: (answer: Promise<void>) => void,
): void {
  const received: Buffer[] = [];
  let receivedBytes = 0;
  // Idle bound: a peer that stops sending, or a call that stalls, is cut at the desktop bridge's bound.
  socket.setTimeout(bounds.timeoutMs, () => socket.destroy());
  const onData = (chunk: Buffer): void => {
    const newline = chunk.indexOf(0x0a);
    const part = newline === -1 ? chunk : chunk.subarray(0, newline);
    received.push(part);
    receivedBytes += part.length;
    if (receivedBytes > bounds.maxRequestBytes) {
      socket.off("data", onData);
      track(
        refuse(socket, options, "too_large", {
          error: "too_large",
          message: `The request is larger than ${bounds.maxRequestBytes} bytes.`,
        }),
      );
      return;
    }
    if (newline === -1) return;
    socket.off("data", onData);
    track(
      answerLine(
        socket,
        options,
        bounds,
        Buffer.concat(received).toString("utf8"),
      ),
    );
  };
  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
}

async function answerLine(
  socket: Socket,
  options: McpSocketListenerOptions,
  bounds: McpSocketBounds,
  line: string,
): Promise<void> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    await refuse(socket, options, "invalid_json", invalidRequest);
    return;
  }
  const request = v.safeParse(mcpSocketRequestSchema, decoded);
  if (!request.success) {
    await refuse(socket, options, "invalid_request", invalidRequest);
    return;
  }
  const startedAt = performance.now();
  let reply: McpToolReply;
  try {
    reply = await dispatchMcpTool(options.tools, request.output);
  } catch (cause: unknown) {
    options.logs.write({
      process: "main",
      level: "error",
      topic: "mcp",
      message: "tool failed",
      meta: { tool: request.output.tool, error: loggableMetaValue(cause) },
    });
    reply = err(storageFailure);
  }
  let serialized: ReturnType<typeof serializeReply>;
  try {
    serialized = serializeReply(reply, bounds);
  } catch (cause: unknown) {
    options.logs.write({
      process: "main",
      level: "error",
      topic: "mcp",
      message: "tool failed",
      meta: { tool: request.output.tool, error: loggableMetaValue(cause) },
    });
    serialized = serializeReply(err(storageFailure), bounds);
  }
  const durationMs = Math.round(performance.now() - startedAt);
  const reviewId = parseReviewId(
    readObjectField(request.output.arguments, "reviewId"),
  );
  options.logs.write({
    process: "main",
    level: serialized.outcome === "ok" ? "info" : "warn",
    topic: "mcp",
    message: "tool called",
    meta: {
      tool: request.output.tool,
      ...(reviewId._tag === "ok" && { reviewId: reviewId.value }),
      durationMs,
      outcome: serialized.outcome,
    },
  });
  if (serialized.outcome === "too_large")
    options.logs.write({
      process: "main",
      level: "warn",
      topic: "mcp",
      message: "refused",
      meta: { reason: "too_large", direction: "reply" },
    });
  socket.end(serialized.text);
  if (serialized.outcome !== "ok")
    // An unknown tool name is the agent's own text, so the diagnostics phase names only the request.
    await options.recordRefusal?.({
      ...(isMcpToolName(request.output.tool) && { tool: request.output.tool }),
      reason: serialized.outcome,
      durationMs,
    });
}

const storageFailure: McpToolRefusal = {
  error: "storage",
  message: "Patchdesk could not complete the call.",
};

const invalidRequest: McpToolRefusal = {
  error: "invalid_input",
  message: "The request is not one JSON line naming a tool and its arguments.",
};

/** Serializes the reply; one over the bound is replaced by a `too_large` refusal. */
function serializeReply(reply: McpToolReply, bounds: McpSocketBounds) {
  const wire: McpSocketReply =
    reply._tag === "ok"
      ? { ok: true, result: reply.value }
      : { ok: false, ...reply.error };
  const text = `${JSON.stringify(wire)}\n`;
  if (Buffer.byteLength(text) <= bounds.maxReplyBytes)
    return { text, outcome: wire.ok ? "ok" : wire.error };
  const refused: McpSocketReply = {
    ok: false,
    error: "too_large",
    message: `The result is larger than ${bounds.maxReplyBytes} bytes.`,
  };
  return { text: `${JSON.stringify(refused)}\n`, outcome: "too_large" };
}

async function refuse(
  socket: Socket,
  options: McpSocketListenerOptions,
  reason: "too_large" | "invalid_json" | "invalid_request",
  refusal: McpToolRefusal,
): Promise<void> {
  options.logs.write({
    process: "main",
    level: "warn",
    topic: "mcp",
    message: "refused",
    meta: { reason, direction: "request" },
  });
  const reply: McpSocketReply = { ok: false, ...refusal };
  socket.end(`${JSON.stringify(reply)}\n`);
  await options.recordRefusal?.({ reason });
}
