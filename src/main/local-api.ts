import { serve, type ServerType } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { safeParse, minLength, object, pipe, string } from "valibot";

import {
  APP_CAPABILITY_HEADER,
  hasMatchingAppCapability,
  type AppCapability,
} from "./ipc-contract";

const localApiConfigurationSchema = object({
  allowedOrigin: pipe(string(), minLength(1)),
  capability: pipe(string(), minLength(1)),
});

const localhostHostname = "127.0.0.1";

/** Configuration required to bind the authenticated loopback API. */
export type LocalApiConfiguration = {
  readonly allowedOrigin: string;
  readonly capability: AppCapability;
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
): Promise<LocalApiServer> {
  const parsedConfiguration = safeParse(
    localApiConfigurationSchema,
    configuration,
  );
  if (!parsedConfiguration.success) {
    throw new Error("Invalid local API configuration");
  }

  const app = new Hono();
  app.use("*", requireLocalApiAccess(parsedConfiguration.output));
  app.get("/health", (context) => context.json({ status: "ok" }));

  const { server, port } = await listenOnLoopback(app);
  const url = new URL(`http://${localhostHostname}:${port}/`);

  return {
    capability: parsedConfiguration.output.capability,
    url,
    async stop(): Promise<void> {
      await closeServer(server);
    },
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
    const fetchSite = context.req.header("Sec-Fetch-Site");
    const fetchMode = context.req.header("Sec-Fetch-Mode");
    if (
      origin !== configuration.allowedOrigin ||
      fetchSite === "cross-site" ||
      fetchMode === "navigate"
    ) {
      return context.json({ error: "Origin is not allowed" }, 403);
    }

    await next();
  };
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
