import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import {
  createPatchdeskMcpServer,
  type PatchdeskMcpServerOptions,
} from "../../src/mcp/patchdesk-mcp-server";

const openClients: Array<() => Promise<void>> = [];

/** Closes every client the helpers below connected, newest first; call it in `afterEach`. */
export async function closeMcpTestClients(): Promise<void> {
  for (const close of openClients.splice(0).reverse()) await close();
}

function shimOptions(socketPath: string): PatchdeskMcpServerOptions {
  return { socketPath, version: "0.0.0-test", report: () => {}, debug: false };
}

/** The 2025-era opening a client sends by default, served by the same `serveStdio` entry the shim runs. */
export async function connectLegacyClient(socketPath: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(
    () => createPatchdeskMcpServer(shimOptions(socketPath)),
    { transport: serverSide },
  );
  const client = new Client({ name: "legacy-test", version: "1.0.0" });
  await client.connect(clientSide);
  openClients.push(async () => {
    await client.close();
    await served.close();
  });
  return client;
}

/** The 2026-07-28 era, in process: the client's fetch goes straight to the handler (ADR 0052 "Test strategy"). */
export async function connectModernClient(socketPath: string): Promise<Client> {
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
  openClients.push(async () => {
    await client.close();
    await handler.close();
  });
  return client;
}

/** Both protocol eras, for `describe.each`. */
export const mcpProtocolEras = [
  { era: "2025", connect: connectLegacyClient },
  { era: "2026-07-28", connect: connectModernClient },
] as const;
