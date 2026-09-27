import { tokenizeUnifiedPatch } from "./unified-patch";

/**
 * One of the three patches a local Review session holds (ADR 0050): Combined
 * runs merge base to Local snapshot, Committed merge base to checkout `HEAD`,
 * Uncommitted checkout `HEAD` to Local snapshot.
 */
export type LocalPatchView = "combined" | "committed" | "uncommitted";

/** A draft's origin view as stored: absent means Combined. */
export type StoredLocalPatchView = Exclude<LocalPatchView, "combined">;

/** A tree a local Review session captured. */
type SessionTree = "merge_base" | "head" | "snapshot";

type DiffSide = "new" | "old";

const viewTrees = {
  combined: { old: "merge_base", new: "snapshot" },
  committed: { old: "merge_base", new: "head" },
  uncommitted: { old: "head", new: "snapshot" },
} as const satisfies Record<LocalPatchView, Record<DiffSide, SessionTree>>;

/** The view whose patch runs between two different session trees; each pair of trees has exactly one. */
function viewBetween(left: SessionTree, right: SessionTree): LocalPatchView {
  const trees = new Set([left, right]);
  if (!trees.has("snapshot")) return "committed";
  return trees.has("merge_base") ? "combined" : "uncommitted";
}

/**
 * Every path each view's patch touches, old and new side: a renamed file's
 * old path, a deleted file, and a binary file all count. A path absent from a
 * view's list has identical content in that view's two trees.
 */
export type LocalPatchViewPaths = Readonly<
  Record<LocalPatchView, ReadonlyArray<string>>
>;

/** The paths one patch touches on either side, the list `LocalPatchViewPaths` holds per view. */
export function listPatchTouchedPaths(patch: string): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const token of tokenizeUnifiedPatch(patch)) {
    if (token.kind === "file_header") {
      if (token.oldPath !== undefined) paths.add(token.oldPath);
      if (token.newPath !== undefined) paths.add(token.newPath);
    } else if (token.kind === "rename_from" || token.kind === "rename_to")
      paths.add(token.path);
  }
  return [...paths].sort();
}

/** The hunk line ranges of one patch, per path and side, built once for every note placed in it. */
export type PatchHunkIndex = ReadonlyMap<
  string,
  ReadonlyArray<{ readonly first: number; readonly last: number }>
>;

/** Index the shown view's patch by path and side; a pure addition has no old-side range. */
export function indexPatchHunks(patch: string): PatchHunkIndex {
  const index = new Map<string, Array<{ first: number; last: number }>>();
  const add = (path: string, side: DiffSide, start: number, count: number) => {
    if (path === "/dev/null" || count === 0) return;
    const key = hunkKey(path, side);
    const ranges = index.get(key) ?? [];
    ranges.push({ first: start, last: start + count - 1 });
    index.set(key, ranges);
  };
  let oldPath = "";
  let newPath = "";
  for (const token of tokenizeUnifiedPatch(patch)) {
    if (token.kind === "file_header") {
      oldPath = token.oldPath ?? "";
      newPath = token.newPath ?? "";
    } else if (token.kind === "old_file_path") oldPath = token.path;
    else if (token.kind === "new_file_path") newPath = token.path;
    else if (token.kind === "hunk_header") {
      add(oldPath, "old", token.range.oldStart, token.range.oldLines);
      add(newPath, "new", token.range.newStart, token.range.newLines);
    }
  }
  return index;
}

function hunkKey(path: string, side: DiffSide): string {
  return `${side}\u0000${path}`;
}

/** Where a note sits: its origin view (absent means Combined), and its path, side, and lines there. */
export type LocalNoteLocation = {
  readonly view?: LocalPatchView;
  readonly path: string;
  readonly side: DiffSide;
  readonly startLine: number;
  readonly line: number;
};

/**
 * Where a note renders inline in one view, or why it does not. A note never
 * crosses sides; its lines keep their numbers, because another view's side
 * shows the note only when that side's tree holds the same file content.
 */
export type LocalNotePlacement =
  | {
      readonly placement: "inline";
      readonly side: DiffSide;
      readonly startLine: number;
      readonly line: number;
    }
  | {
      readonly placement: "not_inline";
      /** `tree_not_in_view`: the view's side holds different file content; `outside_hunk`: same content, but no single hunk of the view shows the lines. */
      readonly reason: "tree_not_in_view" | "outside_hunk";
    };

/**
 * Place a note of the current session in `view` (ADR 0051, #556 D1). The
 * same-content test reads only each view's touched paths, and the hunk test
 * only the shown view's hunk index, so placement never waits on another
 * view's patch. A range must sit inside one hunk (#552).
 */
export function placeInView(
  note: LocalNoteLocation,
  view: LocalPatchView,
  patches: {
    readonly paths: LocalPatchViewPaths;
    readonly shownHunks: PatchHunkIndex;
  },
): LocalNotePlacement {
  const noteTree = viewTrees[note.view ?? "combined"][note.side];
  const shownTree = viewTrees[view][note.side];
  if (
    noteTree !== shownTree &&
    patches.paths[viewBetween(noteTree, shownTree)].includes(note.path)
  )
    return { placement: "not_inline", reason: "tree_not_in_view" };
  const inOneHunk = (
    patches.shownHunks.get(hunkKey(note.path, note.side)) ?? []
  ).some((range) => range.first <= note.startLine && note.line <= range.last);
  return inOneHunk
    ? {
        placement: "inline",
        side: note.side,
        startLine: note.startLine,
        line: note.line,
      }
    : { placement: "not_inline", reason: "outside_hunk" };
}
