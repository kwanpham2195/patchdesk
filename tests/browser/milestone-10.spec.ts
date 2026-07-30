import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { expect, test } from "playwright/test";

test("review batch requires explicit apply and submit confirmations", async ({ page }) => {
  const server = await serveRenderer();
  try {
    await page.goto(`${origin(server)}/#submission-fixture`);
    await page.getByRole("button", { name: "Create pending review" }).click();
    await expect(page.getByRole("alertdialog", { name: "Apply this review batch to GitHub?" })).toBeVisible();
    await expect(page.getByText("src/services/review-submission-service.ts:34")).toBeVisible();
    await page.screenshot({ path: "test-results/milestone-10-preview.png", fullPage: true });
    await page.getByRole("button", { name: "Create pending review" }).click();
    await expect(page.getByText("Pending review 9001 created.")).toBeVisible();
    await page.getByRole("button", { name: "Submit pending review" }).click();
    await page.getByRole("combobox", { name: "Review event" }).click();
    await page.getByRole("option", { name: "REQUEST_CHANGES" }).click();
    await page.getByRole("checkbox", { name: "I understand this submits the pending review." }).check();
    await page.getByRole("button", { name: "Submit review" }).click();
    await expect(page.getByText(/Submitted/)).toBeVisible();
    await expect(page.getByRole("button", { name: /submit pending review/i })).toHaveCount(0);
    await page.screenshot({ path: "test-results/milestone-10-browser.png", fullPage: true });
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
