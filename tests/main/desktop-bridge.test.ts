import { createServer, type Server } from "node:http";
import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it } from "vitest";

import { installDesktopRequestBridge } from "../../src/main/desktop-bridge";
import type {
  DesktopRequest,
  DesktopResponse,
} from "../../src/main/ipc-contract";

import * as v from "valibot";

/** A listening TCP server address, as `Server.address()` reports it. */
const tcpAddressSchema = v.looseObject({ port: v.number() });

type BridgeHandler = (
  event: IpcMainInvokeEvent,
  input: DesktopRequest,
) => Promise<DesktopResponse>;

describe("desktop request bridge", () => {
  it("projects a local HTTP failure with status and body", async () => {
    const http = await startFailureServer();
    try {
      let handler: BridgeHandler | undefined;
      const ipc = {
        removeHandler(_channel: string): void {},
        handle(_channel: string, next: BridgeHandler): void {
          handler = next;
        },
      };
      installDesktopRequestBridge(
        ipc,
        42,
        { capability: "test-capability", url: http.url },
        "http://renderer.test",
        {
          selectDirectory: async () => undefined,
          setNavigationState: () => undefined,
          openExternalHttps: async () => false,
        },
      );
      if (handler === undefined)
        throw new Error("Bridge handler was not installed");

      const response = await handler(
        { sender: { id: 42 } } as IpcMainInvokeEvent,
        { path: "/v1/inbox" },
      );

      expect(response.ok).toBe(false);
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "refresh_failed",
        retryable: true,
      });
      expect(response.correlationId).not.toBe("");
    } finally {
      await closeServer(http.server);
    }
  });
});

async function startFailureServer(): Promise<{
  readonly server: Server;
  readonly url: URL;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "refresh_failed", retryable: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = v.safeParse(tcpAddressSchema, server.address());
  if (!address.success) {
    await closeServer(server);
    throw new Error("Failure server did not expose a TCP address");
  }
  return {
    server,
    url: new URL(`http://127.0.0.1:${address.output.port}/`),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
