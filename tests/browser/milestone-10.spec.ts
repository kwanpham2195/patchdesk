import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { expect, test } from "playwright/test";

test("review submission requires explicit pending and submit confirmations", async ({ page }) => {
  const server = await serveRenderer();
  try {
    await page.goto(`${origin(server)}/#submission-fixture`);
    await page.getByRole("button", { name: "Create pending review" }).click();
    await expect(page.getByText("P0/P1 findings are included in this review.")).toBeVisible();
    await expect(page.getByText("src/services/review-submission-service.ts:34")).toBeVisible();
    await expect(page.getByText("src/services/review-submission-service.ts:55")).toHaveCount(0);
    await page.screenshot({ path: "test-results/milestone-10-preview.png", fullPage: true });
    await page.getByLabel("I understand this creates one pending GitHub review.").check();
    await page.getByRole("button", { name: "Confirm pending review" }).click();
    await expect(page.getByText("Pending review 9001 created.")).toBeVisible();
    await page.getByRole("button", { name: "Submit pending review" }).click();
    await page.getByLabel("Review event").selectOption("REQUEST_CHANGES");
    await page.getByLabel("Review summary").fill("Request changes before merge.");
    await page.getByLabel("I understand this submits the pending review.").check();
    await page.getByRole("button", { name: "Submit review" }).click();
    await expect(page.getByText("Review 9001 submitted as REQUEST_CHANGES.")).toBeVisible();
    await expect(page.getByRole("button", { name: /create|submit/i })).toHaveCount(0);
    await page.screenshot({ path: "test-results/milestone-10-browser.png", fullPage: true });
  } finally { await close(server); }
});

test("pending-review rejection preserves the local draft and dialog", async ({ page }) => {
  const server = await serveRenderer();
  try {
    await page.goto(`${origin(server)}/#submission-rejection-fixture`);
    await page.getByRole("button", { name: "Create pending review" }).click();
    await page.getByLabel("I understand this creates one pending GitHub review.").check();
    await page.getByRole("button", { name: "Confirm pending review" }).click();
    await expect(page.getByRole("alert")).toHaveText("GitHub rejected the pending review. Your local draft was preserved.");
    await expect(page.getByRole("dialog", { name: "Create pending review" })).toBeVisible();
    await expect(page.getByText("Keep the stale-head check at the write boundary.")).toBeVisible();
    await page.screenshot({ path: "test-results/milestone-10-rejection.png", fullPage: true });
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
