import { describe, expect, it } from "vitest";

import { parseUnifiedPatch } from "../../src/domain/patch";
import {
  citedHunkRelation,
  mapConversationThread,
  projectReadOnlyConversationAnnotations,
} from "../../src/renderer/src/inline-conversation-mapping";
import { toDiffLineAnnotation } from "../../src/renderer/src/review-diff-annotations";

const patch = parseUnifiedPatch(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
-old one
-old two
+new one
+new two
 context
`);

function thread(
  input: {
    readonly state?: "open" | "resolved" | "outdated";
    readonly start?: number;
    readonly end?: number;
    readonly side?: "new" | "old";
  } = {},
) {
  return {
    id: "thread-1",
    state: input.state ?? "open",
    comments: [],
    location: {
      path: "src/example.ts",
      line: input.start ?? 1,
      lineEnd: input.end ?? 2,
      diffSide: input.side ?? "new",
    },
  } as never;
}

describe("mapConversationThread", () => {
  it("maps an open full range on either diff side", () => {
    expect(mapConversationThread(patch, thread())).toEqual({
      _tag: "Mapped",
      path: "src/example.ts",
      start: 1,
      end: 2,
      side: "new",
    });
    expect(mapConversationThread(patch, thread({ side: "old" }))).toEqual({
      _tag: "Mapped",
      path: "src/example.ts",
      start: 1,
      end: 2,
      side: "old",
    });
  });

  it("excludes outdated and partially mapped ranges", () => {
    expect(mapConversationThread(patch, thread({ state: "outdated" }))).toEqual(
      {
        _tag: "Excluded",
        reason: "outdated",
      },
    );
    expect(mapConversationThread(patch, thread({ start: 1, end: 5 }))).toEqual({
      _tag: "Excluded",
      reason: "unmapped",
    });
  });

  it("anchors a multi-line annotation at its final line in both rendering paths", () => {
    // Both the virtualized CodeView items and the non-virtualized walkthrough
    // line annotations are built through toDiffLineAnnotation; a thread mapped
    // to lines 10-12 must occupy the slot after line 12, not after line 10.
    const annotation = {
      id: "conversation:thread-1",
      path: "src/example.ts",
      start: 10,
      end: 12,
      side: "new" as const,
      severity: "conversation" as const,
      title: "Conversation",
      explanation: "",
    };
    const placed = toDiffLineAnnotation(annotation);
    expect(placed.lineNumber).toBe(12);
    expect(placed.side).toBe("additions");
    // The metadata keeps the full range for title/context rendering.
    expect(placed.metadata).toBe(annotation);
    // A single-line annotation stays on its own line.
    expect(
      toDiffLineAnnotation({ ...annotation, start: 5, end: 5 }).lineNumber,
    ).toBe(5);
  });
});

describe("projectReadOnlyConversationAnnotations", () => {
  it("keeps only current mapped data and classifies exact and partial cited ranges", () => {
    const [annotation] = projectReadOnlyConversationAnnotations(patch, [
      thread({ start: 1, end: 2 }),
    ]);
    expect(annotation).toMatchObject({
      id: "thread-1",
      path: "src/example.ts",
      start: 1,
      end: 2,
      side: "new",
    });
    if (annotation === undefined) throw new Error("fixture");
    expect(
      citedHunkRelation(annotation, {
        path: "src/example.ts",
        newStart: 1,
        newLines: 3,
        oldStart: 1,
        oldLines: 3,
      }),
    ).toBe("exact");
    expect(
      citedHunkRelation(annotation, {
        path: "src/example.ts",
        newStart: 2,
        newLines: 2,
        oldStart: 2,
        oldLines: 2,
      }),
    ).toBe("partial");
  });

  it("excludes outdated and invalid ranges without carrying mutation capability", () => {
    expect(
      projectReadOnlyConversationAnnotations(patch, [
        thread({ state: "outdated" }),
        thread({ start: 1, end: 5 }),
      ]),
    ).toEqual([]);
  });
});
