import { expect, test } from "playwright/test";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

// A single renderer scheduling pause can contaminate one timing sample when
// the full browser suite has just exercised many heavy fixtures. Retries keep
// the strict per-attempt ceiling intact without accepting a slow measurement.
test.describe.configure({ retries: 2 });

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
      const filterStarted = performance.now();
      await page
        .locator("[data-file-tree-search-input]")
        .fill(`file-${suffix}`);
      const treeItem = page.getByRole("treeitem", {
        name: `file-${suffix}.ts`,
      });
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
    expect(filter.worst).toBeLessThan(200);
    expect(selection.worst).toBeLessThan(200);
    // Measured across seven runs on this machine after the slice-3
    // worker-pool change (which took this phase from 621ms down to
    // double digits): 114.2, 111.0, 84.1, 113.4, 113.7, 82.9, 111.7ms,
    // clustering 82.9-114.2ms with no clear cold-vs-warm split. 1,000 was
    // sized against a pre-worker-pool baseline and is now nearly 9x the
    // worst observed. This phase (file-tree filtering plus selection
    // clicks across 1,000 files) has more DOM-interaction variance than
    // the scroll phase below, so 300 -- about 2.6x the 114.2ms worst --
    // keeps meaningful headroom rather than matching the scroll phase's
    // tighter ~2x margin.
    expect(maximumGap).toBeLessThan(300);

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
    // 800 dates back to a pre-worker-pool baseline (nine runs clustering
    // 378.3-399.3ms with a 533.3ms cold-start outlier; see the git history
    // of this comment for that data). Slice 3 moved syntax colouring off
    // the main thread with a worker pool and dropped this phase to
    // double digits. Slice 4 (this change) coalesces the scroll handler to
    // one `updateActivePath` run per animation frame instead of one per
    // scroll event, which did not move this number further -- the DOM
    // reads `readActiveFileViewport` performs were kept rather than swapped
    // for `@pierre/diffs`' cached accessors after those accessors proved to
    // disagree with the DOM (`getScrollHeight()` measured 16px short of the
    // real `scrollHeight`, `@pierre/diffs`'s own container padding). Seven
    // runs of this exact design on this machine, including one deliberate
    // cold run (a fresh `pnpm test:performance` invocation, not immediately
    // following another): 34.1, 34.4, 33.9, 36.1, 41.5, 34.4, 33.8ms (cold).
    // The cold run was not the outlier here -- all seven cluster
    // 33.8-41.5ms. 100 is roughly 2.4x the worst observed (41.5ms), more
    // headroom than the ~1.5x this ceiling used previously: at this small
    // an absolute magnitude a few milliseconds of scheduler noise is a
    // large relative swing, so the wider margin avoids a ceiling that only
    // passes on a lucky run. The two retries configured at the top of this
    // file are additional safety on top of that margin.
    // A shorter scroll near the fixture's initial (already-materialized)
    // bottom position measured only ~25ms -- this distance and starting
    // point are what make the phase sensitive to the work it exists to
    // catch.
    expect(scrollMaximumGap).toBeLessThan(100);

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
