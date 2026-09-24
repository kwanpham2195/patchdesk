import { describe, expect, it } from "vitest";

import { patchesAgreeAtAnchor } from "../../src/domain/diff-anchor";
import { parseRepoRelativePath } from "../../src/domain/ids";

const path = parseRepoRelativePath("src/a.ts");
if (path._tag === "err") throw new Error("unusable test path");
const anchor = {
  path: path.value,
  side: "new" as const,
  startLine: 3,
  line: 3,
};

function patch(body: string): string {
  return `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${body}`;
}

describe("patchesAgreeAtAnchor", () => {
  it.each([
    {
      name: "a matching line whose neighbour differs is a different place",
      shown: patch("@@ -1,2 +1,3 @@\n one\n+two\n }\n"),
      target: patch("@@ -1,2 +1,3 @@\n one\n+changed\n }\n"),
      agree: false,
    },
    {
      name: "a neighbour only one hunk shows does not count against the match",
      shown: patch("@@ -2,1 +2,2 @@\n+two\n }\n"),
      target: patch("@@ -1,2 +1,3 @@\n one\n+two\n }\n"),
      agree: true,
    },
  ])("$name", ({ shown, target, agree }) => {
    expect(patchesAgreeAtAnchor(shown, target, anchor)).toBe(agree);
  });
});
