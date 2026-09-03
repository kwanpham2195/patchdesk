import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test, expect } from "playwright/test";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  startLocalApiServer,
  type LocalApiServer,
} from "../../src/main/local-api";
import { installTestDesktopBridge } from "./bridge-fixture";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

const capability = "browser-test-capability";
let client: Server | undefined;
let api: LocalApiServer | undefined;
let root: string | undefined;

test.afterEach(async () => {
  if (api !== undefined) await api.stop();
  if (client !== undefined) await closeServer(client);
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
      async find() {
        return [
          {
            root: "/workspace/enterprise",
            state: "ready" as const,
            origins: [
              {
                origin: "https://github.example.test/acme/discovered.git",
                localPath: "/workspace/enterprise/discovered",
              },
            ],
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
  await page.getByRole("button", { name: "New workspace" }).click();
  const createDialog = page.getByRole("dialog", { name: "New workspace" });
  await createDialog.getByLabel("Name").fill("Enterprise");
  // `GET /v1/environment` runs the real `gh` on the machine running this
  // suite, so whether the dialog offers an account Select or the manual
  // fields is not fixed here; fill the manual pair only when it is showing.
  const manualAccount = createDialog.getByLabel("GitHub account");
  if (await manualAccount.isVisible()) {
    await manualAccount.fill("enterprise-user");
    await createDialog.getByLabel("GitHub host").fill("github.example.test");
  }
  await createDialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(createDialog).toBeHidden();
  await expect(
    page.getByRole("combobox", { name: "Active workspace" }).last(),
  ).toContainText("Enterprise");
  await page.getByRole("button", { name: "Add folder" }).click();
  // Every Workspace control saves on its own: the root row commits when it
  // loses focus, and the name field commits the same way.
  await page
    .getByRole("textbox", { name: "Folder 1", exact: true })
    .fill("/workspace/enterprise");
  await page.getByLabel("Label").click();
  await page.getByLabel("Label").fill("Enterprise updated");
  await page.getByLabel("Profile ID").click();
  await expect(
    page.getByRole("combobox", { name: "Active workspace" }).last(),
  ).toContainText("Enterprise updated");

  const settingsRoute = page.url();
  await page.getByRole("tab", { name: "General" }).click();
  await page.getByLabel("Appearance").click();
  await page.getByRole("option", { name: "Dark" }).click();
  await expect(page).toHaveURL(settingsRoute);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Workspace" }).click();
  // Workspace-root discovery is automatic: the root's own save above scans
  // the profile's workspace roots via `GET /v1/watchlist/suggestions` from a
  // `useEffect` (see `useWorkspaceRootDiscovery`), with no button to drive
  // it. Wait directly for that scan's result to appear.
  await expect(page.getByText("acme/discovered")).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: "acme/discovered /workspace/enterprise/discovered",
    }),
  ).not.toBeChecked();

  await page.getByRole("tab", { name: "Data & recovery" }).click();
  await page.getByRole("button", { name: "Clear cache" }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Clear cache?" }),
  ).toBeVisible();
  await page
    .getByRole("alertdialog", { name: "Clear cache?" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "Clear cache?" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Clear local review data" }).click();
  const clearLocalDialog = page.getByRole("alertdialog", {
    name: "Clear local review data?",
  });
  await expect(clearLocalDialog).toBeVisible();
  await clearLocalDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(clearLocalDialog).toBeHidden();
  await page.getByRole("button", { name: "Close" }).click();
});
