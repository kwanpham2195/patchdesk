import { describe, expect, it } from "vitest";

import {
  classifyDiffFence,
  classifyDiffLine,
  fencedCodeLanguage,
} from "../../src/renderer/src/markdown-code-fence";

describe("fenced code language", () => {
  it.each([
    { label: "a short language name", info: "ts", expected: "ts" },
    { label: "mixed case", info: "TypeScript", expected: "typescript" },
    { label: "an uppercase language name", info: "JSONL", expected: "jsonl" },
    {
      label: "options after the language",
      info: "ts copy showLineNumbers",
      expected: "ts",
    },
    { label: "surrounding whitespace", info: "  diff  ", expected: "diff" },
  ])("normalizes $label", ({ info, expected }) => {
    expect(fencedCodeLanguage(info)).toBe(expected);
  });

  it.each([
    { label: "undefined", info: undefined },
    { label: "empty", info: "" },
    { label: "whitespace only", info: "   " },
  ])("has no language for $label info", ({ info }) => {
    expect(fencedCodeLanguage(info)).toBeUndefined();
  });
});

describe("diff fence line classification", () => {
  it.each([
    { label: "added file header", line: "+++ b/src/app.ts" },
    { label: "removed file header", line: "--- a/src/app.ts" },
    { label: "hunk header", line: "@@ -1,4 +1,6 @@" },
    {
      label: "diff header",
      line: "diff --git a/src/app.ts b/src/app.ts",
    },
    { label: "index header", line: "index e69de29..8b13789 100644" },
  ])("classifies $label as metadata", ({ line }) => {
    expect(classifyDiffLine(line)).toBe("meta");
  });

  it.each([
    { label: "addition", line: "+", expected: "added" },
    { label: "removal", line: "-", expected: "removed" },
  ])("classifies a bare $label marker", ({ line, expected }) => {
    expect(classifyDiffLine(line)).toBe(expected);
  });

  it.each([
    { label: "an empty line", line: "" },
    { label: "indented content", line: "   required:" },
    { label: "a context line beginning with plus", line: " +optional" },
    { label: "a context line beginning with minus", line: " -optional" },
  ])("leaves $label as context", ({ line }) => {
    expect(classifyDiffLine(line)).toBe("context");
  });

  it.each([
    "function add(a, b) {",
    "  return a + b;",
    "}",
    "SELECT * FROM users WHERE id = 1;",
  ])("treats non-diff content %j as context", (line) => {
    expect(classifyDiffLine(line)).toBe("context");
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
