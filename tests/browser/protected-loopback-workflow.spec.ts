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
  });
  if (started._tag !== "started") throw new Error("local API did not start");
  api = started.server;

  await page.route("**/v1/environment*", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": origin },
      json: {
        git: "ready",
        gh: "ready",
        githubAuth: "authentication_required",
        githubAccounts: [],
      },
    });
  });

  await installTestDesktopBridge(page, {
    kind: "localApi",
    baseUrl: api.url.toString(),
    capability,
  });
  await page.goto(origin);

  expect(
    await page.evaluate(async (healthUrl) => {
      const response = await fetch(healthUrl);
      return response.status;
    }, new URL("health", api.url).toString()),
  ).toBe(401);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Workspace" }).click();
  // The Workspace card is a disclosure, collapsed by default: its
  // "New workspace" button, name field, and switcher exist only while it is
  // open. Its trigger is a button, distinct from the tab of the same name.
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "New workspace" }).click();
  const createDialog = page.getByRole("dialog", { name: "New workspace" });
  await createDialog.getByLabel("Name").fill("Enterprise");
  // The dialog offers no account control until its `GET /v1/environment`
  // probe answers, and refuses to create until then.
  await expect(
    createDialog.getByText("Checking GitHub authentication…"),
  ).toBeHidden();
  await createDialog.getByLabel("GitHub account").fill("enterprise-user");
  await createDialog.getByLabel("GitHub host").fill("github.example.test");
  await createDialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(createDialog).toBeHidden();
  await expect(
    page.getByRole("combobox", { name: "Active workspace" }).last(),
  ).toContainText("Enterprise");
  // Every Workspace control saves on its own: a repository is watched once
  // Add answers, and the name field commits when it loses focus.
  const workspaceSection = page.getByTestId("settings-section-workspace");
  await workspaceSection.getByLabel("Add a repository").fill("acme/watched");
  await workspaceSection
    .getByRole("button", { name: "Add", exact: true })
    .click();
  const workspaceName = page.getByRole("textbox", {
    name: "Name",
    exact: true,
  });
  await workspaceName.fill("Enterprise updated");
  await workspaceName.press("Tab");
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
  // Scoped to the Workspace section: the first-run flow behind the modal
  // lists the same repository.
  await expect(
    workspaceSection
      .getByRole("listitem", { name: "acme/watched" })
      .getByText("No checkout chosen"),
  ).toBeVisible();

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
