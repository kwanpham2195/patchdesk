import { describe, expect, it } from "vitest";

import {
  isPaneTooNarrowForSplit,
  SPLIT_VIEW_MIN_PANE_WIDTH,
} from "../../src/renderer/src/hooks/use-split-view-fallback";

describe("split view pane width threshold", () => {
  it.each([
    ["an unmeasured pane keeps the saved style", 0, false],
    [
      "a pane one pixel short of the threshold falls back",
      SPLIT_VIEW_MIN_PANE_WIDTH - 1,
      true,
    ],
    ["a pane at the threshold keeps split", SPLIT_VIEW_MIN_PANE_WIDTH, false],
  ])("%s", (_name, width, tooNarrow) => {
    expect(isPaneTooNarrowForSplit(width)).toBe(tooNarrow);
  });
});
