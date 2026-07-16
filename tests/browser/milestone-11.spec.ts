import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { expect, test } from "playwright/test";

test("merge confirmation shows warnings and requires acknowledgement", async ({ page }) => {
  const server = await serveRenderer();
  try {
    await page.goto(`${origin(server)}/#merge-fixture`);
    await expect(page.getByText("request_changes")).toBeVisible();
    await page.getByRole("button", { name: "Prepare merge confirmation" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm merge" })).toBeVisible();
    await expect(page.getByText("centraldigital/patchdesk#42")).toBeVisible();
    await page.getByLabel("I acknowledge the merge warnings.").check();
    await page.getByRole("button", { name: "Confirm merge" }).click();
    await expect(page.getByText("Merged abcdef.")).toBeVisible();
    await page.screenshot({ path: "test-results/milestone-11-browser.png", fullPage: true });
  } finally { await close(server); }
});

async function serveRenderer(): Promise<Server> {
  const rendererRoot = join(process.cwd(), "out/renderer");
  const server = createServer(async (request, response) => {
    const path = request.url === undefined || request.url === "/" ? "index.html" : request.url;
    const file = normalize(join(rendererRoot, path));
    if (!file.startsWith(rendererRoot)) { response.writeHead(400).end(); return; }
    try { response.writeHead(200, { "Content-Type": extname(file) === ".js" ? "text/javascript" : extname(file) === ".css" ? "text/css" : "text/html" }).end(await readFile(file)); } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); return server;
}
function origin(server: Server): string { const address = server.address(); if (address === null || typeof address === "string") throw new Error("missing address"); return `http://127.0.0.1:${address.port}`; }
function close(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
