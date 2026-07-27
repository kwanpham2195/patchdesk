import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { expect, test } from "playwright/test";

test("Design index lists stable scenario links", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/`);
    await expect(page).toHaveTitle("Patchdesk Design");
    await expect(page.getByRole("heading", { name: "Interactive visual prototype" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Inbox default/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Review completed/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Settings/ })).toBeVisible();
    await page.screenshot({ path: "test-results/patchdesk-design-index.png", fullPage: true });
  } finally {
    await close(server);
  }
});

test("default inbox scenario renders the shared product surface", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=inbox-default`);
    await expect(page.getByRole("heading", { name: "Maintainer inbox" })).toBeVisible();
    await expect(page.getByText("Protect review writes")).toBeVisible();
    await expect(page.getByText("Review updated VIP snapshot replacement")).toBeVisible();
    await page.locator('[role="option"]').first().click();
    await expect(page.getByLabel("Review workbench")).toBeVisible();
    await page.screenshot({ path: "test-results/patchdesk-design-inbox.png", fullPage: true });
  } finally {
    await close(server);
  }
});

test("settings scenario keeps configuration local", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=settings-default`);
    await expect(page).toHaveTitle(/Patchdesk Design · Settings/);
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
    await expect(page.getByText("CFW").first()).toBeVisible();
    await page.screenshot({ path: "test-results/patchdesk-design-settings.png", fullPage: true });
  } finally {
    await close(server);
  }
});

test("design scenarios cover loading, error, cached, prepared, and running states", async ({ page }) => {
  const cases = ["inbox-loading", "inbox-error", "inbox-cached", "review-prepared", "review-running"] as const;
  for (const scenario of cases) {
    const server = await serveDesign();
    try {
      await page.goto(`${origin(server)}/?scenario=${scenario}`);
      if (scenario === "inbox-loading") await expect(page.getByLabel("Loading dashboard")).toBeAttached();
      if (scenario === "inbox-error") await expect(page.getByText("Patchdesk could not read the active profile or GitHub dashboard.")).toBeVisible();
      if (scenario === "inbox-cached") await expect(page.getByText("GitHub: Cached after refresh failure")).toBeVisible();
      if (scenario === "review-prepared") await expect(page.getByRole("button", { name: "Run review" })).toBeVisible();
      if (scenario === "review-running") await expect(page.getByText("Review in progress").first()).toBeVisible();
    } finally {
      await close(server);
    }
  }
});

test("design surfaces remain readable at the approved desktop and light-theme size", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=inbox-default&appearance=light`);
    await expect(page.getByRole("heading", { name: "Maintainer inbox" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    await page.screenshot({ path: "test-results/patchdesk-design-inbox-light-1440.png", fullPage: true });
  } finally {
    await close(server);
  }
});

test("completed review scenario renders findings and checks", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=review-completed`);
    await expect(page.getByRole("heading", { name: "Protect review writes" })).toBeVisible();
    await expect(page.getByText("Keep writes behind the stale-head check").first()).toBeVisible();
    await expect(page.getByText("Existing GitHub review comment.").first()).toBeVisible();
    await page.screenshot({ path: "test-results/patchdesk-design-completed.png", fullPage: true });
  } finally {
    await close(server);
  }
});

test("dialog scenarios remain directly addressable", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=dialog-submit`);
    await expect(page.getByRole("button", { name: "Create pending review" })).toBeVisible();
    await page.goto(`${origin(server)}/?scenario=dialog-merge`);
    await expect(page.getByRole("button", { name: "Prepare merge confirmation" })).toBeVisible();
  } finally {
    await close(server);
  }
});

async function serveDesign(): Promise<Server> {
  const designRoot = join(process.cwd(), "release/design");
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://patchdesk-design.local").pathname;
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = normalize(join(designRoot, relativePath));
    const relativeFile = relative(designRoot, file);
    if (relativeFile.startsWith("..") || relativeFile.startsWith("/")) {
      response.writeHead(400).end();
      return;
    }
    try {
      response.writeHead(200, { "Content-Type": contentType(extname(file)) });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function contentType(extension: string): string {
  if (extension === ".js") return "text/javascript";
  if (extension === ".css") return "text/css";
  if (extension === ".woff2") return "font/woff2";
  return "text/html";
}

function origin(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
