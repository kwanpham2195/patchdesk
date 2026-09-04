import { describe, expect, it } from "vitest";

import {
  classifyDiffFence,
  classifyDiffLine,
  fencedCodeLanguage,
} from "../../src/renderer/src/markdown-code-fence";

describe("fenced code language", () => {
  it("takes the first word of the info string, lower-cased", () => {
    expect(fencedCodeLanguage("ts")).toBe("ts");
    expect(fencedCodeLanguage("TypeScript")).toBe("typescript");
    expect(fencedCodeLanguage("JSONL")).toBe("jsonl");
    expect(fencedCodeLanguage("ts copy showLineNumbers")).toBe("ts");
    expect(fencedCodeLanguage("  diff  ")).toBe("diff");
  });

  it("has no language for a bare fence", () => {
    expect(fencedCodeLanguage(undefined)).toBeUndefined();
    expect(fencedCodeLanguage("")).toBeUndefined();
    expect(fencedCodeLanguage("   ")).toBeUndefined();
  });
});

describe("diff fence line classification", () => {
  it("reads a header marker before the single-character change markers", () => {
    expect(classifyDiffLine("+++ b/src/app.ts")).toBe("meta");
    expect(classifyDiffLine("--- a/src/app.ts")).toBe("meta");
    expect(classifyDiffLine("@@ -1,4 +1,6 @@")).toBe("meta");
    expect(classifyDiffLine("diff --git a/src/app.ts b/src/app.ts")).toBe(
      "meta",
    );
    expect(classifyDiffLine("index e69de29..8b13789 100644")).toBe("meta");
  });

  it("classifies a bare marker with no content after it", () => {
    expect(classifyDiffLine("+")).toBe("added");
    expect(classifyDiffLine("-")).toBe("removed");
  });

  it("leaves an empty line and indented content as context", () => {
    expect(classifyDiffLine("")).toBe("context");
    expect(classifyDiffLine("   required:")).toBe("context");
    // A leading space is a diff's own context marker, so the "+" that follows
    // it belongs to the line's content and must not tint the line green.
    expect(classifyDiffLine(" +optional")).toBe("context");
    expect(classifyDiffLine(" -optional")).toBe("context");
  });

  it("treats content that is not a diff at all as context", () => {
    for (const line of [
      "function add(a, b) {",
      "  return a + b;",
      "}",
      "SELECT * FROM users WHERE id = 1;",
    ]) {
      expect(classifyDiffLine(line)).toBe("context");
    }
  });

  it("classifies a real header-less fence from a comment body", () => {
    const fence = [
      " ListOrganizationsResponse:",
      "   required:",
      "     - id",
      "+    - flow",
      "   properties:",
      "-    legacy:",
      "",
    ].join("\n");

    expect(classifyDiffFence(fence)).toEqual([
      { text: " ListOrganizationsResponse:", kind: "context" },
      { text: "   required:", kind: "context" },
      { text: "     - id", kind: "context" },
      { text: "+    - flow", kind: "added" },
      { text: "   properties:", kind: "context" },
      { text: "-    legacy:", kind: "removed" },
      { text: "", kind: "context" },
    ]);
  });
});
