import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import {
  startLocalApiServer,
  type LocalApiServer,
} from "../../src/main/local-api";

const capability = "test-capability";
const origin = "http://patchdesk.test";

/**
 * A temporary directory under `/tmp`: a Unix socket path must stay under 104
 * bytes on macOS, which `os.tmpdir()` there nearly uses up by itself.
 */
export async function shortTemporaryDirectory(): Promise<string> {
  return await realpath(await mkdtemp("/tmp/pd-mcp-"));
}

/** Sends one raw line to the socket and resolves with everything the listener wrote back before closing. */
export function exchangeSocketLine(
  socketPath: string,
  line: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const received: Buffer[] = [];
    socket.on("connect", () => socket.write(line));
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(received).toString("utf8")));
  });
}

/** Runs git for fixture setup only; the code under test runs git through the production executor. */
function git(cwd: string, ...args: ReadonlyArray<string>): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd },
  );
}

export type McpAppFixture = {
  readonly socketPath: string;
  readonly repositoryPath: string;
  readonly linkedPath: string;
  readonly paths: PatchdeskPaths;
  /** What `GET /v1/reviews/local-checkouts` answers for the local repository. */
  routeCheckouts(): Promise<string>;
  /** One local API call, as the renderer makes it; `json` is the request body and the answer is parsed JSON. */
  route(
    path: string,
    json?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  stop(): Promise<void>;
};

/**
 * The local API with its MCP socket on a profile that has one local
 * repository, checked out on `main` with a linked worktree on
 * `feat/linked`, and one repository with no `localPath`. `profiles: "none"`
 * saves no profile; `"two"` adds an `other` profile with the same repository.
 */
export async function startAppWithLinkedWorktree(
  options: { readonly profiles?: "none" | "one" | "two" } = {},
): Promise<McpAppFixture> {
  const root = await shortTemporaryDirectory();
  const repositoryPath = join(root, "repo");
  const linkedPath = join(root, "linked");
  execFileSync("git", ["init", "-q", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "tracked.txt"), "one\n");
  git(repositoryPath, "add", "tracked.txt");
  git(repositoryPath, "commit", "-q", "-m", "root");
  git(repositoryPath, "worktree", "add", "-q", "-b", "feat/linked", linkedPath);
  const paths = PatchdeskPaths.forTest(join(root, "app"));
  const profile = parseWorkspaceProfileConfig({
    id: "acme",
    label: "ACME",
    githubHost: "github.com",
    ghAccount: "fixture",
    workspaceRoots: [],
    rulePaths: [],
    repos: [
      {
        host: "github.com",
        owner: "octo-org",
        repo: "patchdesk",
        localPath: repositoryPath,
      },
      { host: "github.com", owner: "octo-org", repo: "remote-only" },
    ],
  });
  if (profile._tag === "err") throw new Error("Invalid profile fixture");
  const profiles = options.profiles ?? "one";
  if (profiles !== "none") await new ProfileStore(paths).save(profile.value);
  if (profiles === "two")
    await new ProfileStore(paths).save({
      ...profile.value,
      id: "other",
      label: "Other",
    });
  const socketPath = join(root, "app", "mcp", "patchdesk.sock");
  const started = await startLocalApiServer({
    capability,
    allowedOrigin: origin,
    paths,
    mcpSocketPath: async () => socketPath,
  });
  if (started._tag !== "started") throw new Error("local API did not start");
  const server: LocalApiServer = started.server;
  if ((await server.mcpSocket) !== "listening")
    throw new Error("MCP socket did not bind");
  return {
    socketPath,
    repositoryPath,
    linkedPath,
    async routeCheckouts() {
      const query = new URLSearchParams({
        profileId: "acme",
        host: "github.com",
        owner: "octo-org",
        repo: "patchdesk",
      });
      const response = await fetch(
        new URL(`v1/reviews/local-checkouts?${query.toString()}`, server.url),
        { headers: { Origin: origin, "X-Patchdesk-Capability": capability } },
      );
      return await response.text();
    },
    paths,
    async route(path, json) {
      const headers = new Headers({
        Origin: origin,
        "X-Patchdesk-Capability": capability,
      });
      if (json !== undefined) headers.set("Content-Type", "application/json");
      const response = await fetch(new URL(path, server.url), {
        method: json === undefined ? "GET" : "POST",
        headers,
        body: json ?? null,
      });
      return { status: response.status, body: await response.json() };
    },
    async stop() {
      await server.stop();
      // The app's log appends are not flushed by `stop`; one landing mid-removal fails it with ENOTEMPTY, so rm retries.
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    },
  };
}
