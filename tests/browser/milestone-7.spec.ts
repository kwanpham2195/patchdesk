import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { expect, test } from "playwright/test";

test("diff workbench", async ({ page }) => {
  const server = await serveRenderer();
  try {
    await page.goto(`${origin(server)}/#diff-fixture`);
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe("light");
    await expect(
      page.getByRole("region", { name: "Diff workbench" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Review diff" })).toHaveAttribute("data-selected-path", "src/b.ts");
    await expect(
      page.getByRole("button", {
        name: "Exact file contents are unavailable for this review",
      }),
    ).toBeDisabled();
    await page.screenshot({
      path: "test-results/milestone-7-browser.png",
      fullPage: true,
    });
  } finally {
    await close(server);
  }
});

test("constrained diff workbench keeps secondary rails reachable through labelled sheets", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 960, height: 900 });
    await page.goto(`${origin(server)}/#diff-fixture`);

    await expect(
      page.getByRole("complementary", { name: "Review navigation" }),
    ).toBeHidden();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const filesDialog = page.getByRole("dialog", { name: "Changed files" });
    await expect(filesDialog).toBeVisible();
    await expect(filesDialog.getByRole("treeitem").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", {
        name: "Exact file contents are unavailable for this review",
      }),
    ).toBeDisabled();
  } finally {
    await close(server);
  }
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
      response
        .writeHead(200, {
          "Content-Type":
            extname(file) === ".js"
              ? "text/javascript"
              : extname(file) === ".css"
                ? "text/css"
                : "text/html",
        })
        .end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
function origin(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
