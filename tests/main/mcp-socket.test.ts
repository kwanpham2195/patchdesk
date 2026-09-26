import { spawn } from "node:child_process";
import { access, chmod, mkdir, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { err, ok } from "../../src/domain/result";
import { parseWorkspaceProfileId } from "../../src/domain/ids";
import type { LogEntryInput } from "../../src/domain/log-entry";
import {
  startMcpSocketListener,
  type McpSocketListener,
} from "../../src/main/mcp/mcp-socket-listener";
import {
  createMcpToolTable,
  type McpToolReply,
  type McpToolTable,
} from "../../src/main/mcp/mcp-tool-dispatcher";
import {
  mcpSocketBounds,
  type McpSocketBounds,
} from "../../src/mcp/socket-protocol";
import {
  mcpToolManifest,
  mcpToolNames,
  type McpToolName,
} from "../../src/mcp/tool-manifest";
import {
  exchangeSocketLine,
  shortTemporaryDirectory,
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "./mcp-app-fixture";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const listRepositoriesLine = `${JSON.stringify({ tool: "list_repositories", arguments: {} })}\n`;

/** A tool table whose tools record each call and answer with `reply`. */
function recordingTools(reply: McpToolReply = emptyListing()) {
  const calls: Array<string> = [];
  const record = (name: McpToolName) => async () => {
    calls.push(name);
    return reply;
  };
  const tools: McpToolTable = {
    list_repositories: {
      schema: mcpToolManifest.list_repositories.inputSchema,
      call: record("list_repositories"),
    },
    review_local: {
      schema: mcpToolManifest.review_local.inputSchema,
      call: record("review_local"),
    },
    get_insight: {
      schema: mcpToolManifest.get_insight.inputSchema,
      call: record("get_insight"),
    },
    get_feedback: {
      schema: mcpToolManifest.get_feedback.inputSchema,
      call: record("get_feedback"),
    },
  };
  return { calls, tools };
}

function emptyListing(label = "ACME"): McpToolReply {
  const id = parseWorkspaceProfileId("acme");
  if (id._tag === "err") throw new Error("Invalid profile fixture");
  return ok({ profile: { id: id.value, label }, repositories: [] });
}

async function startListener(
  socketPath: string,
  tools: McpToolTable,
  logs: Array<LogEntryInput> = [],
  bounds: McpSocketBounds = mcpSocketBounds,
): Promise<McpSocketListener> {
  const listener = startMcpSocketListener({
    socketPath: async () => socketPath,
    tools,
    logs: { write: (entry) => logs.push(entry) },
    bounds,
  });
  cleanups.push(() => listener.stop());
  return listener;
}

async function socketDirectory(): Promise<string> {
  const root = await shortTemporaryDirectory();
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return join(root, "mcp");
}

/** Leaves a socket file with no listener behind, as a crashed app does. */
async function leaveStaleSocket(socketPath: string): Promise<void> {
  const child = spawn(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, "SIGKILL"))`,
  ]);
  await new Promise((resolve) => child.once("exit", resolve));
}

describe("MCP socket listener (ADR 0052)", () => {
  it("creates its directory 0700 and the socket 0600", async () => {
    const directory = await socketDirectory();
    const socketPath = join(directory, "patchdesk.sock");

    const listener = await startListener(socketPath, recordingTools().tools);

    expect(await listener.listening).toBe("listening");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it("removes a socket a crashed instance left and answers on it", async () => {
    const directory = await socketDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const socketPath = join(directory, "patchdesk.sock");
    await leaveStaleSocket(socketPath);
    const logs: Array<LogEntryInput> = [];

    const listener = await startListener(
      socketPath,
      recordingTools().tools,
      logs,
    );

    expect(await listener.listening).toBe("listening");
    expect(
      JSON.parse(await exchangeSocketLine(socketPath, listRepositoriesLine)),
    ).toMatchObject({ ok: true });
    expect(logs.map((entry) => entry.message)).toContain(
      "stale socket removed",
    );
  });

  it("leaves a live instance's socket alone", async () => {
    const socketPath = join(await socketDirectory(), "patchdesk.sock");
    const first = recordingTools(emptyListing("first"));
    await (
      await startListener(socketPath, first.tools)
    ).listening;

    const second = await startListener(
      socketPath,
      recordingTools(emptyListing("second")).tools,
    );

    expect(await second.listening).toBe("in_use");
    await second.stop();
    expect(
      JSON.parse(await exchangeSocketLine(socketPath, listRepositoriesLine)),
    ).toMatchObject({
      ok: true,
      result: { profile: { label: "first" } },
    });
  });

  it("refuses a request line over 256 KiB as too_large without calling the tool", async () => {
    const socketPath = join(await socketDirectory(), "patchdesk.sock");
    const recording = recordingTools();
    await (
      await startListener(socketPath, recording.tools)
    ).listening;
    const oversized = `${JSON.stringify({
      tool: "list_repositories",
      arguments: { padding: "x".repeat(mcpSocketBounds.maxRequestBytes) },
    })}\n`;

    const reply = JSON.parse(await exchangeSocketLine(socketPath, oversized));

    expect(reply).toMatchObject({ ok: false, error: "too_large" });
    expect(recording.calls).toEqual([]);
  });

  it("replaces a reply over 4 MiB with too_large", async () => {
    const socketPath = join(await socketDirectory(), "patchdesk.sock");
    const huge = emptyListing("x".repeat(mcpSocketBounds.maxReplyBytes));
    await (
      await startListener(socketPath, recordingTools(huge).tools)
    ).listening;

    const reply = JSON.parse(
      await exchangeSocketLine(socketPath, listRepositoriesLine),
    );

    expect(reply).toMatchObject({ ok: false, error: "too_large" });
  });

  it("closes a connection that sends no line within the timeout", async () => {
    const socketPath = join(await socketDirectory(), "patchdesk.sock");
    await (
      await startListener(socketPath, recordingTools().tools, [], {
        ...mcpSocketBounds,
        timeoutMs: 50,
      })
    ).listening;

    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(socketPath);
      socket.on("close", () => resolve(true));
      socket.on("error", () => resolve(false));
    });

    expect(closed).toBe(true);
  });

  it("refuses to listen in an existing directory group or others can open", async () => {
    const directory = await socketDirectory();
    await mkdir(directory);
    await chmod(directory, 0o755);
    const socketPath = join(directory, "patchdesk.sock");

    const listener = await startListener(socketPath, recordingTools().tools);

    expect(await listener.listening).toBe("failed");
    await expect(access(socketPath)).rejects.toThrow();
  });

  it("answers storage when the tool's result cannot be serialized", async () => {
    const socketPath = join(await socketDirectory(), "patchdesk.sock");
    const id = parseWorkspaceProfileId("acme");
    if (id._tag === "err") throw new Error("Invalid profile fixture");
    const unserializable = ok({
      profile: {
        id: id.value,
        get label(): string {
          throw new Error("unserializable");
        },
      },
      repositories: [],
    });
    await (
      await startListener(socketPath, recordingTools(unserializable).tools)
    ).listening;

    const reply = JSON.parse(
      await exchangeSocketLine(socketPath, listRepositoriesLine),
    );

    expect(reply).toMatchObject({ ok: false, error: "storage" });
  });

  it("answers an unknown tool with invalid_input and calls nothing", async () => {
    const socketPath = join(await socketDirectory(), "patchdesk.sock");
    const recording = recordingTools();
    await (
      await startListener(socketPath, recording.tools)
    ).listening;

    const reply = JSON.parse(
      await exchangeSocketLine(
        socketPath,
        `${JSON.stringify({ tool: "apply_suggestions", arguments: {} })}\n`,
      ),
    );

    expect(reply).toMatchObject({ ok: false, error: "invalid_input" });
    expect(recording.calls).toEqual([]);
  });
});

describe("MCP tool dispatcher", () => {
  let app: McpAppFixture | undefined;

  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  it("names exactly the tools the shim's manifest registers", () => {
    const unavailable = async () => err({ reason: "storage" as const });
    const unreadable = async () =>
      err({
        _tag: "StorageFailure" as const,
        operation: "read" as const,
        reason: "io" as const,
      });
    const table = createMcpToolTable({
      dashboard: { savedProfiles: unavailable },
      localReviewOpening: {
        listCheckouts: unavailable,
        findCheckout: unavailable,
        open: unavailable,
      },
      localChangeIntent: { recordAgentIntent: unavailable },
      localDrafts: { feedback: unavailable },
      reviewWorkbench: { load: unavailable },
      sessions: { load: unreadable },
      reviews: { load: unreadable },
    });

    expect(Object.keys(table).sort()).toEqual([...mcpToolNames].sort());
  });

  it("lists the active profile's local repositories with each live checkout and its branch", async () => {
    app = await startAppWithLinkedWorktree();

    const reply = JSON.parse(
      await exchangeSocketLine(app.socketPath, listRepositoriesLine),
    );

    expect(reply).toEqual({
      ok: true,
      result: {
        profile: { id: "acme", label: "ACME" },
        repositories: [
          {
            host: "github.com",
            owner: "octo-org",
            repo: "patchdesk",
            localPath: app.repositoryPath,
            checkouts: [
              {
                path: app.repositoryPath,
                name: "repo",
                head: { kind: "branch", branch: "main" },
                configured: true,
              },
              {
                path: app.linkedPath,
                name: "linked",
                head: { kind: "branch", branch: "feat/linked" },
                configured: false,
              },
            ],
          },
        ],
      },
    });
    expect(reply.result.repositories[0].checkouts).toEqual(
      JSON.parse(await app.routeCheckouts()),
    );
  });
});
