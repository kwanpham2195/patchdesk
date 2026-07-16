import { createServer, type Server } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "playwright/test";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { startLocalApiServer, type LocalApiServer } from "../../src/main/local-api";

test("normal dashboard direct entry opens the persisted in-progress review session", async ({ page }) => {
  const renderer = await serve(); const root = await mkdtemp(join(tmpdir(), "patchdesk-normal-")); let api: LocalApiServer | undefined;
  try {
    const started = await startLocalApiServer({ allowedOrigin: origin(renderer), capability: "cap", paths: PatchdeskPaths.forTest(root), github: new FakeGitHubAdapter({ pullRequest: { ref: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 1 }, title: "Fixture", author: "fixture", headBranch: "feat/fixture", baseBranch: "sit", headSha: "abcdef1234567890abcdef1234567890abcdef12", isOpen: true, isDraft: false, reviewState: "approved", mergeability: "mergeable", labels: [], updatedAt: "2026-07-16T00:00:00.000Z" } as never }) });
    if (started._tag !== "started") throw new Error("api"); api = started.server;
    await page.addInitScript(({ baseUrl }) => Object.defineProperty(window, "patchdesk", { value: { localApi: { baseUrl, capability: "cap" } } }), { baseUrl: api.url.toString() });
    await page.goto(origin(renderer));
    await page.getByLabel("Pull request reference").fill("centraldigital/patchdesk#1");
    await page.getByRole("button", { name: "Preview pull request" }).click();
    await expect(page.getByRole("main")).toContainText("Review session started");
    await expect(page.getByText("Preparing the persisted review workbench")).toBeVisible();
    await page.screenshot({ path: "test-results/milestone-12-normal-open.png", fullPage: true });
  } finally { if (api !== undefined) await api.stop(); await close(renderer); await rm(root, { recursive: true, force: true }); }
});

async function serve(): Promise<Server> { const root = join(process.cwd(), "out/renderer"); const server = createServer(async (request, response) => { const file = normalize(join(root, request.url === undefined || request.url === "/" ? "index.html" : request.url)); if (!file.startsWith(root)) { response.writeHead(400).end(); return; } try { response.writeHead(200, { "Content-Type": extname(file) === ".js" ? "text/javascript" : extname(file) === ".css" ? "text/css" : "text/html" }).end(await readFile(file)); } catch { response.writeHead(404).end(); } }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); return server; }
function origin(server: Server): string { const address = server.address(); if (address === null || typeof address === "string") throw new Error("address"); return `http://127.0.0.1:${address.port}`; }
function close(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
