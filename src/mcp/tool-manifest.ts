import * as v from "valibot";

/**
 * The tools the shim registers (ADR 0052 "Tools, v1"). The app's dispatcher
 * in `src/main/mcp/mcp-tool-dispatcher.ts` is keyed by the same names and
 * re-validates each call with the same schema.
 */
export const mcpToolManifest = {
  list_repositories: {
    description:
      "List the repositories of the active Patchdesk workspace profile that have a local checkout, with each live checkout (the configured one and its linked worktrees) and the branch it is on. Reads local git only.",
    inputSchema: v.strictObject({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
} as const;

export type McpToolName = keyof typeof mcpToolManifest;

export function isMcpToolName(name: string): name is McpToolName {
  return Object.hasOwn(mcpToolManifest, name);
}

export const mcpToolNames: ReadonlyArray<McpToolName> =
  Object.keys(mcpToolManifest).filter(isMcpToolName);
