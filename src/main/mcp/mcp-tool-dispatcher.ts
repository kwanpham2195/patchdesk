import { safeParse, type InferOutput } from "valibot";

import type {
  GitHubHost,
  GitHubOwner,
  GitHubRepoName,
  WorkspaceProfileId,
} from "../../domain/ids";
import { definedProps } from "../../domain/defined-props";
import { err, ok, type Result } from "../../domain/result";
import type { DashboardController } from "../../services/dashboard-controller";
import {
  describeRepositoryCheckout,
  type RepositoryCheckoutDescription,
} from "../../services/local-checkout";
import type {
  LocalReviewOpenFailure,
  LocalReviewPrepared,
} from "../../services/local-review-opening";
import type { ReviewDiagnosticService } from "../../services/review-diagnostic-service";
import {
  ReviewInsightReader,
  type InsightReading,
} from "../../services/review-insight-reading";
import type { ReviewWorkbenchController } from "../../services/review-workbench-controller";
import type {
  McpSocketRequest,
  McpToolRefusal,
} from "../../mcp/socket-protocol";
import type { LocalFeedback } from "../../services/local-draft-service";
import type { AgentRunRequestReply } from "../../services/agent-run-request-service";
import {
  isMcpToolName,
  mcpToolManifest,
  type McpToolName,
} from "../../mcp/tool-manifest";
import {
  getFeedback,
  getInsight,
  readActiveProfile,
  refreshReview,
  reviewLocal,
  runInsight,
  type McpReviewToolServices,
  type ReviewLocalResult,
} from "./mcp-review-tools";

/** What `list_repositories` returns: the active profile's repositories that have a `localPath`. */
type ListRepositoriesResult = {
  readonly profile: { readonly id: WorkspaceProfileId; readonly label: string };
  readonly repositories: ReadonlyArray<LocalRepositoryListing>;
};

export type McpToolReply = Result<
  | ListRepositoriesResult
  | ReviewLocalResult
  | LocalReviewPrepared
  | InsightReading
  | LocalFeedback
  | AgentRunRequestReply,
  McpToolRefusal
>;

type LocalRepositoryListing = {
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly localPath: string;
  readonly checkouts: ReadonlyArray<RepositoryCheckoutDescription>;
  /** Why `checkouts` is empty when git could not list them. */
  readonly checkoutError?: LocalReviewOpenFailure["reason"];
};

/** What a call carries besides its arguments. */
type McpCallContext = { readonly clientName?: string };

type McpToolEntry<Name extends McpToolName> = {
  readonly schema: (typeof mcpToolManifest)[Name]["inputSchema"];
  call(
    input: InferOutput<(typeof mcpToolManifest)[Name]["inputSchema"]>,
    context: McpCallContext,
  ): Promise<McpToolReply>;
};

/** The dispatcher table (ADR 0052 "One implementation"): one entry per manifest tool, each a thin adapter over a service. */
export type McpToolTable = {
  readonly [Name in McpToolName]: McpToolEntry<Name>;
};

/** The services the tools call; `insightReader` is built here over the workbench `load` the renderer's route calls. */
export type McpToolServices = Omit<McpReviewToolServices, "insightReader"> & {
  readonly reviewWorkbench: Pick<ReviewWorkbenchController, "load">;
};

export function createMcpToolTable(services: McpToolServices): McpToolTable {
  const tools: McpReviewToolServices = {
    ...services,
    insightReader: new ReviewInsightReader(
      services.reviewWorkbench,
      services.sessions,
      services.reviews,
    ),
  };
  return {
    list_repositories: {
      schema: mcpToolManifest.list_repositories.inputSchema,
      call: () => listRepositories(tools),
    },
    review_local: {
      schema: mcpToolManifest.review_local.inputSchema,
      call: (input) => reviewLocal(tools, input),
    },
    refresh_review: {
      schema: mcpToolManifest.refresh_review.inputSchema,
      call: (input) => refreshReview(tools, input),
    },
    get_insight: {
      schema: mcpToolManifest.get_insight.inputSchema,
      call: (input) => getInsight(tools, input),
    },
    get_feedback: {
      schema: mcpToolManifest.get_feedback.inputSchema,
      call: (input) => getFeedback(tools, input),
    },
    run_insight: {
      schema: mcpToolManifest.run_insight.inputSchema,
      call: (input, context) => runInsight(tools, input, context),
    },
  };
}

/** A tool call the app refused or failed; `tool` is absent when the request line named none. */
export type McpRefusedCall = {
  readonly tool?: string;
  readonly reason: string;
  readonly durationMs?: number;
};

/**
 * Records refused and failed calls in the active profile's diagnostics, so
 * Settings → Data & recovery lists them (ADR 0052 "Logging and
 * diagnostics"). Best effort: with no saved profile there is nowhere to
 * record, and the call is already in `patchdesk.jsonl`.
 */
export function createMcpRefusalRecorder(services: {
  readonly dashboard: Pick<DashboardController, "savedProfiles">;
  readonly diagnostics: Pick<ReviewDiagnosticService, "record">;
}): (refused: McpRefusedCall) => Promise<void> {
  return async (refused) => {
    const profiles = await services.dashboard.savedProfiles();
    if (profiles._tag === "err") return;
    await services.diagnostics.record({
      category: "mcp",
      phase: `${refused.tool ?? "request"} ${refused.reason}`,
      profileId: profiles.value.active.id,
      retryable: refused.reason === "in_progress",
      ...definedProps({ durationMs: refused.durationMs }),
    });
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
  return await tool.call(
    parsed.output,
    definedProps({ clientName: request.client }),
  );
}

async function listRepositories(
  services: McpReviewToolServices,
): Promise<McpToolReply> {
  const profiles = await readActiveProfile(services);
  if (profiles._tag === "err") return profiles;
  const profile = profiles.value.active;
  const repositories = await Promise.all(
    profile.repos.flatMap(({ host, owner, repo, localPath }) =>
      localPath === undefined
        ? []
        : [
            describeLocalRepository(services, profile.id, {
              host,
              owner,
              repo,
              localPath,
            }),
          ],
    ),
  );
  return ok({
    profile: { id: profile.id, label: profile.label },
    repositories,
  });
}

async function describeLocalRepository(
  services: McpReviewToolServices,
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
