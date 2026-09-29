import { describe, expect, it, vi } from "vitest";

import { createHeadSideCommentAuthoring } from "../../src/renderer/src/components/review-workbench-pull-request";

// The pull request diff has two hunks; a head commit's own hunk can span the unchanged lines between them.
const FULL_PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " line 1",
  "+added 2",
  " line 3",
  "@@ -9,2 +10,3 @@",
  " line 10",
  "+added 11",
  " line 12",
  "",
].join("\n");

function authoring() {
  const onSave = vi.fn(async () => undefined);
  const head = createHeadSideCommentAuthoring(
    { enabled: true, onSave },
    FULL_PATCH,
  );
  if (head === undefined) throw new Error("expected head-side authoring");
  return { head, onSave };
}

describe("createHeadSideCommentAuthoring", () => {
  it("refuses a range across two hunks of the pull request diff and saves nothing", async () => {
    const { head, onSave } = authoring();
    const location = {
      path: "src/a.ts",
      startLine: 2,
      line: 11,
      side: "new",
    } as const;

    expect(head.refuseLocation?.(location)).toEqual(expect.any(String));
    await head.onSave({ ...location, body: "Across hunks" });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("allows a range inside one hunk and saves it with its fingerprint", async () => {
    const { head, onSave } = authoring();
    const location = {
      path: "src/a.ts",
      startLine: 10,
      line: 12,
      side: "new",
    } as const;

    expect(head.refuseLocation?.(location)).toBeUndefined();
    await head.onSave({ ...location, body: "One hunk" });
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        startLine: 10,
        line: 12,
        fingerprint: expect.objectContaining({
          selectedLines: ["line 10", "added 11", "line 12"],
        }),
      }),
    );
  });
});
