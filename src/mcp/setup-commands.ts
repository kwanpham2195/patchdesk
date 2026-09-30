import { isAbsolute } from "node:path";

import * as v from "valibot";

/**
 * The `patchdesk setup` commands (#702) as socket requests. They share the
 * MCP socket with the tools but are not MCP tools: the `patchdesk mcp` server
 * registers only the tool manifest, so an agent's MCP client cannot reach
 * them, and they run only from a terminal (ADR 0052, amended in #702).
 */
const setupCommandNames = [
  "setup_status",
  "setup_add_repo",
  "setup_set_checkout",
] as const;

export type SetupCommandName = (typeof setupCommandNames)[number];

export function isSetupCommandName(name: string): name is SetupCommandName {
  return setupCommandNames.some((command) => command === name);
}

const folderInputSchema = v.strictObject({
  cwd: v.pipe(
    v.string(),
    v.maxLength(4_096),
    v.check(isAbsolute, "cwd must be an absolute path."),
  ),
});

export const setupCommandInputSchemas = {
  setup_status: v.strictObject({}),
  setup_add_repo: folderInputSchema,
  setup_set_checkout: folderInputSchema,
} as const satisfies Record<SetupCommandName, v.GenericSchema>;
