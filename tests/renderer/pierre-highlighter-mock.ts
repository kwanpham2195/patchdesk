import { vi } from "vitest";
import type * as PierreDiffs from "@pierre/diffs";

/**
 * The single owner of the `@pierre/diffs` module mock for renderer tests.
 * Import it for its side effect, as the first import of the test file, so the
 * mock registers before any module that pulls `@pierre/diffs` is evaluated:
 *
 *     import "./pierre-highlighter-mock";
 *
 * Every export stays real; the stubbed `preloadHighlighter` resolves so the
 * hook's highlighting state settles to "ready". Tests that need to observe or
 * steer the preload read it back with `vi.mocked(preloadHighlighter)` after
 * `await import("@pierre/diffs")`.
 */
// oxlint-disable-next-line anti-slop/no-module-mocking -- @pierre/diffs is a third-party rendering library with no DI seam patchdesk owns; `preloadHighlighter` loads a WASM-backed syntax highlighter that jsdom cannot run, so it is the one method stubbed here while every other export passes through real.
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof PierreDiffs>();
  return { ...actual, preloadHighlighter: vi.fn(async () => undefined) };
});
