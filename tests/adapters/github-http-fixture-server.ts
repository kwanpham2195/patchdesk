import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

import type { CommandFailure } from "../../src/adapters/github/command-runner";
import {
  GitHubHttpClient,
  type GitHubApiOrigin,
  type GitHubRateLimitObservation,
} from "../../src/adapters/github/github-http-client";
import {
  parseWorkspaceProfileConfig,
  type WorkspaceProfileConfig,
} from "../../src/domain/workspace-profile";
import { StubCredentials } from "./stub-github-credentials";

/**
 * A real HTTP server on loopback for the `GitHubHttpClient` suites, rather
 * than a replaced `fetch`: what ADR 0046 moved into this app is the request
 * and response handling itself, so a double that skips it would prove nothing
 * about status classification, the body cap, or cancellation.
 */

export type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

export type RecordedRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
  readonly socket: Socket;
};

export type FixtureServer = {
  /** The origins a client under test is pointed at. */
  origin(): GitHubApiOrigin;
  /** Answer the next requests with this handler; an unset handler answers `{}`. */
  respondWith(handler: Handler): void;
  requests(): ReadonlyArray<RecordedRequest>;
  client(
    credentials?: StubCredentials,
    onRateLimit?: (observation: GitHubRateLimitObservation) => void,
  ): GitHubHttpClient;
};

const profileResult = parseWorkspaceProfileConfig({
  id: "acme",
  label: "ACME",
  githubHost: "github.com",
  ghAccount: "octo-dev",
  workspaceRoots: [],
  rulePaths: [],
  repos: [],
});
if (profileResult._tag === "err") throw new Error("Malformed test profile");

export const profile: WorkspaceProfileConfig = profileResult.value;

/** The port a fixture server bound; these always listen on TCP, never a pipe. */
export function portOf(listening: Server): number {
  const address = listening.address() as AddressInfo | null;
  if (address === null) throw new Error("Fixture server has no port");
  return address.port;
}

/** Respond with a JSON body, the shape most GitHub endpoints answer with. */
export function json<TBody>(
  status: number,
  body: TBody,
  headers: Record<string, string> = {},
): Handler {
  return (_request, response) => {
    response.writeHead(status, {
      "Content-Type": "application/json",
      ...headers,
    });
    response.end(JSON.stringify(body));
  };
}

export function errorOf(
  result:
    | { readonly _tag: "ok" }
    | { readonly _tag: "err"; readonly error: CommandFailure },
): CommandFailure {
  if (result._tag === "ok") throw new Error("Expected a failed result");
  return result.error;
}

/** Registers one fixture server's lifecycle around the calling suite. */
export function useFixtureServer(): FixtureServer {
  let server: Server;
  let origin: GitHubApiOrigin;
  let handler: Handler;
  let requests: Array<RecordedRequest> = [];
  let openSockets: Array<Socket> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          socket: request.socket,
        });
        handler(request, response);
      });
    });
    server.on("connection", (socket: Socket) => openSockets.push(socket));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = portOf(server);
    origin = {
      rest: `http://127.0.0.1:${port}`,
      graphql: `http://127.0.0.1:${port}/graphql`,
    };
  });

  afterAll(async () => {
    for (const socket of openSockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    requests = [];
    openSockets = [];
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  return {
    origin: () => origin,
    respondWith: (next) => {
      handler = next;
    },
    requests: () => requests,
    client: (
      credentials = new StubCredentials(),
      onRateLimit = () => undefined,
    ) => new GitHubHttpClient(credentials, onRateLimit, () => origin),
  };
}
