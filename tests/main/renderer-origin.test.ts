import { describe, expect, it } from "vitest";

import { rendererSource } from "../../src/main/renderer-origin";

describe("rendererSource", () => {
  it("loads the development server URL and trusts its origin in development", () => {
    expect(
      rendererSource(
        { ELECTRON_RENDERER_URL: "http://localhost:5173/review?id=42" },
        false,
      ),
    ).toEqual({
      url: "http://localhost:5173/review?id=42",
      origin: "http://localhost:5173",
    });
  });

  it("fails closed for missing or malformed runtime input", () => {
    expect(rendererSource({}, false).origin).toBe("null");
    expect(
      rendererSource({ ELECTRON_RENDERER_URL: "not a URL" }, false).origin,
    ).toBe("null");
  });

  it("ignores ELECTRON_RENDERER_URL in the packaged app", () => {
    expect(
      rendererSource(
        { ELECTRON_RENDERER_URL: "https://attacker.example/" },
        true,
      ),
    ).toEqual({ url: undefined, origin: "null" });
  });
});
