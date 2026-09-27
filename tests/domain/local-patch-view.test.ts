import { describe, expect, it } from "vitest";

import {
  indexPatchHunks,
  listPatchTouchedPaths,
  placeInView,
  type LocalNoteLocation,
  type LocalPatchView,
  type LocalPatchViewPaths,
} from "../../src/domain/local-patch-view";

/** A one-hunk patch replacing line 5 of a 20-line file; the hunk shows lines 2 to 8 on both sides. */
function lineFiveChanged(path: string, from: string, to: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -2,7 +2,7 @@",
    " line 2",
    " line 3",
    " line 4",
    `-${from}`,
    `+${to}`,
    " line 6",
    " line 7",
    " line 8",
    "",
  ].join("\n");
}

/**
 * A branch whose commit changed `a.ts` and `c.ts`, and whose uncommitted
 * edits change `b.ts` and undo the `c.ts` change: Combined shows `a.ts` and
 * `b.ts`, Committed `a.ts` and `c.ts`, Uncommitted `b.ts` and `c.ts`.
 */
const patches = {
  combined:
    lineFiveChanged("a.ts", "line 5", "committed 5") +
    lineFiveChanged("b.ts", "line 5", "uncommitted 5"),
  committed:
    lineFiveChanged("a.ts", "line 5", "committed 5") +
    lineFiveChanged("c.ts", "line 5", "committed 5"),
  uncommitted:
    lineFiveChanged("b.ts", "line 5", "uncommitted 5") +
    lineFiveChanged("c.ts", "committed 5", "line 5"),
} satisfies Record<LocalPatchView, string>;

function pathsOf(
  views: Readonly<Record<LocalPatchView, string>>,
): LocalPatchViewPaths {
  return {
    combined: listPatchTouchedPaths(views.combined),
    committed: listPatchTouchedPaths(views.committed),
    uncommitted: listPatchTouchedPaths(views.uncommitted),
  };
}

function place(
  note: LocalNoteLocation,
  view: LocalPatchView,
  views: Readonly<Record<LocalPatchView, string>> = patches,
) {
  return placeInView(note, view, {
    paths: pathsOf(views),
    shownHunks: indexPatchHunks(views[view]),
  });
}

const lineFive = { startLine: 5, line: 5 };
const inline = (side: "new" | "old") => ({
  placement: "inline",
  side,
  ...lineFive,
});
const notInline = (reason: "tree_not_in_view" | "outside_hunk") => ({
  placement: "not_inline",
  reason,
});

describe("placing a note in a patch view", () => {
  it.each<
    [
      string,
      LocalNoteLocation,
      LocalPatchView,
      ReturnType<typeof inline> | ReturnType<typeof notInline>,
    ]
  >([
    [
      "an Uncommitted new-side note on Combined's new side, the same snapshot tree",
      { view: "uncommitted", path: "b.ts", side: "new", ...lineFive },
      "combined",
      inline("new"),
    ],
    [
      "an Uncommitted new-side note on Committed's new side, HEAD, where the file differs",
      { view: "uncommitted", path: "b.ts", side: "new", ...lineFive },
      "committed",
      notInline("tree_not_in_view"),
    ],
    [
      "an Uncommitted old-side note on Combined's old side, the merge base, which holds the same file as HEAD",
      { view: "uncommitted", path: "b.ts", side: "old", ...lineFive },
      "combined",
      inline("old"),
    ],
    [
      "an Uncommitted old-side note on Committed's old side, the same file but no hunk of it",
      { view: "uncommitted", path: "b.ts", side: "old", ...lineFive },
      "committed",
      notInline("outside_hunk"),
    ],
    [
      "a Committed new-side note on Combined's new side, the snapshot, which holds the same file as HEAD",
      { view: "committed", path: "a.ts", side: "new", ...lineFive },
      "combined",
      inline("new"),
    ],
    [
      "a Committed new-side note on Uncommitted's new side, the same file but no hunk of it",
      { view: "committed", path: "a.ts", side: "new", ...lineFive },
      "uncommitted",
      notInline("outside_hunk"),
    ],
    [
      "a Combined old-side note on Committed's old side, the same merge base tree",
      { path: "a.ts", side: "old", ...lineFive },
      "committed",
      inline("old"),
    ],
    [
      "a Combined old-side note on Uncommitted's old side, HEAD, where the file differs",
      { path: "a.ts", side: "old", ...lineFive },
      "uncommitted",
      notInline("tree_not_in_view"),
    ],
    [
      "a Combined new-side note on Committed's new side, HEAD, which holds the same file as the snapshot",
      { path: "a.ts", side: "new", ...lineFive },
      "committed",
      inline("new"),
    ],
    [
      "a Combined new-side note on Uncommitted's new side, the same snapshot tree",
      { path: "b.ts", side: "new", ...lineFive },
      "uncommitted",
      inline("new"),
    ],
  ])("places %s", (_case, note, view, expected) => {
    expect(place(note, view)).toEqual(expected);
  });

  it("does not place lines outside every hunk of the shown view", () => {
    expect(
      place({ path: "b.ts", side: "new", startLine: 12, line: 12 }, "combined"),
    ).toEqual(notInline("outside_hunk"));
  });

  it("does not place a range whose ends sit in two different hunks", () => {
    const twoHunks = [
      "diff --git a/d.ts b/d.ts",
      "--- a/d.ts",
      "+++ b/d.ts",
      "@@ -2,3 +2,3 @@",
      " line 2",
      "-line 3",
      "+changed 3",
      " line 4",
      "@@ -10,3 +10,3 @@",
      " line 10",
      "-line 11",
      "+changed 11",
      " line 12",
      "",
    ].join("\n");
    const views = { combined: twoHunks, committed: twoHunks, uncommitted: "" };

    expect(
      place(
        { path: "d.ts", side: "new", startLine: 3, line: 11 },
        "combined",
        views,
      ),
    ).toEqual(notInline("outside_hunk"));
    expect(
      place(
        { path: "d.ts", side: "new", startLine: 10, line: 12 },
        "combined",
        views,
      ),
    ).toEqual({ placement: "inline", side: "new", startLine: 10, line: 12 });
  });

  it("keeps a snapshot note on a reversed edit off Combined, which is empty, and off Committed's sides", () => {
    const reversed = {
      combined: "",
      committed: lineFiveChanged("c.ts", "line 5", "committed 5"),
      uncommitted: lineFiveChanged("c.ts", "committed 5", "line 5"),
    };
    const note: LocalNoteLocation = {
      view: "uncommitted",
      path: "c.ts",
      side: "new",
      ...lineFive,
    };

    expect(place(note, "uncommitted", reversed)).toEqual(inline("new"));
    expect(place(note, "combined", reversed)).toEqual(
      notInline("outside_hunk"),
    );
    // Committed's old side is the merge base, which holds the same c.ts as the snapshot, but a note never crosses sides.
    expect(place(note, "committed", reversed)).toEqual(
      notInline("tree_not_in_view"),
    );
  });
});

describe("the paths a view's patch touches", () => {
  it("lists a renamed file under both names, and deleted and binary files", () => {
    const patch = [
      "diff --git a/old-name.ts b/new-name.ts",
      "similarity index 90%",
      "rename from old-name.ts",
      "rename to new-name.ts",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");

    expect(listPatchTouchedPaths(patch)).toEqual([
      "gone.ts",
      "logo.png",
      "new-name.ts",
      "old-name.ts",
    ]);
  });
});
