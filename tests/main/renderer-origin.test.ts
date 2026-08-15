import { describe, expect, it } from "vitest";

import { rendererOrigin } from "../../src/main/renderer-origin";

describe("rendererOrigin", () => {
  it("returns the origin for an absolute renderer URL", () => {
    expect(rendererOrigin("http://localhost:5173/review?id=42")).toBe(
      "http://localhost:5173",
    );
  });

  it("fails closed for missing or malformed runtime input", () => {
    expect(rendererOrigin(undefined)).toBe("null");
    expect(rendererOrigin("not a URL")).toBe("null");
  });
});
