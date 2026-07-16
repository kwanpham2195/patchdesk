import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { expect, test } from "playwright/test";

test("completed-review workbench keeps drafts local and unmapped findings unpostable", async ({ page }) => {
  const server = await serveRenderer();
  try {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await expect(page.getByRole("region", { name: "Completed review workbench" })).toBeVisible();
    await expect(page.getByText("Unmapped — not postable")).toBeVisible();
    await page.getByLabel("Draft for mapped").fill("Edited only in Patchdesk");
    await expect(page.getByLabel("Draft for mapped")).toHaveValue("Edited only in Patchdesk");
    await page.getByRole("button", { name: "Copy validation plan" }).click();
    await expect(page.getByText("Validation plan copied locally.")).toBeVisible();
    await page.getByRole("button", { name: "Attempt 004: Discarded" }).click();
    await expect(page.getByText("Reopened attempt 004 in the workbench.")).toBeVisible();
    await expect(page.getByRole("button", { name: /post|submit|reply|resolve|apply/i })).toHaveCount(0);
    await page.screenshot({ path: "test-results/milestone-9-browser.png", fullPage: true });
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
