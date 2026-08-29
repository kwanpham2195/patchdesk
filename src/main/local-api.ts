import { serve, type ServerType } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";

import { APP_CAPABILITY_HEADER, type AppCapability } from "./ipc-contract";
import { hasMatchingAppCapability } from "./app-capability";
import type { LocalApiStartupResult } from "./app-lifecycle";
import { buildLocalApiContainer, type LogWriter } from "./local-api-container";
import type { LocalApiConfiguration } from "./local-api-configuration";
import { startRetentionSweepScheduler } from "./retention-sweep-scheduler";
import { registerDashboardRoutes } from "./routes/dashboard-routes";
import { registerInsightRoutes } from "./routes/insight-routes";
import { registerPendingReviewRoutes } from "./routes/pending-review-routes";
import { registerPublishedFeedbackRoutes } from "./routes/published-feedback-routes";
import { registerReviewLifecycleRoutes } from "./routes/review-lifecycle-routes";
import { registerReviewWriteRoutes } from "./routes/review-write-routes";
import { registerStorageDiagnosticsRoutes } from "./routes/storage-diagnostics-routes";

export { createReadOnlyGitExecutor } from "./local-api-stores";

const localhostHostname = "127.0.0.1";

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
  const built = await buildLocalApiContainer(configuration);
  if (built._tag !== "ok") return built;
  const container = built.container;
  const { logs, parsedConfiguration } = container;

  const app = new Hono();
  app.use("*", corsForRenderer(parsedConfiguration.output));
  app.use("*", requireLocalApiAccess(parsedConfiguration.output));
  app.use("*", logLocalApiRequests(logs));
  app.get("/health", (context) => context.json({ status: "ok" }));

  registerDashboardRoutes(app, container);
  registerReviewWriteRoutes(app, container);
  registerPendingReviewRoutes(app, container);
  registerPublishedFeedbackRoutes(app, container);
  registerReviewLifecycleRoutes(app, container);
  registerInsightRoutes(app, container);
  registerStorageDiagnosticsRoutes(app, container);

  const { server, port } = await listenOnLoopback(app);
  const url = new URL(`http://${localhostHostname}:${port}/`);

  const retentionScheduler = startRetentionSweepScheduler({
    profiles: container.configuredProfiles,
    storageManagement: container.storageManagement,
    enabled: configuration.retentionSweep ?? false,
    diagnostics: container.diagnostics,
  });

  return {
    _tag: "started",
    server: {
      capability: parsedConfiguration.output.capability,
      url,
      async stop(): Promise<void> {
        await retentionScheduler.stop();
        await closeServer(server);
      },
    },
  };
}

/** Logs every authenticated loopback request; the log endpoints and health never log themselves. */
function logLocalApiRequests(logs: LogWriter): MiddlewareHandler {
  return async (context, next) => {
    const startedAt = performance.now();
    await next();
    const path = context.req.path;
    if (path === "/health" || path === "/v1/logs") return;
    const status = context.res.status;
    const durationMs = Math.round(performance.now() - startedAt);
    const correlationId = context.req.header("x-patchdesk-correlation-id");
    const meta =
      correlationId === undefined
        ? { status, durationMs }
        : { status, durationMs, correlationId };
    // The query string carries the opaque, credential-free pagination
    // token (see the plan's Shared Contract), so it is safe to log; without
    // it every inbox request line reads as a bare `GET /v1/inbox` with no
    // way to see which page was requested.
    const query = new URL(context.req.url).search;
    logs.write({
      process: "main",
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "debug",
      topic: "http",
      message: `${context.req.method} ${path}${query}`,
      meta,
    });
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

/**
 * `server.close()`'s callback only fires once every open connection has
 * ended -- Node never force-closes sockets on its own. A keep-alive client
 * (e.g. the renderer logger's debounced `POST /v1/logs`) can hold a
 * connection open indefinitely, which would otherwise make shutdown hang.
 *
 * `ServerType` is `net.Server | Http2Server | Http2SecureServer`, and only
 * `net.Server`'s `http.Server` subtype declares `closeIdleConnections()` /
 * `closeAllConnections()` (added in Node 18.2). `Http2Server` and
 * `Http2SecureServer` extend `net.Server`/`tls.Server` directly and do not
 * declare them, so they're not callable on `ServerType` as a whole. Narrow
 * with `in` (a real runtime check, not a cast) rather than forcing the type.
 */
async function closeServer(server: ServerType): Promise<void> {
  if ("closeIdleConnections" in server) {
    server.closeIdleConnections();
  }

  const closed = new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) {
        resolve();
        return;
      }

      reject(cause);
    });
  });

  // Give any in-flight request a brief window to finish normally, then force
  // whatever connections remain closed so shutdown is always bounded. 500ms
  // is well under Node's 5s default keepAliveTimeout (the actual cause of
  // the hang) and far more than a same-machine loopback request needs.
  const graceMs = 500;
  const forceClose = setTimeout(() => {
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
  }, graceMs);

  try {
    await closed;
  } finally {
    clearTimeout(forceClose);
  }
}
