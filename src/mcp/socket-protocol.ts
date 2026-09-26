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

/** `PATCHDESK_MCP_SOCKET` when set and non-empty, else `<dataDirectory>/mcp/patchdesk.sock`. */
export function resolveMcpSocketPath(
  override: string | undefined,
  paths: Pick<PatchdeskPaths, "mcpSocketFile">,
): string {
  return override === undefined || override === ""
    ? paths.mcpSocketFile()
    : override;
}

export const mcpSocketRequestSchema = v.strictObject({
  tool: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  arguments: v.unknown(),
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
