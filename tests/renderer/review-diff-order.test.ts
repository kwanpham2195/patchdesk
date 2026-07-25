import { describe, expect, it } from "vitest";

import { compareTreePaths } from "../../src/renderer/src/review-diff-order";

describe("compareTreePaths", () => {
  it("keeps the all-files surface in the file tree's folder-first order", () => {
    const paths = [
      "go.mod",
      "internal/property/property.go",
      "cmd/server/main.go",
      "internal/adapter/adapter.go",
    ];

    expect([...paths].sort(compareTreePaths)).toEqual([
      "cmd/server/main.go",
      "internal/adapter/adapter.go",
      "internal/property/property.go",
      "go.mod",
    ]);
  });
});
