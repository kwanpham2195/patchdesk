import { describe, expect, it } from "vitest";

import {
  buildSuggestionPreviewPatch,
  isAcceptableSuggestionCode,
  renderSuggestionCommentBody,
  resolveSuggestionTarget,
  SUGGESTED_REPLACEMENT_MAX_BYTES,
} from "../../src/domain/finding-suggestion";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  " const e = 6;",
  "@@ -20,3 +21,3 @@",
  " const x = 1;",
  "-const y = 2;",
  "+const y = 3;",
  " const z = 4;",
  "",
].join("\n");

describe("resolveSuggestionTarget", () => {
  it("resolves a single cited new-side line to its own patch text", () => {
    expect(
      resolveSuggestionTarget(patch, { file: "src/a.ts", lineStart: 2 }),
    ).toEqual({
      path: "src/a.ts",
      startLine: 2,
      line: 2,
      originalLines: ["const b = 3;"],
    });
  });

  it("returns the exact original lines of a multi-line range", () => {
    expect(
      resolveSuggestionTarget(patch, {
        file: "src/a.ts",
        lineStart: 2,
        lineEnd: 4,
        diffSide: "new",
      })?.originalLines,
    ).toEqual(["const b = 3;", "const c = 4;", "const d = 5;"]);
  });

  it("refuses an old-side finding", () => {
    expect(
      resolveSuggestionTarget(patch, {
        file: "src/a.ts",
        lineStart: 1,
        diffSide: "old",
      }),
    ).toBeUndefined();
  });

  it("refuses a range that crosses two hunks", () => {
    expect(
      resolveSuggestionTarget(patch, {
        file: "src/a.ts",
        lineStart: 5,
        lineEnd: 21,
      }),
    ).toBeUndefined();
  });

  it("refuses a file the patch does not carry", () => {
    expect(
      resolveSuggestionTarget(patch, { file: "src/absent.ts", lineStart: 2 }),
    ).toBeUndefined();
  });

  it("refuses a line no hunk puts on the new side", () => {
    expect(
      resolveSuggestionTarget(patch, { file: "src/a.ts", lineStart: 9 }),
    ).toBeUndefined();
  });
});

describe("buildSuggestionPreviewPatch", () => {
  it("replaces one line with one line", () => {
    expect(
      buildSuggestionPreviewPatch(
        {
          path: "src/a.ts",
          startLine: 2,
          originalLines: ["const b = 3;"],
        },
        "const b = requireFresh();",
      ),
    ).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -2,1 +2,1 @@",
        "-const b = 3;",
        "+const b = requireFresh();",
      ].join("\n"),
    );
  });

  it("keeps a multi-line replacement in one hunk", () => {
    expect(
      buildSuggestionPreviewPatch(
        {
          path: "src/a.ts",
          startLine: 2,
          originalLines: ["const b = 3;", "const c = 4;"],
        },
        "const b = 5;\nconst c = 6;",
      ),
    ).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -2,2 +2,2 @@",
        "-const b = 3;",
        "-const c = 4;",
        "+const b = 5;",
        "+const c = 6;",
      ].join("\n"),
    );
  });

  it("counts a replacement longer than the original", () => {
    expect(
      buildSuggestionPreviewPatch(
        { path: "src/a.ts", startLine: 7, originalLines: ["run();"] },
        "guard();\nrun();\n",
      ),
    ).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -7,1 +7,2 @@",
        "-run();",
        "+guard();",
        "+run();",
      ].join("\n"),
    );
  });

  it("counts a replacement shorter than the original", () => {
    expect(
      buildSuggestionPreviewPatch(
        {
          path: "src/a.ts",
          startLine: 7,
          originalLines: ["if (ready) {", "  run();", "}"],
        },
        "run();",
      ),
    ).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -7,3 +7,1 @@",
        "-if (ready) {",
        "-  run();",
        "-}",
        "+run();",
      ].join("\n"),
    );
  });
});

describe("isAcceptableSuggestionCode", () => {
  it("rejects empty replacement code", () =>
    expect(isAcceptableSuggestionCode("")).toBe(false));

  it("rejects code over the byte limit", () => {
    expect(
      isAcceptableSuggestionCode("a".repeat(SUGGESTED_REPLACEMENT_MAX_BYTES)),
    ).toBe(true);
    expect(
      isAcceptableSuggestionCode(
        "a".repeat(SUGGESTED_REPLACEMENT_MAX_BYTES + 1),
      ),
    ).toBe(false);
  });

  it("counts the limit in UTF-8 bytes, not code units", () => {
    expect(
      isAcceptableSuggestionCode("é".repeat(SUGGESTED_REPLACEMENT_MAX_BYTES)),
    ).toBe(false);
  });

  it("rejects code that opens a Markdown fence", () => {
    expect(isAcceptableSuggestionCode("const a = 1;\n```\n")).toBe(false);
    expect(isAcceptableSuggestionCode("```ts\nconst a = 1;")).toBe(false);
  });

  it("accepts ordinary code", () =>
    expect(isAcceptableSuggestionCode("const a = 1;")).toBe(true));
});

describe("renderSuggestionCommentBody", () => {
  it("puts the trimmed comment above one fenced suggestion block", () => {
    expect(
      renderSuggestionCommentBody(
        "  The stale-head check must run before the mutation.  ",
        "const current = await requireCurrentHead();",
      ),
    ).toBe(
      "The stale-head check must run before the mutation.\n\n```suggestion\nconst current = await requireCurrentHead();\n```",
    );
  });

  it("does not double a newline the replacement already ends with", () => {
    expect(renderSuggestionCommentBody("Fix it.", "const a = 1;\n")).toBe(
      "Fix it.\n\n```suggestion\nconst a = 1;\n```",
    );
  });
});
