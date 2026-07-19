import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "playwright/test";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  startLocalApiServer,
  type LocalApiServer,
} from "../../src/main/local-api";
import { installTestDesktopBridge } from "./bridge-fixture";

const capability = "browser-test-capability";
let client: Server | undefined;
let api: LocalApiServer | undefined;
let root: string | undefined;

test.afterEach(async () => {
  if (api !== undefined) await api.stop();
  if (client !== undefined) await close(client);
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  api = undefined;
  client = undefined;
  root = undefined;
});

test("renderer uses the protected loopback API for profile and watchlist controls", async ({
  page,
}) => {
  client = await serveRenderer();
  const origin = serverOrigin(client);
  root = await mkdtemp(`${tmpdir()}/patchdesk-browser-`);
  const started = await startLocalApiServer({
    allowedOrigin: origin,
    capability,
    paths: PatchdeskPaths.forTest(root),
    github: new FakeGitHubAdapter({
      authenticatedAccount: { host: "github.com", account: "browser-user" },
      listOpenPullRequests: [],
    }),
    origins: {
      async findOrigins() {
        return ["https://github.example.test/acme/discovered.git"];
      },
    },
  });
  if (started._tag !== "started") throw new Error("local API did not start");
  api = started.server;

  await installTestDesktopBridge(page, api.url.toString(), capability);
  await page.goto(origin);

  expect(
    await page.evaluate(async (healthUrl) => {
      const response = await fetch(healthUrl);
      return response.status;
    }, new URL("health", api.url).toString()),
  ).toBe(401);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Profile ID").fill("enterprise");
  await page.getByLabel("Label").fill("Enterprise");
  await page.getByLabel("GitHub host").fill("github.example.test");
  await page.getByLabel("GitHub account").fill("enterprise-user");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByLabel("Active profile").click();
  await page.getByRole("option", { name: "Enterprise" }).click();
  await page.getByLabel("Label").fill("Enterprise updated");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByLabel("Active profile")).toContainText("Enterprise updated");

  await page.getByRole("button", { name: "Test GitHub access" }).click();
  await expect(page.getByText("GitHub access: available")).toBeVisible();
  await page.getByRole("button", { name: "Discover workspace repositories" }).click();
  await expect(page.getByText("acme/discovered")).toBeVisible();
  await page.getByRole("button", { name: "Add suggestion" }).click();
  await expect(
    page.getByRole("button", { name: "Archive" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(
    page.getByRole("button", { name: "Restore" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Pending PRs" }).click();
  await page.getByLabel("Pull request reference").fill("acme/service#3");
  await page.getByRole("button", { name: "Preview pull request" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not open review" })).toContainText("Could not prepare acme/service#3.");

  await page
    .getByLabel("Pull request reference")
    .fill("https://github.com/centraldigital/patchdesk/pull/7");
  await page.getByRole("button", { name: "Preview pull request" }).click();
  await expect(
    page.getByRole("dialog", { name: "Switch workspace profile" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep current profile" }).click();
  await expect(
    page.getByRole("dialog", { name: "Switch workspace profile" }),
  ).toBeHidden();

  await page.screenshot({
    path: "test-results/milestone-5-browser.png",
    fullPage: true,
  });
});

async function serveRenderer(): Promise<Server> {
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
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": contentType(file) }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function serverOrigin(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function contentType(path: string): string {
  return extname(path) === ".js"
    ? "text/javascript"
    : extname(path) === ".css"
      ? "text/css"
      : "text/html";
}
