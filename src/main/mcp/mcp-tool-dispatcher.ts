import { safeParse, type InferOutput } from "valibot";

import type {
  GitHubHost,
  GitHubOwner,
  GitHubRepoName,
  WorkspaceProfileId,
} from "../../domain/ids";
import { err, ok, type Result } from "../../domain/result";
import type { DashboardController } from "../../services/dashboard-controller";
import {
  describeRepositoryCheckout,
  type RepositoryCheckoutDescription,
} from "../../services/local-checkout";
import type {
  LocalReviewOpenFailure,
  LocalReviewOpening,
} from "../../services/local-review-opening";
import type {
  McpSocketRequest,
  McpToolRefusal,
} from "../../mcp/socket-protocol";
import {
  isMcpToolName,
  mcpToolManifest,
  type McpToolName,
} from "../../mcp/tool-manifest";

/** What `list_repositories` returns: the active profile's repositories that have a `localPath`. */
type ListRepositoriesResult = {
  readonly profile: { readonly id: WorkspaceProfileId; readonly label: string };
  readonly repositories: ReadonlyArray<LocalRepositoryListing>;
};

type LocalRepositoryListing = {
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly localPath: string;
  readonly checkouts: ReadonlyArray<RepositoryCheckoutDescription>;
  /** Why `checkouts` is empty when git could not list them. */
  readonly checkoutError?: LocalReviewOpenFailure["reason"];
};

export type McpToolReply = Result<ListRepositoriesResult, McpToolRefusal>;

type McpToolEntry<Name extends McpToolName> = {
  readonly schema: (typeof mcpToolManifest)[Name]["inputSchema"];
  call(
    input: InferOutput<(typeof mcpToolManifest)[Name]["inputSchema"]>,
  ): Promise<McpToolReply>;
};

/** The dispatcher table (ADR 0052 "One implementation"): one entry per manifest tool, each a thin adapter over a service. */
export type McpToolTable = {
  readonly [Name in McpToolName]: McpToolEntry<Name>;
};

type McpToolServices = {
  readonly dashboard: Pick<DashboardController, "activeProfile">;
  readonly localReviewOpening: Pick<LocalReviewOpening, "listCheckouts">;
};

export function createMcpToolTable(services: McpToolServices): McpToolTable {
  return {
    list_repositories: {
      schema: mcpToolManifest.list_repositories.inputSchema,
      call: () => listRepositories(services),
    },
  };
}

/** Re-validates the call with the tool's own schema before any service runs. */
export async function dispatchMcpTool(
  table: McpToolTable,
  request: McpSocketRequest,
): Promise<McpToolReply> {
  if (!isMcpToolName(request.tool))
    return err({
      error: "invalid_input",
      message: `Patchdesk has no tool named ${request.tool}.`,
    });
  const tool: McpToolEntry<McpToolName> = table[request.tool];
  const parsed = safeParse(tool.schema, request.arguments);
  if (!parsed.success)
    return err({
      error: "invalid_input",
      message: `The arguments do not match ${request.tool}'s input schema.`,
    });
  return await tool.call(parsed.output);
}

async function listRepositories(
  services: McpToolServices,
): Promise<McpToolReply> {
  const profile = await services.dashboard.activeProfile();
  if (profile._tag === "err")
    return err(
      profile.error.reason === "not_found"
        ? {
            error: "not_found",
            message: "No workspace profile is configured in Patchdesk.",
          }
        : {
            error: "storage",
            message: "Patchdesk could not read its workspace profiles.",
          },
    );
  const repositories = await Promise.all(
    profile.value.repos.flatMap(({ host, owner, repo, localPath }) =>
      localPath === undefined
        ? []
        : [
            describeLocalRepository(services, profile.value.id, {
              host,
              owner,
              repo,
              localPath,
            }),
          ],
    ),
  );
  return ok({
    profile: { id: profile.value.id, label: profile.value.label },
    repositories,
  });
}

async function describeLocalRepository(
  services: McpToolServices,
  profileId: WorkspaceProfileId,
  repository: Omit<LocalRepositoryListing, "checkouts" | "checkoutError">,
): Promise<LocalRepositoryListing> {
  const listed = await services.localReviewOpening.listCheckouts(
    profileId,
    repository,
  );
  return listed._tag === "ok"
    ? {
        ...repository,
        checkouts: listed.value.map(describeRepositoryCheckout),
      }
    : { ...repository, checkouts: [], checkoutError: listed.error.reason };
}
