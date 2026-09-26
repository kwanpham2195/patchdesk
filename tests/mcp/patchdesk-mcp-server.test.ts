import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPatchdeskMcpServer,
  type PatchdeskMcpServerOptions,
} from "../../src/mcp/patchdesk-mcp-server";
import { mcpToolNames } from "../../src/mcp/tool-manifest";
import {
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";

const cleanups: Array<() => Promise<void>> = [];
let app: McpAppFixture | undefined;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await app?.stop();
  app = undefined;
});

function shimOptions(socketPath: string): PatchdeskMcpServerOptions {
  return { socketPath, version: "0.0.0-test", report: () => {}, debug: false };
}

/** The 2025-era opening a client sends by default, served by the same `serveStdio` entry the shim runs. */
async function connectLegacyClient(socketPath: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(
    () => createPatchdeskMcpServer(shimOptions(socketPath)),
    { transport: serverSide },
  );
  const client = new Client({ name: "legacy-test", version: "1.0.0" });
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await served.close();
  });
  return client;
}

/** The 2026-07-28 era, in process: the client's fetch goes straight to the handler (ADR 0052 "Test strategy"). */
async function connectModernClient(socketPath: string): Promise<Client> {
  const handler = createMcpHandler(() =>
    createPatchdeskMcpServer(shimOptions(socketPath)),
  );
  const client = new Client(
    { name: "modern-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://patchdesk.test/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  cleanups.push(async () => {
    await client.close();
    await handler.close();
  });
  return client;
}

describe.each([
  { era: "2025", connect: connectLegacyClient },
  { era: "2026-07-28", connect: connectModernClient },
])("patchdesk mcp on the $era era", ({ era, connect }) => {
  it("lists the manifest's tools and returns list_repositories as the checkout route does", async () => {
    app = await startAppWithLinkedWorktree();
    const client = await connect(app.socketPath);

    const listed = await client.listTools();
    const called = await client.callTool({
      name: "list_repositories",
      arguments: {},
    });

    expect(client.getNegotiatedProtocolVersion() === "2026-07-28").toBe(
      era === "2026-07-28",
    );
    expect(listed.tools.map((tool) => tool.name)).toEqual(mcpToolNames);
    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toMatchObject({
      profile: { id: "acme" },
      repositories: [
        {
          repo: "patchdesk",
          checkouts: JSON.parse(await app.routeCheckouts()),
        },
      ],
    });
  });
});

describe("patchdesk mcp without the app", () => {
  it("still lists its tools and answers a call with app_not_running", async () => {
    const client = await connectLegacyClient(
      "/tmp/pd-mcp-missing/patchdesk.sock",
    );

    const listed = await client.listTools();
    const called = await client.callTool({
      name: "list_repositories",
      arguments: {},
    });

    expect(listed.tools.map((tool) => tool.name)).toEqual(mcpToolNames);
    expect(called.isError).toBe(true);
    expect(called.structuredContent).toMatchObject({
      error: "app_not_running",
    });
  });
});
