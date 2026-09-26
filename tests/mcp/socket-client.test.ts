import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { callPatchdeskApp } from "../../src/mcp/socket-client";
import {
  mcpSocketBounds,
  resolveMcpSocketPath,
} from "../../src/mcp/socket-protocol";
import { shortTemporaryDirectory } from "../main/mcp-app-fixture";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A stand-in for the app that answers every connection with `behave`. */
async function misbehavingApp(
  behave: (socket: Socket) => void,
): Promise<string> {
  const root = await shortTemporaryDirectory();
  const socketPath = join(root, "app.sock");
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    behave(socket);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return socketPath;
}

const request = { tool: "list_repositories", arguments: {} };
const shortBounds = { ...mcpSocketBounds, timeoutMs: 50, maxReplyBytes: 64 };

describe("callPatchdeskApp", () => {
  it.each([
    { case: "never answers", behave: () => {}, timeoutMs: 50 },
    {
      case: "closes without a reply",
      timeoutMs: mcpSocketBounds.timeoutMs,
      behave: (socket: Socket) => socket.end(),
    },
    {
      case: "answers with a malformed line",
      timeoutMs: mcpSocketBounds.timeoutMs,
      behave: (socket: Socket) => socket.end("not json\n"),
    },
    {
      case: "answers with a line that is not a reply",
      timeoutMs: mcpSocketBounds.timeoutMs,
      behave: (socket: Socket) => socket.end('{"ok":"maybe"}\n'),
    },
  ])(
    "gives app_not_responding when the app $case",
    async ({ behave, timeoutMs }) => {
      const socketPath = await misbehavingApp(behave);

      const call = await callPatchdeskApp(socketPath, request, {
        ...shortBounds,
        timeoutMs,
      });

      expect(call.reply).toMatchObject({
        ok: false,
        error: "app_not_responding",
      });
    },
  );

  it("gives too_large for a reply over the bound", async () => {
    const socketPath = await misbehavingApp((socket) =>
      socket.end(
        `${JSON.stringify({ ok: true, result: { pad: "x".repeat(100) } })}\n`,
      ),
    );

    const call = await callPatchdeskApp(socketPath, request, shortBounds);

    expect(call.reply).toMatchObject({ ok: false, error: "too_large" });
  });
});

describe("resolveMcpSocketPath", () => {
  const paths = PatchdeskPaths.forTest("/data-root");

  it.each([
    {
      override: "/tmp/patchdesk-dev.sock",
      expected: "/tmp/patchdesk-dev.sock",
    },
    { override: "patchdesk-dev.sock", expected: paths.mcpSocketFile() },
    { override: "", expected: paths.mcpSocketFile() },
    { override: undefined, expected: paths.mcpSocketFile() },
  ])(
    "uses $expected for PATCHDESK_MCP_SOCKET=$override",
    ({ override, expected }) => {
      expect(resolveMcpSocketPath(override, paths)).toBe(expected);
    },
  );
});
