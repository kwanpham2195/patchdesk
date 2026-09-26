import { connect } from "node:net";

import * as v from "valibot";

import {
  mcpSocketBounds,
  mcpSocketReplySchema,
  type McpSocketBounds,
  type McpSocketReply,
  type McpSocketRequest,
} from "./socket-protocol";

/** The app's reply, or the refusal the shim makes when it gets none; `failure` says why for stderr. */
export type McpSocketCall = {
  readonly reply: McpSocketReply;
  readonly failure?: string;
};

/**
 * Forwards one tool call to the running app over a fresh connection. Every
 * call connects afresh, so an app restart mid-session needs no client
 * reconnect. The shim never starts the app.
 */
export function callPatchdeskApp(
  socketPath: string,
  request: McpSocketRequest,
  bounds: McpSocketBounds = mcpSocketBounds,
): Promise<McpSocketCall> {
  return new Promise((resolve) => {
    const received: Buffer[] = [];
    let receivedBytes = 0;
    let connected = false;
    let settled = false;
    const socket = connect(socketPath);
    const settle = (call: McpSocketCall): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(call);
    };
    const timer = setTimeout(() => {
      settle(
        connected
          ? notResponding("no reply within the timeout")
          : notRunning("connect timed out"),
      );
    }, bounds.timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      received.push(part);
      receivedBytes += part.length;
      if (receivedBytes > bounds.maxReplyBytes) {
        settle({
          reply: {
            ok: false,
            error: "too_large",
            message: `The result is larger than ${bounds.maxReplyBytes} bytes.`,
          },
          failure: "reply over the size bound",
        });
        return;
      }
      if (newline !== -1)
        settle(parseReply(Buffer.concat(received).toString("utf8")));
    });
    socket.on("error", (cause: NodeJS.ErrnoException) => {
      settle(
        connected
          ? notResponding(cause.code ?? cause.message)
          : notRunning(cause.code ?? cause.message),
      );
    });
    socket.on("close", () => {
      settle(notResponding("connection closed without a reply"));
    });
  });
}

function parseReply(line: string): McpSocketCall {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return notResponding("malformed reply");
  }
  const parsed = v.safeParse(mcpSocketReplySchema, decoded);
  return parsed.success
    ? { reply: parsed.output }
    : notResponding("malformed reply");
}

function notRunning(failure: string): McpSocketCall {
  return {
    reply: {
      ok: false,
      error: "app_not_running",
      message: "Patchdesk is not running. Start Patchdesk and try again.",
    },
    failure,
  };
}

function notResponding(failure: string): McpSocketCall {
  return {
    reply: {
      ok: false,
      error: "app_not_responding",
      message:
        "Patchdesk did not answer. Try again; if it keeps failing, run `patchdesk mcp --check`.",
    },
    failure,
  };
}
