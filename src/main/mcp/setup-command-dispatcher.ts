import { safeParse } from "valibot";

import { parseAbsolutePath } from "../../domain/ids";
import { err, type Result } from "../../domain/result";
import type {
  McpSocketRequest,
  McpToolRefusal,
} from "../../mcp/socket-protocol";
import {
  isSetupCommandName,
  setupCommandInputSchemas,
} from "../../mcp/setup-commands";
import type {
  WorkspaceRepositorySet,
  WorkspaceSetupFailure,
  WorkspaceSetupService,
  WorkspaceSetupStatus,
} from "../../services/workspace-setup-service";

export type SetupCommandReply = Result<
  WorkspaceSetupStatus | WorkspaceRepositorySet,
  McpToolRefusal
>;

const setupRefusalMessages = {
  no_github_account:
    "No GitHub account is signed in to gh. Run gh auth login, then run this command again.",
  no_profile:
    "Patchdesk has no workspace yet. Run patchdesk setup add-repo in a checkout to create one.",
  not_watched:
    "The active workspace does not watch this repository. Run patchdesk setup add-repo to add it.",
  checkout_not_a_repository: "The folder is not inside a git checkout.",
  checkout_no_github_origin:
    "The checkout's origin remote does not name a GitHub repository.",
  checkout_origin_mismatch:
    "The checkout's origin remote names a different repository.",
  invalid_input: "Patchdesk could not read the request.",
  storage: "Patchdesk could not read or save the workspace.",
} satisfies Record<WorkspaceSetupFailure["reason"], string>;

/**
 * Answers a `patchdesk setup` request (#702): a thin adapter over the
 * workspace setup service, as the MCP tools are over theirs.
 */
export async function dispatchSetupCommand(
  setup: WorkspaceSetupService,
  request: McpSocketRequest,
): Promise<SetupCommandReply | undefined> {
  if (!isSetupCommandName(request.tool)) return undefined;
  const refused = (reason: WorkspaceSetupFailure["reason"]) =>
    err({ error: reason, message: setupRefusalMessages[reason] });
  if (request.tool === "setup_status") {
    const parsed = safeParse(
      setupCommandInputSchemas.setup_status,
      request.arguments,
    );
    if (!parsed.success) return refused("invalid_input");
    const status = await setup.status();
    return status._tag === "ok" ? status : refused(status.error.reason);
  }
  const parsed = safeParse(
    setupCommandInputSchemas[request.tool],
    request.arguments,
  );
  if (!parsed.success) return refused("invalid_input");
  const folder = parseAbsolutePath(parsed.output.cwd);
  if (folder._tag === "err") return refused("invalid_input");
  const set =
    request.tool === "setup_add_repo"
      ? await setup.addRepository(folder.value)
      : await setup.setCheckout(folder.value);
  return set._tag === "ok" ? set : refused(set.error.reason);
}
