import { describe, expect, it } from "vitest";

import {
  countFindingsByPath,
  describeFileFindingCount,
} from "../../src/renderer/src/review-finding-counts";

describe("countFindingsByPath", () => {
  it("counts mapped findings per file, ignores unmapped ones, and keeps the highest severity", () => {
    const counts = countFindingsByPath([
      { file: "src/a.ts", severity: "P2", mappingStatus: "mapped" },
      { file: "src/a.ts", severity: "P1", mappingStatus: "mapped" },
      { file: "src/b.ts", severity: "P0", mappingStatus: "invalid_line" },
      { file: "src/c.ts", severity: "P3", mappingStatus: "mapped" },
      { severity: "P0", mappingStatus: "unmapped" },
    ]);

    expect(counts.get("src/a.ts")).toEqual({ count: 2, highest: "P1" });
    expect(counts.get("src/c.ts")).toEqual({ count: 1, highest: "P3" });
    expect(counts.has("src/b.ts")).toBe(false);
    expect(counts.size).toBe(2);
  });

  it("names a badge with its count and highest severity", () => {
    expect(describeFileFindingCount({ count: 2, highest: "P1" })).toBe(
      "2 findings, highest P1",
    );
    expect(describeFileFindingCount({ count: 1, highest: "P3" })).toBe(
      "1 finding, highest P3",
    );
  });
});
