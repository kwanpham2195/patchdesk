import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  optional,
  safeParse,
  minLength,
  object,
  picklist,
  pipe,
  string,
} from "valibot";

import { APP_CAPABILITY_HEADER, type AppCapability } from "./ipc-contract";
import { hasMatchingAppCapability } from "./app-capability";
import type { LocalApiStartupResult } from "./app-lifecycle";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ProfileStore } from "../adapters/storage/profile-store";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { GitHubAdapter } from "../adapters/github/github-adapter";
import { CommandRunner } from "../adapters/github/command-runner";
import { WorkspaceOriginFinder } from "../adapters/github/workspace-origin-finder";
import type {
  GitHubMergeWriter,
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { OriginFinder } from "../services/dashboard-service";
import { DashboardController } from "../services/dashboard-controller";
import { ReviewWriteController } from "../services/review-write-controller";
import { ReviewDraftController } from "../services/review-draft-controller";
import { ReviewWorkbenchController } from "../services/review-workbench-controller";
import { MergeWriteController } from "../services/merge-write-controller";
import { ReviewCompletionService } from "../services/review-completion-service";
import { projectSafeRun } from "../services/run-projection";
import { ReviewRunRegistry } from "../services/review-run-registry";
import { ReviewRunCoordinator } from "../services/review-run-coordinator";
import { ReviewRecoveryService } from "../services/review-recovery-service";
import { ReviewContextService } from "../services/review-context-service";
import { ReviewWorktreeService } from "../services/review-worktree-service";
import { ReviewComparisonService } from "../services/review-comparison-service";
import { ReviewExecutionService, REVIEW_REASONING_LEVELS } from "../services/review-execution-service";
import { ReviewHeadVerifier } from "../services/review-head-verifier";
import type { PiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import {
  ReviewWorkflowStarter,
  type ReviewWorkflowInvoker,
} from "../services/review-workflow-starter";
import { err, ok } from "../domain/result";
import type { SafeRunProjection } from "../services/run-projection";
import { parseWorkspaceProfileId } from "../domain/ids";

const localApiConfigurationSchema = object({
  allowedOrigin: pipe(string(), minLength(1)),
  developmentOrigin: optional(pipe(string(), minLength(1))),
  capability: pipe(string(), minLength(1)),
  appMetadata: optional(
    object({
      productName: pipe(string(), minLength(1)),
      version: pipe(string(), minLength(1)),
      architecture: pipe(string(), minLength(1)),
      distribution: picklist(["development", "unsigned_internal"]),
    }),
  ),
});

const localhostHostname = "127.0.0.1";

/** Configuration required to bind the authenticated loopback API. */
export type LocalApiConfiguration = {
  readonly allowedOrigin: string;
  /** Vite's fixed renderer origin, accepted only by the unpackaged desktop app. */
  readonly developmentOrigin?: string | undefined;
  readonly capability: AppCapability;
  readonly appMetadata?:
    | {
        readonly productName: string;
        readonly version: string;
        readonly architecture: string;
        readonly distribution: "development" | "unsigned_internal";
      }
    | undefined;
  /** Explicit seams used only by local integration tests; production uses real main-process adapters. */
  readonly github?: GitHubReader;
  /** Test-only write seam. A reader alone must never enable review-write routes. */
  readonly reviewWriter?: GitHubReviewWriter;
  /** Test-only merge seam. Production gets this capability from the main-process adapter. */
  readonly mergeWriter?: GitHubMergeWriter;
  readonly origins?: OriginFinder;
  readonly paths?: PatchdeskPaths;
  /** Main-process-owned finite Flue invocation; renderer requests never provide workflow paths. */
  readonly workflowInvoker?: ReviewWorkflowInvoker;
  /** Models advertised by the active Flue/Pi runtime. Model identifiers stay main-process owned. */
  readonly supportedReviewModels?: ReadonlyArray<string>;
  /** Main-process-only source of currently enabled Pi models. */
  readonly modelCatalog?: PiRuntimeModelCatalog;
  /** Test-only adapter; production never accepts mutable run state over HTTP. */
  readonly runProjection?: (input: {
    readonly runId: string;
    readonly sessionId: string;
    readonly attemptId: string;
  }) => SafeRunProjection;
};

/** A running local API that owns its HTTP server lifecycle. */
export type LocalApiServer = {
  readonly capability: AppCapability;
  readonly url: URL;
  stop(): Promise<void>;
};

/** Starts the Hono API on a random loopback port with capability and origin checks. */
export async function startLocalApiServer(
  configuration: LocalApiConfiguration,
): Promise<LocalApiStartupResult<LocalApiServer>> {
  const parsedConfiguration = safeParse(
    localApiConfigurationSchema,
    configuration,
  );
  if (!parsedConfiguration.success) {
    return { _tag: "invalid-configuration" };
  }

  const app = new Hono();
  const runs = new ReviewRunRegistry();
  app.use("*", corsForRenderer(parsedConfiguration.output));
  app.use("*", requireLocalApiAccess(parsedConfiguration.output));
  app.get("/health", (context) => context.json({ status: "ok" }));
  const paths = configuration.paths ?? PatchdeskPaths.default();
  const commands = new CommandRunner();
  const github = configuration.github ?? new GitHubAdapter(commands);
  const readOnlyGit = {
    async run(argv: ReadonlyArray<string>) {
      const output = await commands.runText({ argv, timeoutMs: 15_000 });
      return output._tag === "ok"
        ? ok({ stdout: output.value })
        : err({ _tag: "GitReadFailed" as const });
    },
  };
  const profiles = new ProfileStore(paths);
  const sessions = new ReviewSessionStore(paths);
  await new ReviewRecoveryService(
    profiles,
    sessions,
    () => new Date().toISOString() as never,
  ).reconcile();
  const dashboard = new DashboardController(
    profiles,
    github,
    configuration.origins ?? new WorkspaceOriginFinder(commands),
    paths,
  );
  const writer =
    configuration.reviewWriter ??
    (isGitHubReviewWriter(github) ? github : undefined);
  const reviewWrites =
    writer === undefined
      ? undefined
      : new ReviewWriteController(
          profiles,
          sessions,
          {
            getPullRequest: github.getPullRequest.bind(github),
            createPendingReview: writer.createPendingReview.bind(writer),
            submitPendingReview: writer.submitPendingReview.bind(writer),
          },
          () => new Date().toISOString() as never,
        );
  const reviewDrafts = new ReviewDraftController(
    sessions,
    () => new Date().toISOString() as never,
  );
  const reviewWorkbench = new ReviewWorkbenchController(
    profiles,
    sessions,
    github,
    paths,
    () => new Date().toISOString() as never,
    {
      github,
      worktrees: new ReviewWorktreeService(paths, readOnlyGit),
      context: new ReviewContextService(),
    },
    new ReviewComparisonService(
      paths,
      readOnlyGit,
      () => new Date().toISOString() as never,
    ),
  );
  const reviewCompletion = new ReviewCompletionService(
    paths,
    () => new Date().toISOString() as never,
  );
  const workflowStarter =
    configuration.workflowInvoker === undefined
      ? undefined
      : new ReviewWorkflowStarter(sessions, configuration.workflowInvoker);
  const modelCatalog: PiRuntimeModelCatalog = configuration.modelCatalog ?? {
    async get() {
      const models = (configuration.supportedReviewModels ?? [])
        .filter((id) => id.length > 0)
        .map((id) => ({ id, label: id }));
      return models.length === 0
        ? err({ _tag: "PiRuntimeModelCatalogUnavailable" as const })
        : ok({ models, ...(models[0] === undefined ? {} : { defaultModel: models[0].id }) });
    },
  };
  const reviewExecution = new ReviewExecutionService(
    sessions,
    paths,
    modelCatalog,
    () => new Date().toISOString() as never,
    new ReviewHeadVerifier(profiles, sessions, github, () => new Date().toISOString()),
  );
  const runCoordinator =
    workflowStarter === undefined
      ? undefined
      : new ReviewRunCoordinator(workflowStarter, runs);
  const merger =
    configuration.mergeWriter ??
    (isGitHubMergeWriter(github) ? github : undefined);
  const mergeWrites =
    merger === undefined
      ? undefined
      : new MergeWriteController(
          profiles,
          sessions,
          {
            getPullRequest: github.getPullRequest.bind(github),
            getPullRequestChecks: github.getPullRequestChecks.bind(github),
            mergePullRequest: merger.mergePullRequest.bind(merger),
          },
          ["squash", "merge", "rebase"],
          () => new Date().toISOString() as never,
        );
  app.get("/v1/profiles", async (context) =>
    response(context, await dashboard.listProfiles()),
  );
  app.post("/v1/profiles", async (context) =>
    response(context, await dashboard.saveProfile(await jsonBody(context))),
  );
  app.put("/v1/profiles", async (context) =>
    response(context, await dashboard.saveProfile(await jsonBody(context))),
  );
  app.post("/v1/profiles/select", async (context) =>
    response(
      context,
      await dashboard.selectProfile(field(await jsonBody(context), "id")),
    ),
  );
  app.get("/v1/dashboard", async (context) =>
    response(context, await dashboard.dashboardForActiveProfile()),
  );
  app.post("/v1/dashboard/refresh/repository", async (context) =>
    response(
      context,
      await dashboard.refreshWatchlistRepo(await jsonBody(context)),
    ),
  );
  app.get("/v1/inbox", async (context) =>
    response(context, await dashboard.inboxForActiveProfile()),
  );
  app.post("/v1/watchlist", async (context) =>
    response(
      context,
      await dashboard.addWatchlistRepo(await jsonBody(context)),
    ),
  );
  app.patch("/v1/watchlist/path", async (context) =>
    response(context, await dashboard.setLocalPath(await jsonBody(context))),
  );
  app.delete("/v1/watchlist", async (context) =>
    response(
      context,
      await dashboard.removeWatchlistRepo(await jsonBody(context)),
    ),
  );
  app.patch("/v1/watchlist/archive", async (context) =>
    response(
      context,
      await dashboard.archiveWatchlistRepo(await jsonBody(context)),
    ),
  );
  app.get("/v1/watchlist/suggestions", async (context) =>
    response(context, await dashboard.discoverWorkspaceRepos()),
  );
  app.post("/v1/github/access", async (context) =>
    response(context, await dashboard.testGitHubAccess()),
  );
  app.get("/v1/environment", async (context) => {
    const [git, gh, ghAuth] = await Promise.all([
      commands.runText({ argv: ["git", "--version"], timeoutMs: 5_000 }),
      commands.runText({ argv: ["gh", "--version"], timeoutMs: 5_000 }),
      commands.runText({ argv: ["gh", "auth", "status"], timeoutMs: 10_000 }),
    ]);
    return context.json({
      ...(parsedConfiguration.output.appMetadata ?? {
        productName: "Patchdesk",
        version: "development",
        architecture: process.arch,
        distribution: "development" as const,
      }),
      git: git._tag === "ok" ? "ready" : "missing",
      gh: gh._tag === "ok" ? "ready" : "missing",
      githubAuth:
        ghAuth._tag === "ok"
          ? "ready"
          : ghAuth.error._tag === "CommandAuthenticationRequired"
            ? "authentication_required"
            : "unavailable",
      runtime: "bundled",
      modelConfiguration: modelConfigurationState(),
    });
  });
  app.post("/v1/direct-entry/preview", async (context) => {
    const body = await jsonBody(context);
    return body === undefined
      ? context.json({ error: "invalid_input" }, 400)
      : response(context, await dashboard.previewDirectEntry(body));
  });
  app.post("/v1/runs/review-pr", async (context) => {
    if (
      workflowStarter === undefined &&
      configuration.runProjection === undefined
    ) {
      return context.json({ error: "workflow_unavailable" }, 503);
    }
    const body = await jsonBody(context);
    const parsed = safeParse(
      object({
        profileId: pipe(string(), minLength(1)),
        sessionId: pipe(string(), minLength(1)),
        attemptId: pipe(string(), minLength(1)),
      }),
      body,
    );
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const run =
      runCoordinator?.start(parsed.output) ?? runs.create(parsed.output);
    return context.json(run, 202);
  });
  app.get("/v1/reviews/models", async (context) => {
    const catalog = await modelCatalog.get();
    if (catalog._tag === "err") return context.json({ error: "catalog_unavailable" }, 503);
    return context.json({
      models: catalog.value.models,
      reasoning: REVIEW_REASONING_LEVELS,
      defaultModel: catalog.value.defaultModel,
      defaultReasoning: "medium",
    });
  });
  app.post("/v1/reviews/run", async (context) => {
    if (runCoordinator === undefined) {
      return context.json({ error: "workflow_unavailable" }, 503);
    }
    const body = await jsonBody(context);
    const started = await reviewExecution.start(body);
    if (started._tag === "err") {
      const status = started.error.reason === "not_found" || started.error.reason === "profile_not_found"
        ? 404
        : started.error.reason === "head_changed"
          ? 409
          : started.error.reason === "github_read" || started.error.reason === "storage" || started.error.reason === "catalog_unavailable"
            ? 503
            : 400;
      return context.json({ error: started.error.reason }, status);
    }
    const run = runCoordinator.start(started.value);
    return context.json({
      runId: run.runId,
      attemptId: started.value.attemptId,
      model: started.value.model,
      reasoning: started.value.reasoning,
    }, 202);
  });
  app.post("/v1/reviews/pending", async (context) =>
    reviewWrites === undefined
      ? context.json({ error: "review_write_unavailable" }, 503)
      : response(
          context,
          await reviewWrites.createPending(await jsonBody(context)),
        ),
  );
  app.post("/v1/reviews/submit", async (context) =>
    reviewWrites === undefined
      ? context.json({ error: "review_write_unavailable" }, 503)
      : response(
          context,
          await reviewWrites.submitPending(await jsonBody(context)),
        ),
  );
  app.post("/v1/reviews/open", async (context) =>
    response(context, await reviewWorkbench.open(await jsonBody(context))),
  );
  app.get("/v1/reviews", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    if (profileId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const listed = await new ReviewSessionStore(paths).listSessions(
      profileId.value,
    );
    if (listed._tag === "err") return context.json({ error: "storage" }, 500);
    return context.json({
      sessions: listed.value.map((session) => ({
        id: session.id,
        profileId: session.key.profileId,
        owner: session.key.owner,
        repo: session.key.repo,
        prNumber: session.key.prNumber,
        title: session.prContext?.title,
        state: session.state._tag,
        draftState: session.draftContent?.state._tag,
        updatedAt: session.updatedAt,
      })),
    });
  });
  app.post("/v1/reviews/load", async (context) =>
    response(context, await reviewWorkbench.load(await jsonBody(context))),
  );
  app.post("/v1/reviews/draft", async (context) =>
    response(context, await reviewDrafts.update(await jsonBody(context))),
  );
  app.post("/v1/reviews/complete", async (context) =>
    response(context, await reviewCompletion.complete(await jsonBody(context))),
  );
  app.post("/v1/reviews/merge", async (context) =>
    mergeWrites === undefined
      ? context.json({ error: "merge_unavailable" }, 503)
      : response(context, await mergeWrites.merge(await jsonBody(context))),
  );
  app.get("/v1/runs/:runId", (context) => {
    const sessionId = context.req.query("sessionId");
    const attemptId = context.req.query("attemptId");
    if (sessionId === undefined || attemptId === undefined)
      return context.json({ error: "run_not_owned" }, 403);
    const owner = { runId: context.req.param("runId"), sessionId, attemptId };
    const observed = runCoordinator?.observe(owner);
    const run = runs.get(owner.runId, owner);
    if (run._tag === "err" || observed?._tag === "err")
      return context.json({ error: "run_not_owned" }, 403);
    const projected = projectSafeRun(
      configuration.runProjection?.({
        runId: run.value.runId,
        sessionId,
        attemptId,
      }) ?? (observed?._tag === "ok" ? observed.value : run.value.projection),
    );
    return projected._tag === "ok"
      ? context.json(projected.value)
      : context.json({ error: "invalid_run" }, 500);
  });

  const { server, port } = await listenOnLoopback(app);
  const url = new URL(`http://${localhostHostname}:${port}/`);

  return {
    _tag: "started",
    server: {
      capability: parsedConfiguration.output.capability,
      url,
      async stop(): Promise<void> {
        await closeServer(server);
      },
    },
  };
}

function corsForRenderer(
  configuration: LocalApiConfiguration,
): MiddlewareHandler {
  return async (context, next) => {
    const origin = context.req.header("Origin");
    if (isAllowedOrigin(configuration, origin)) {
      context.header("Access-Control-Allow-Origin", origin);
      context.header("Vary", "Origin");
      context.header(
        "Access-Control-Allow-Headers",
        `Content-Type, ${APP_CAPABILITY_HEADER}`,
      );
      context.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
    }
    if (context.req.method === "OPTIONS") return context.body(null, 204);
    await next();
  };
}

async function jsonBody(context: Context): Promise<unknown> {
  const maximumBytes = 1024 * 1024;
  const declaredLength = Number(context.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
    return undefined;
  const stream = context.req.raw.body;
  if (stream === null) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined)) as unknown;
  } catch {
    return undefined;
  }
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function modelConfigurationState(): "configured" | "missing" {
  return [
    "OPENAI_API_KEY",
    "OPENCODE_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
  ].some(
    (name) =>
      typeof process.env[name] === "string" && process.env[name]?.length !== 0,
  )
    ? "configured"
    : "missing";
}

function isGitHubReviewWriter(value: unknown): value is GitHubReviewWriter {
  return (
    typeof value === "object" &&
    value !== null &&
    "createPendingReview" in value &&
    "submitPendingReview" in value
  );
}
function isGitHubMergeWriter(value: unknown): value is GitHubMergeWriter {
  return (
    typeof value === "object" && value !== null && "mergePullRequest" in value
  );
}

function response(
  context: Context,
  result:
    | { readonly _tag: "ok"; readonly value: unknown }
    | { readonly _tag: "err"; readonly error: { readonly reason: string } },
): Response {
  return result._tag === "ok"
    ? context.json(result.value)
    : context.json(
        { error: result.error.reason },
        statusForReason(result.error.reason),
      );
}

function statusForReason(
  reason: string,
): 400 | 401 | 404 | 409 | 422 | 500 | 502 | 503 {
  if (reason === "not_found" || reason.endsWith("_not_found")) return 404;
  if (reason.includes("auth")) return 401;
  if (
    reason === "revision_conflict" ||
    reason === "stale_head" ||
    reason.endsWith("_in_progress")
  )
    return 409;
  if (reason === "github_rejected") return 422;
  if (reason.includes("ambiguous")) return 502;
  if (reason.includes("storage")) return 500;
  if (reason.includes("unavailable")) return 503;
  return 400;
}

/** Checks the health route through the same capability boundary used by preload callers. */
export async function healthCheckLocalApi(
  server: Pick<LocalApiServer, "capability" | "url">,
  allowedOrigin: string,
): Promise<boolean> {
  const response = await fetch(new URL("health", server.url), {
    headers: {
      [APP_CAPABILITY_HEADER]: server.capability,
      Origin: allowedOrigin,
    },
  });

  return response.status === 200;
}

function requireLocalApiAccess(
  configuration: LocalApiConfiguration,
): MiddlewareHandler {
  return async (context, next) => {
    const capability = context.req.header(APP_CAPABILITY_HEADER);
    if (capability === undefined) {
      return context.json({ error: "Missing local API capability" }, 401);
    }

    if (!hasMatchingAppCapability(configuration.capability, capability)) {
      return context.json({ error: "Invalid local API capability" }, 403);
    }

    const origin = context.req.header("Origin");
    const fetchMode = context.req.header("Sec-Fetch-Mode");
    if (!isAllowedOrigin(configuration, origin) || fetchMode === "navigate") {
      return context.json({ error: "Origin is not allowed" }, 403);
    }

    await next();
  };
}

function isAllowedOrigin(
  configuration: LocalApiConfiguration,
  origin: string | undefined,
): boolean {
  return (
    origin === configuration.allowedOrigin ||
    origin === configuration.developmentOrigin
  );
}

async function listenOnLoopback(
  app: Hono,
): Promise<{ readonly port: number; readonly server: ServerType }> {
  return await new Promise((resolve, reject) => {
    const rejectListen = (cause: Error): void => {
      reject(cause);
    };
    const server: ServerType = serve(
      {
        fetch: app.fetch,
        hostname: localhostHostname,
        port: 0,
      },
      (address) => {
        server.off("error", rejectListen);
        resolve({ port: address.port, server });
      },
    );
    server.once("error", rejectListen);
  });
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) {
        resolve();
        return;
      }

      reject(cause);
    });
  });
}
