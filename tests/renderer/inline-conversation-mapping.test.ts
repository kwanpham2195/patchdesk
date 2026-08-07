import { describe, expect, it } from "vitest";

import { parseUnifiedPatch } from "../../src/domain/patch";
import { mapConversationThread } from "../../src/renderer/src/inline-conversation-mapping";

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

function thread(input: {
  readonly state?: "open" | "resolved" | "outdated";
  readonly start?: number;
  readonly end?: number;
  readonly side?: "new" | "old";
} = {}) {
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
    expect(mapConversationThread(patch, thread({ state: "outdated" }))).toEqual({
      _tag: "Excluded",
      reason: "outdated",
    });
    expect(mapConversationThread(patch, thread({ start: 1, end: 5 }))).toEqual({
      _tag: "Excluded",
      reason: "unmapped",
    });
  });
});
