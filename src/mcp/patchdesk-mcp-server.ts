import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { toStandardJsonSchema } from "@valibot/to-json-schema";

import { callPatchdeskApp } from "./socket-client";
import type {
  McpSocketBounds,
  McpSocketReply,
  McpSocketRequest,
} from "./socket-protocol";
import { mcpToolManifest, mcpToolNames } from "./tool-manifest";

export type PatchdeskMcpServerOptions = {
  readonly socketPath: string;
  readonly version: string;
  /** One stderr line per failed call; stdout carries the protocol. */
  readonly report: (line: string) => void;
  /** `PATCHDESK_MCP_DEBUG=1`: one more stderr line per call. */
  readonly debug: boolean;
  readonly bounds?: McpSocketBounds;
};

/**
 * The shim's server factory (ADR 0052). `serveStdio` pins one instance per
 * connection for either protocol era, so this registers the tools once and
 * each handler forwards its call to the app over the socket.
 */
export function createPatchdeskMcpServer(
  options: PatchdeskMcpServerOptions,
): McpServer {
  const server = new McpServer({
    name: "patchdesk",
    version: options.version,
  });
  for (const name of mcpToolNames) {
    const tool = mcpToolManifest[name];
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: toStandardJsonSchema(tool.inputSchema),
        annotations: tool.annotations,
      },
      async (input) => {
        // Backfilled per request on the 2026-07-28 era, so one read serves both eras.
        const client = server.server.getClientVersion()?.name;
        return toolResult(
          await forward(options, {
            tool: name,
            arguments: input,
            ...(client !== undefined &&
              client.length > 0 && { client: client.slice(0, 128) }),
          }),
        );
      },
    );
  }
  return server;
}

async function forward(
  options: PatchdeskMcpServerOptions,
  request: McpSocketRequest,
): Promise<McpSocketReply> {
  const { tool } = request;
  const startedAt = performance.now();
  const call = await callPatchdeskApp(
    options.socketPath,
    request,
    options.bounds,
  );
  const outcome = call.reply.ok ? "ok" : call.reply.error;
  if (call.failure !== undefined)
    options.report(
      `patchdesk mcp: ${tool} failed (${outcome}): ${call.failure} at ${options.socketPath}`,
    );
  else if (options.debug)
    options.report(
      `patchdesk mcp: ${tool} ${outcome} in ${Math.round(performance.now() - startedAt)} ms`,
    );
  return call.reply;
}

/** A refusal is a tool result with `isError`, so both eras and both clients show its message. */
function toolResult(reply: McpSocketReply): CallToolResult {
  if (reply.ok)
    return {
      content: [{ type: "text", text: JSON.stringify(reply.result) }],
      structuredContent: reply.result,
    };
  const { ok: _ok, ...refusal } = reply;
  return {
    isError: true,
    content: [{ type: "text", text: reply.message }],
    structuredContent: refusal,
  };
}
