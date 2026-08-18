import { describe, expect, it } from "vitest";
import { labelForeground } from "../../src/renderer/src/label-color";

describe("labelForeground", () => {
  it("picks black text on a light background", () => {
    expect(labelForeground("ffffff")).toBe("#000000");
    expect(labelForeground("d4c5f9")).toBe("#000000"); // GitHub's default "enhancement" purple
    // GitHub's default "bug" red (d73a4a) has a WCAG contrast ratio of ~4.60
    // against black versus ~4.57 against white — black wins, if only just.
    expect(labelForeground("d73a4a")).toBe("#000000");
  });
  it("picks white text on a dark background", () => {
    expect(labelForeground("000000")).toBe("#ffffff");
    expect(labelForeground("0075ca")).toBe("#ffffff"); // GitHub's default "documentation" blue
  });
  it("accepts a leading # and is defensive against malformed input", () => {
    expect(labelForeground("#ffffff")).toBe("#000000");
    expect(labelForeground("not-a-color")).toBe("#000000");
    expect(labelForeground("")).toBe("#000000");
  });
});
