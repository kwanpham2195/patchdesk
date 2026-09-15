import { expect, test } from "playwright/test";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";
import { timingBudget } from "./timing-budget";

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

      // Selection is timed in the page because Playwright's click retries
      // while the tree's scroll container intercepts the hit point, which
      // measures the harness instead of the app.
      const selectionTrace: Array<{ path: string | null; latencyMs: number }> =
        [];
      Object.defineProperty(window, "__patchdeskSelectionTrace", {
        value: selectionTrace,
      });
      let pointerDownAt = Number.NaN;
      document.addEventListener(
        "pointerdown",
        () => {
          pointerDownAt = performance.now();
        },
        true,
      );
      // An observer on `documentElement` recorded nothing here, since the init
      // script runs before the page's own <html> exists, so observe `document`.
      new MutationObserver((records) => {
        const committedAt = performance.now();
        for (const record of records) {
          if (!(record.target instanceof Element)) continue;
          selectionTrace.push({
            path: record.target.getAttribute("data-selected-path"),
            latencyMs: committedAt - pointerDownAt,
          });
        }
      }).observe(document, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-selected-path"],
      });
    });
    await page.goto(`${serverOrigin(server)}/#performance-fixture`);
    const workbench = page.getByRole("region", { name: "Diff workbench" });
    await expect(workbench).toBeVisible({ timeout: 15_000 });
    // Visibility can resolve during the frame that commits the 10 MB fixture.
    // Start interaction timing only after the browser can present that frame.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const bytes = Number(await workbench.getAttribute("data-patch-bytes"));
    expect(bytes).toBeGreaterThanOrEqual(10_000_000);

    const filterDurations: Array<number> = [];
    const selectionDurations: Array<number> = [];
    for (let index = 995; index < 1_000; index += 1) {
      const suffix = String(index).padStart(4, "0");
      const path = `src/generated/file-${suffix}.ts`;
      // Filter stays timed from Node: `fill` does no actionability retries,
      // so its round trip is a fair upper bound on the app's work.
      const filterStarted = performance.now();
      await page
        .locator("[data-file-tree-search-input]")
        .fill(`file-${suffix}`);
      const treeItem = page.getByRole("treeitem", {
        name: `file-${suffix}.ts`,
      });
      await expect(treeItem).toBeVisible();
      filterDurations.push(performance.now() - filterStarted);

      await treeItem.click();
      await expect(
        page.getByRole("region", { name: "Review diff" }),
      ).toHaveAttribute("data-selected-path", path);
      const latencyMs = await page.evaluate((selectedPath) => {
        // SAFETY: the addInitScript above always installs
        // `__patchdeskSelectionTrace` on `window` before any other script
        // runs on this page, so the property carries this shape.
        const trace = (
          window as Window & {
            readonly __patchdeskSelectionTrace?: ReadonlyArray<{
              readonly path: string | null;
              readonly latencyMs: number;
            }>;
          }
        ).__patchdeskSelectionTrace;
        return trace?.filter((entry) => entry.path === selectedPath).at(-1)
          ?.latencyMs;
      }, path);
      if (latencyMs === undefined || Number.isNaN(latencyMs))
        throw new Error(`No in-page selection timing was recorded for ${path}`);
      selectionDurations.push(latencyMs);
    }
    const maximumGap = await page.evaluate(() => {
      // SAFETY: the addInitScript above always installs
      // `__patchdeskPerformanceSample` on `window` before any other script
      // runs on this page, so the property carries this shape.
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
    expect(filter.worst).toBeLessThan(timingBudget.worstInteractionMs);
    expect(selection.worst).toBeLessThan(timingBudget.worstInteractionMs);
    // The ceilings and the measurements behind them live in ./timing-budget
    // so the local and CI numbers are stated in one place.
    expect(maximumGap).toBeLessThan(timingBudget.maximumGapMs);

    // Reset the sampler so the scroll phase below is judged on its own
    // cadence, not on the budget the filter/selection loop already spent.
    await page.evaluate(() => {
      // SAFETY: the addInitScript above always installs
      // `__patchdeskPerformanceSample` on `window` before any other script
      // runs on this page, so the property carries this shape.
      const sample = (
        window as Window & {
          __patchdeskPerformanceSample?: {
            previous: number;
            maximumGap: number;
          };
        }
      ).__patchdeskPerformanceSample;
      if (sample !== undefined) {
        sample.maximumGap = 0;
        sample.previous = performance.now();
      }
    });

    const scrollViewport = page.locator(".review-diff-viewport");
    const scrollBox = await scrollViewport.boundingBox();
    if (scrollBox === null)
      throw new Error("Review diff viewport was not visible");
    await page.mouse.move(
      scrollBox.x + scrollBox.width / 2,
      scrollBox.y + scrollBox.height / 2,
    );

    // The fixture's initial finding (and the filter/selection loop above,
    // which lands on file 995-999) both leave the viewport at the very
    // bottom of a ~2.6M px document, in already-materialized content. A
    // sustained scroll must start from unmaterialized territory or it will
    // not exercise the work this phase exists to measure. Scroll to the top
    // with real wheel events (never assign scrollTop) before timing begins.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await page.mouse.wheel(0, -100_000);
    }
    const geometry = await scrollViewport.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollTop: element.scrollTop,
    }));
    if (geometry.scrollTop !== 0)
      throw new Error(
        `Review diff viewport did not reach the top: scrollTop=${geometry.scrollTop}`,
      );

    // Reset the sampler again: the scroll-to-top jump above is not the
    // phase under measurement, only the setup that gets it there.
    await page.evaluate(() => {
      // SAFETY: the addInitScript above always installs
      // `__patchdeskPerformanceSample` on `window` before any other script
      // runs on this page, so the property carries this shape.
      const sample = (
        window as Window & {
          __patchdeskPerformanceSample?: {
            previous: number;
            maximumGap: number;
          };
        }
      ).__patchdeskPerformanceSample;
      if (sample !== undefined) {
        sample.maximumGap = 0;
        sample.previous = performance.now();
      }
    });

    // 75 steps of 8,000px (600,000px, ~23% of the document, ~229 files) with
    // no pause between events. A short scroll close to the bottom (the
    // fixture's initial position) measured only 0.86% of the document and a
    // ~25ms gap -- indistinguishable from noise. This distance, starting
    // from the top where content still needs to materialize, is what
    // produced a real, reproducible signal during measurement (see the
    // ceiling comment below).
    const scrollStepPixels = 8_000;
    const scrollSteps = 75;
    const scrollDurations: Array<number> = [];
    for (let step = 0; step < scrollSteps; step += 1) {
      const stepStarted = performance.now();
      await page.mouse.wheel(0, scrollStepPixels);
      scrollDurations.push(performance.now() - stepStarted);
    }
    const scrollMaximumGap = await page.evaluate(() => {
      // SAFETY: the addInitScript above always installs
      // `__patchdeskPerformanceSample` on `window` before any other script
      // runs on this page, so the property carries this shape.
      const sample = (
        window as Window & {
          readonly __patchdeskPerformanceSample?: {
            readonly maximumGap: number;
          };
        }
      ).__patchdeskPerformanceSample;
      return sample?.maximumGap ?? Number.POSITIVE_INFINITY;
    });
    const scroll = summarize(scrollDurations);
    const scrollDistance = scrollStepPixels * scrollSteps;
    // The scroll ceiling lives in ./timing-budget too; the run history that
    // sized it is in this comment's git history.
    expect(scrollMaximumGap).toBeLessThan(timingBudget.scrollMaximumGapMs);

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
        scroll,
        scrollMaximumGap,
        scrollDistance,
        scrollFraction: scrollDistance / geometry.scrollHeight,
        budget: timingBudget,
        machine,
      }),
    );
  } finally {
    await closeServer(server);
  }
});

function summarize(durations: ReadonlyArray<number>) {
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    median: sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY,
    worst: sorted.at(-1) ?? Number.POSITIVE_INFINITY,
  };
}
