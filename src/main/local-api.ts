import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { optional, safeParse, minLength, object, pipe, string } from "valibot";

import {
  APP_CAPABILITY_HEADER,
  hasMatchingAppCapability,
  type AppCapability,
} from "./ipc-contract";
import type { LocalApiStartupResult } from "./app-lifecycle";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ProfileStore } from "../adapters/storage/profile-store";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { GitHubAdapter } from "../adapters/github/github-adapter";
import { CommandRunner } from "../adapters/github/command-runner";
import { WorkspaceOriginFinder } from "../adapters/github/workspace-origin-finder";
import type { GitHubMergeWriter, GitHubReader, GitHubReviewWriter } from "../adapters/github/github-adapter";
import type { OriginFinder } from "../services/dashboard-service";
import { DashboardController } from "../services/dashboard-controller";
import { ReviewWriteController } from "../services/review-write-controller";
import { ReviewWorkbenchController } from "../services/review-workbench-controller";
import { MergeWriteController } from "../services/merge-write-controller";
import { ReviewCompletionService } from "../services/review-completion-service";
import { projectSafeRun } from "../services/run-projection";
import { ReviewRunRegistry } from "../services/review-run-registry";
import { ReviewContextService } from "../services/review-context-service";
import { ReviewWorktreeService } from "../services/review-worktree-service";
import { err, ok } from "../domain/result";
import type { SafeRunProjection } from "../services/run-projection";

const localApiConfigurationSchema = object({
  allowedOrigin: pipe(string(), minLength(1)),
  developmentOrigin: optional(pipe(string(), minLength(1))),
  capability: pipe(string(), minLength(1)),
});

const localhostHostname = "127.0.0.1";

/** Configuration required to bind the authenticated loopback API. */
export type LocalApiConfiguration = {
  readonly allowedOrigin: string;
  /** Vite's fixed renderer origin, accepted only by the unpackaged desktop app. */
  readonly developmentOrigin?: string | undefined;
  readonly capability: AppCapability;
  /** Explicit seams used only by local integration tests; production uses real main-process adapters. */
  readonly github?: GitHubReader;
  /** Test-only write seam. A reader alone must never enable review-write routes. */
  readonly reviewWriter?: GitHubReviewWriter;
  /** Test-only merge seam. Production gets this capability from the main-process adapter. */
  readonly mergeWriter?: GitHubMergeWriter;
  readonly origins?: OriginFinder;
  readonly paths?: PatchdeskPaths;
  /** Test-only adapter; production never accepts mutable run state over HTTP. */
  readonly runProjection?: (input: { readonly runId: string; readonly sessionId: string; readonly attemptId: string }) => SafeRunProjection;
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
      return output._tag === "ok" ? ok({ stdout: output.value }) : err({ _tag: "GitReadFailed" as const });
    },
  };
  const profiles = new ProfileStore(paths);
  const dashboard = new DashboardController(
    profiles,
    github,
    configuration.origins ?? new WorkspaceOriginFinder(commands),
  );
  const writer = configuration.reviewWriter ?? (isGitHubReviewWriter(github) ? github : undefined);
  const reviewWrites = writer === undefined
    ? undefined
    : new ReviewWriteController(profiles, new ReviewSessionStore(paths), {
        getPullRequest: github.getPullRequest.bind(github),
        createPendingReview: writer.createPendingReview.bind(writer),
        submitPendingReview: writer.submitPendingReview.bind(writer),
      }, () => new Date().toISOString() as never);
  const reviewWorkbench = new ReviewWorkbenchController(
    profiles,
    new ReviewSessionStore(paths),
    github,
    paths,
    () => new Date().toISOString() as never,
    {
      github,
      worktrees: new ReviewWorktreeService(paths, readOnlyGit),
      context: new ReviewContextService(),
    },
  );
  const reviewCompletion = new ReviewCompletionService(paths, () => new Date().toISOString() as never);
  const merger = configuration.mergeWriter ?? (isGitHubMergeWriter(github) ? github : undefined);
  const mergeWrites = merger === undefined ? undefined : new MergeWriteController(profiles, new ReviewSessionStore(paths), { getPullRequest: github.getPullRequest.bind(github), getPullRequestChecks: github.getPullRequestChecks.bind(github), mergePullRequest: merger.mergePullRequest.bind(merger) }, ["squash", "merge", "rebase"], () => new Date().toISOString() as never);
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
  app.post("/v1/dashboard/refresh", async (context) =>
    response(context, await dashboard.dashboardForActiveProfile()),
  );
  app.post("/v1/dashboard/refresh/repository", async (context) =>
    response(
      context,
      await dashboard.refreshWatchlistRepo(await jsonBody(context)),
    ),
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
  app.post("/v1/direct-entry/preview", async (context) => {
    const body = await jsonBody(context);
    return body === undefined
      ? context.json({ error: "invalid_input" }, 400)
      : response(context, await dashboard.previewDirectEntry(body));
  });
  app.post("/v1/runs/review-pr", async (context) => {
    const body = await jsonBody(context);
    const parsed = safeParse(object({ sessionId: pipe(string(), minLength(1)), attemptId: pipe(string(), minLength(1)) }), body);
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    return context.json(runs.create(parsed.output));
  });
  app.post("/v1/reviews/pending", async (context) =>
    reviewWrites === undefined
      ? context.json({ error: "review_write_unavailable" }, 503)
      : response(context, await reviewWrites.createPending(await jsonBody(context))),
  );
  app.post("/v1/reviews/submit", async (context) =>
    reviewWrites === undefined
      ? context.json({ error: "review_write_unavailable" }, 503)
      : response(context, await reviewWrites.submitPending(await jsonBody(context))),
  );
  app.post("/v1/reviews/open", async (context) =>
    response(context, await reviewWorkbench.open(await jsonBody(context))),
  );
  app.post("/v1/reviews/load", async (context) =>
    response(context, await reviewWorkbench.load(await jsonBody(context))),
  );
  app.post("/v1/reviews/complete", async (context) => response(context, await reviewCompletion.complete(await jsonBody(context))));
  app.post("/v1/reviews/merge", async (context) => mergeWrites === undefined ? context.json({ error: "merge_unavailable" }, 503) : response(context, await mergeWrites.merge(await jsonBody(context))));
  app.get("/v1/runs/:runId", (context) => {
    const sessionId = context.req.query("sessionId"); const attemptId = context.req.query("attemptId");
    if (sessionId === undefined || attemptId === undefined) return context.json({ error: "run_not_owned" }, 403);
    const run = runs.get(context.req.param("runId"), { sessionId, attemptId });
    if (run._tag === "err") return context.json({ error: "run_not_owned" }, 403);
    const projected = projectSafeRun(configuration.runProjection?.({ runId: run.value.runId, sessionId, attemptId }) ?? { status: "disconnected", elapsedMs: run.value.projection.elapsedMs, step: "inspecting" });
    return projected._tag === "ok" ? context.json(projected.value) : context.json({ error: "invalid_run" }, 500);
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
  return await context.req.json().catch(() => undefined);
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function isGitHubReviewWriter(value: unknown): value is GitHubReviewWriter {
  return typeof value === "object" && value !== null && "createPendingReview" in value && "submitPendingReview" in value;
}
function isGitHubMergeWriter(value: unknown): value is GitHubMergeWriter { return typeof value === "object" && value !== null && "mergePullRequest" in value; }

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
        result.error.reason === "not_found" ? 404 : 400,
      );
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
    if (
      !isAllowedOrigin(configuration, origin) ||
      fetchMode === "navigate"
    ) {
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
