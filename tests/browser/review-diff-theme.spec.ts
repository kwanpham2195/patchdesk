// Covers diff colour output across theme/appearance switches: the main-thread
// CodeView options path, and the `@pierre/diffs` worker pool re-highlight path.
import { expect, test } from "playwright/test";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

test("switching the diff appearance genuinely re-colours the rendered code", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${serverOrigin(server)}/#performance-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });
    await expect(diff).toBeVisible();

    // Pierre's `File` renderer bakes BOTH a light and a dark hex value onto
    // every syntax token as `--diffs-token-light`/`--diffs-token-dark`
    // inline custom properties (see `node_modules/@pierre/diffs/dist/style.js`:
    // `[data-line] span { color: light-dark(var(--diffs-token-light, ...),
    // var(--diffs-token-dark, ...)) }`), and lets the shadow host's
    // `color-scheme` -- driven by `options.themeType` -- pick between them.
    // Reading the browser's own resolved `color`, not either custom
    // property or any attribute, is what proves the picked value actually
    // changed on screen; a class or attribute could flip without the reader
    // seeing a different colour. Each rendered file lives inside its own
    // open shadow root (`<diffs-container>`), several of them nested under
    // the virtualized viewport, so finding a token means piercing into
    // whichever one has painted content so far.
    const firstTokenColor = () =>
      page.evaluate(() => {
        const pierce = (root: Document | ShadowRoot): Element | null => {
          const direct = root.querySelector(
            '[data-line] span[style*="--diffs-token-light"]',
          );
          if (direct !== null) return direct;
          for (const el of Array.from(root.querySelectorAll("*"))) {
            if (el.shadowRoot != null) {
              const found = pierce(el.shadowRoot);
              if (found !== null) return found;
            }
          }
          return null;
        };
        const span = pierce(document);
        return span === null ? null : getComputedStyle(span).color;
      });

    await expect.poll(firstTokenColor, { timeout: 5_000 }).not.toBeNull();
    const before = await firstTokenColor();

    // `appearance` is no longer part of `codeViewKey` (see the comment on
    // `codeViewKey` in `review-diff-view.tsx`), so this switch re-options
    // Pierre's existing `CodeView` instance in place rather than rebuilding
    // it -- this assertion is the proof that the options path alone still
    // repaints every token.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Appearance" }).click();
    await page.getByRole("option", { name: "Dark", exact: true }).click();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // Give the re-optioned `CodeView` a moment to re-render and pick the
    // dark half of each token's baked-in pair back up; poll rather than
    // assert once.
    await expect.poll(firstTokenColor, { timeout: 5_000 }).not.toBe(before);
  } finally {
    await closeServer(server);
  }
});

test("switching the diff theme re-highlights through the worker pool", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${serverOrigin(server)}/#performance-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });
    await expect(diff).toBeVisible();

    // Same shadow-piercing token probe as "switching the diff appearance
    // genuinely re-colours the rendered code" above, and for the same reason:
    // only the browser's own resolved `color` proves what the reader sees.
    // What this test adds is the theme *name*, which the light-dark() pair
    // baked into each token cannot answer -- a different theme means different
    // hex values, which only a fresh highlight pass produces.
    const firstTokenColor = () =>
      page.evaluate(() => {
        const pierce = (root: Document | ShadowRoot): Element | null => {
          const direct = root.querySelector(
            '[data-line] span[style*="--diffs-token-light"]',
          );
          if (direct !== null) return direct;
          for (const el of Array.from(root.querySelectorAll("*"))) {
            if (el.shadowRoot != null) {
              const found = pierce(el.shadowRoot);
              if (found !== null) return found;
            }
          }
          return null;
        };
        const span = pierce(document);
        return span === null ? null : getComputedStyle(span).color;
      });

    await expect.poll(firstTokenColor, { timeout: 5_000 }).not.toBeNull();
    const before = await firstTokenColor();

    // The highlight pass runs in `@pierre/diffs`' worker pool
    // (`diff-worker-pool.tsx`), so a live worker is what makes the assertion
    // below a statement about the worker path rather than about a main-thread
    // fallback.
    expect(page.workers().length).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Light diff theme" }).click();
    await page.getByRole("option", { name: "gruvbox light hard" }).click();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // The pool colours from `WorkerPoolManager.renderOptions.theme`, which
    // only `useDiffWorkerPoolTheme`'s `setRenderOptions` call moves. Resolving
    // the new theme, re-posting it to every worker and re-highlighting the
    // visible files is asynchronous, so poll.
    await expect.poll(firstTokenColor, { timeout: 10_000 }).not.toBe(before);
  } finally {
    await closeServer(server);
  }
});
