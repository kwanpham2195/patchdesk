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
        return [
          {
            origin: "https://github.example.test/acme/discovered.git",
            localPath: "/workspace/discovered",
          },
        ];
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
  await page.getByRole("tab", { name: "Workspace" }).click();
  await page.getByRole("button", { name: "New profile" }).click();
  await page.getByLabel("Profile ID").fill("enterprise");
  await page.getByLabel("Label").fill("Enterprise");
  await page.getByLabel("GitHub host").fill("github.example.test");
  await page.getByLabel("GitHub account").fill("enterprise-user");
  await page.getByRole("textbox", { name: "workspace root 1", exact: true }).fill("/workspace/enterprise");
  await page.getByRole("textbox", { name: "owner filter 1", exact: true }).fill("enterprise");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByRole("combobox", { name: "Active profile" }).last().click();
  const enterpriseOption = page.getByRole("option", { name: "Enterprise" });
  await expect(enterpriseOption).toBeVisible();
  await enterpriseOption.click();
  await page.getByLabel("Label").fill("Enterprise updated");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("combobox", { name: "Active profile" }).last()).toContainText("Enterprise updated");

  const settingsRoute = page.url();
  await page.getByRole("tab", { name: "General" }).click();
  await page.getByLabel("Appearance").click();
  await page.getByRole("option", { name: "Dark" }).click();
  await expect(page).toHaveURL(settingsRoute);
  await page.getByRole("tab", { name: "Workspace" }).click();
  await page.getByLabel("Label").fill("Enterprise dirty");
  await page.getByRole("button", { name: "Close" }).click();
  const dirtyDialog = page.getByRole("alertdialog", { name: "Discard profile changes?" });
  await expect(dirtyDialog).toBeVisible();
  await dirtyDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dirtyDialog).toBeHidden();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Workspace" }).click();
  await page.getByRole("button", { name: "Discover" }).click();
  await expect(page.getByText("acme/discovered")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "acme/discovered /workspace/discovered" })).not.toBeChecked();

  await page.getByRole("tab", { name: "Data & recovery" }).click();
  await page.getByRole("button", { name: "Clear cache" }).click();
  await expect(page.getByRole("alertdialog", { name: "Clear cache?" })).toBeVisible();
  await page.getByRole("alertdialog", { name: "Clear cache?" }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog", { name: "Clear cache?" })).toBeHidden();
  await page.getByRole("button", { name: "Clear local review data" }).click();
  const clearLocalDialog = page.getByRole("alertdialog", { name: "Clear local review data?" });
  await expect(clearLocalDialog).toBeVisible();
  await clearLocalDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(clearLocalDialog).toBeHidden();
  await page.getByRole("button", { name: "Close" }).click();

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
