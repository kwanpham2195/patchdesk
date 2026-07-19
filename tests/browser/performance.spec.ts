import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { expect, test } from "playwright/test";

test("1,000-file and approximately 10 MB patch remains responsive", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.addInitScript(() => {
      const sample = { previous: performance.now(), maximumGap: 0 };
      Object.defineProperty(window, "__patchdeskPerformanceSample", {
        value: sample,
      });
      setInterval(() => {
        const current = performance.now();
        sample.maximumGap = Math.max(
          sample.maximumGap,
          current - sample.previous,
        );
        sample.previous = current;
      }, 25);
    });
    await page.goto(`${origin(server)}/#performance-fixture`);
    const workbench = page.getByRole("region", { name: "Diff workbench" });
    await expect(workbench).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("1000 changed files")).toBeVisible();
    const bytes = Number(await workbench.getAttribute("data-patch-bytes"));
    expect(bytes).toBeGreaterThanOrEqual(10_000_000);

    const filterDurations: Array<number> = [];
    const selectionDurations: Array<number> = [];
    for (let index = 995; index < 1_000; index += 1) {
      const suffix = String(index).padStart(4, "0");
      const path = `src/generated/file-${suffix}.ts`;
      const filterStarted = performance.now();
      await page.getByLabel("Search changed files").fill(`file-${suffix}`);
      const treeItem = page.getByRole("treeitem", { name: path });
      await expect(treeItem).toBeVisible();
      filterDurations.push(performance.now() - filterStarted);

      const selectionStarted = performance.now();
      await treeItem.click();
      await expect(
        page.getByRole("region", { name: "Review diff" }),
      ).toHaveAttribute("data-selected-path", path);
      selectionDurations.push(performance.now() - selectionStarted);
    }
    const maximumGap = await page.evaluate(() => {
      const sample = (
        window as Window & {
          readonly __patchdeskPerformanceSample?: {
            readonly maximumGap: number;
          };
        }
      ).__patchdeskPerformanceSample;
      return sample?.maximumGap ?? Number.POSITIVE_INFINITY;
    });

    const filter = summarize(filterDurations);
    const selection = summarize(selectionDurations);
    expect(filter.worst).toBeLessThan(200);
    expect(selection.worst).toBeLessThan(200);
    expect(maximumGap).toBeLessThan(1_000);
    const machine = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
    }));
    console.log(
      JSON.stringify({
        bytes,
        files: 1_000,
        iterations: 5,
        filter,
        selection,
        maximumGap,
        machine,
      }),
    );
  } finally {
    await close(server);
  }
});

function summarize(durations: ReadonlyArray<number>): {
  readonly median: number;
  readonly worst: number;
} {
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    median: sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY,
    worst: sorted.at(-1) ?? Number.POSITIVE_INFINITY,
  };
}

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
