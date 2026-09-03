import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import type { Page } from "playwright/test";

/**
 * Serves the built renderer (`out/renderer`) over loopback on an ephemeral
 * port, so a browser spec can drive the real bundle rather than a dev server.
 * Only the three content types the bundle actually emits are mapped; anything
 * else is served as HTML, which is what `index.html` needs for hash routes.
 */
export async function serveRenderer(): Promise<Server> {
  const rendererRoot = join(process.cwd(), "out/renderer");
  const server = createServer(async (request, response) => {
    const path =
      request.url === undefined || request.url === "/"
        ? "index.html"
        : request.url;
    const file = normalize(join(rendererRoot, path));
    if (!file.startsWith(rendererRoot)) {
      response.writeHead(400).end();
      return;
    }
    try {
      response
        .writeHead(200, {
          "Content-Type":
            extname(file) === ".js"
              ? "text/javascript"
              : extname(file) === ".css"
                ? "text/css"
                : "text/html",
        })
        .end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

/** Loopback origin a listening fixture server can be reached at. */
export function serverOrigin(server: Server): string {
  const address = server.address();
  if (address === null || !isAddressInfo(address))
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Stops a fixture server, dropping its open sockets first.
 *
 * `server.closeAllConnections()` is what makes this reliable. `Server#close`
 * only stops *new* connections and then waits for the open ones to end, and
 * the page's keep-alive sockets are still open at teardown: Playwright closes
 * the browser context after the test function returns, so a spec's `finally`
 * awaits this while the page it just drove is still connected.
 *
 * That wait was the flake known as "review-workbench.spec.ts:93". Roughly one
 * run in twelve, the close sat on those sockets for the whole 30-second test
 * timeout, and the run was reported as `Test timeout of 30000ms exceeded`
 * against the Settings test with no failing assertion -- while the test body
 * itself had finished in about half a second. It read as a Settings bug and
 * was not one: nothing about Settings was involved, and the same teardown
 * sat at the bottom of every spec in this directory, so any of them could
 * have drawn the short straw instead.
 */
export function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

/**
 * `Server#address()` returns `string | AddressInfo | null`; the string branch
 * is a named pipe or socket path, which these fixtures never bind.
 */
function isAddressInfo(address: string | AddressInfo): address is AddressInfo {
  return Object.prototype.hasOwnProperty.call(address, "port");
}

/** Flips diff view options through the toolbar popover, the way a reviewer does. */
export async function chooseDiffOptions(
  page: Page,
  options: { readonly split?: boolean; readonly wrap?: boolean },
): Promise<void> {
  await page.getByRole("button", { name: "View options" }).click();
  if (options.split)
    await page.getByRole("switch", { name: "Split view" }).click();
  if (options.wrap)
    await page.getByRole("switch", { name: "Wrap lines" }).click();
  await page.keyboard.press("Escape");
}
