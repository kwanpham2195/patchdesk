import { isAbsolute } from "node:path";

import * as v from "valibot";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";

/**
 * The line protocol between the `patchdesk mcp` shim and the app's socket
 * listener (ADR 0052): one connection per call, one JSON request line in and
 * one JSON reply line out. Both sides import this module, so the path and
 * bounds cannot drift apart.
 */
export const MCP_SOCKET_ENV = "PATCHDESK_MCP_SOCKET";

/** ADR 0052 "Bounds": the timeout matches the desktop bridge's. */
export const mcpSocketBounds = {
  maxRequestBytes: 256 * 1024,
  maxReplyBytes: 4 * 1024 * 1024,
  timeoutMs: 30_000,
} as const;

export type McpSocketBounds = {
  readonly maxRequestBytes: number;
  readonly maxReplyBytes: number;
  readonly timeoutMs: number;
};

/**
 * `PATCHDESK_MCP_SOCKET` when it is an absolute path, else
 * `<dataDirectory>/mcp/patchdesk.sock`. A relative value is ignored: the app
 * and the shim run in different working directories and would disagree.
 */
export function resolveMcpSocketPath(
  override: string | undefined,
  paths: Pick<PatchdeskPaths, "mcpSocketFile">,
): string {
  return override !== undefined && isAbsolute(override)
    ? override
    : paths.mcpSocketFile();
}

export const mcpSocketRequestSchema = v.strictObject({
  tool: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  arguments: v.unknown(),
  /** The MCP client's own name, which an agent run request records (ADR 0052). */
  client: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
});

export type McpSocketRequest = v.InferOutput<typeof mcpSocketRequestSchema>;

/** A refused call: `error` is the service's reason or one the MCP layer adds. */
const mcpToolRefusalSchema = v.strictObject({
  error: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  message: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
  retryAfterMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export type McpToolRefusal = v.InferOutput<typeof mcpToolRefusalSchema>;

export const mcpSocketReplySchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    result: v.looseObject({}),
  }),
  v.strictObject({
    ok: v.literal(false),
    ...mcpToolRefusalSchema.entries,
  }),
]);

export type McpSocketReply = v.InferOutput<typeof mcpSocketReplySchema>;
