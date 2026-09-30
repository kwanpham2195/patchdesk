import { isUnchangedRename } from "./brief-ownership";
import { comparePaths, type PatchChangedFile } from "./patch-changed-files";

/*
 * The Brief reader draws this block as "Moves": which directories a patch
 * moved, computed from git's rename pairs. The model never writes it, because
 * a pure rename has no hunk to cite and a model-drawn move map would read as
 * unverified (see issue #713).
 */

/**
 * One moved directory pair. `from` and `to` are directory prefixes ending in
 * `/`, or `""` for the repository root. When `names` is above one, the row
 * merges that many pairs that differ only in one repeated segment, written
 * as `<name>`, such as `job/<name>/` to `deploy/<name>/`.
 */
type BriefMoveRow = {
  readonly from: string;
  readonly to: string;
  readonly files: number;
  /** Moved files whose content the patch also changed. */
  readonly editedFiles: number;
  readonly names: number;
};

/** The Moves block. */
export type BriefMoves = {
  readonly rows: ReadonlyArray<BriefMoveRow>;
  /** Rows past `MAX_MOVE_ROWS`, left out of `rows`. */
  readonly hiddenRows: number;
  /** Renamed files whose directory changed. */
  readonly movedFiles: number;
  /** Moved files outnumber every other kind of change, so the reader draws Moves before Flow. */
  readonly leads: boolean;
};

const MAX_MOVE_ROWS = 6;
/** A single moved file is a rename worth reading in the diff, not a layout change. */
const MIN_MOVED_FILES = 2;
const NAME_PLACEHOLDER = "<name>";

type MutableMoveRow = {
  from: string;
  to: string;
  files: number;
  editedFiles: number;
  names: number;
};

/**
 * The Moves block for one patch's changed files, or `undefined` when fewer
 * than `MIN_MOVED_FILES` renamed files changed directory. A rename inside one
 * directory is not a move.
 */
export function briefMoves(
  files: ReadonlyArray<PatchChangedFile>,
): BriefMoves | undefined {
  const pairs = new Map<string, MutableMoveRow>();
  let movedFiles = 0;
  for (const file of files) {
    if (file.previousPath === undefined) continue;
    const pair = movedDirectories(file.previousPath, file.path);
    if (pair === undefined) continue;
    movedFiles += 1;
    const key = `${pair.from}\n${pair.to}`;
    const row = pairs.get(key) ?? {
      ...pair,
      files: 0,
      editedFiles: 0,
      names: 1,
    };
    row.files += 1;
    if (!isUnchangedRename(file)) row.editedFiles += 1;
    pairs.set(key, row);
  }
  if (movedFiles < MIN_MOVED_FILES) return undefined;
  const rows = mergeNamedRows([...pairs.values()]).sort(
    (left, right) =>
      right.files - left.files || comparePaths(left.from, right.from),
  );
  const otherChanges = { added: 0, removed: 0, modified: 0 };
  for (const file of files)
    if (file.status !== "renamed") otherChanges[file.status] += 1;
  return {
    rows: rows.slice(0, MAX_MOVE_ROWS),
    hiddenRows: Math.max(0, rows.length - MAX_MOVE_ROWS),
    movedFiles,
    leads: Object.values(otherChanges).every((count) => movedFiles > count),
  };
}

/**
 * The changed-file facts a Brief prompt carries, so the model sees the move
 * without reading every rename header in the patch.
 */
export function renderBriefPatchFacts(
  files: ReadonlyArray<PatchChangedFile>,
  moves: BriefMoves | undefined,
): string {
  const counts = { renamed: 0, modified: 0, added: 0, removed: 0 };
  for (const file of files) counts[file.status] += 1;
  const summary = Object.entries(counts)
    .flatMap(([status, count]) => (count > 0 ? [`${count} ${status}`] : []))
    .join(", ");
  const lines = [`Changed files: ${files.length} (${summary}).`];
  if (moves === undefined) return lines.join("\n");
  lines.push(
    "Moved directories, which Patchdesk draws in its own Moves block:",
    ...moves.rows.map(
      (row) =>
        `- ${displayDirectory(row.from)} -> ${displayDirectory(row.to)}: ${row.files} ${row.files === 1 ? "file" : "files"}${row.names > 1 ? ` across ${row.names} names` : ""}, ${row.editedFiles} also edited`,
    ),
  );
  if (moves.hiddenRows > 0)
    lines.push(`- ${moreMovedDirectories(moves.hiddenRows)}`);
  return lines.join("\n");
}

/** The counted remainder line for Moves rows past the cap. */
export function moreMovedDirectories(count: number): string {
  return `${count} more moved ${count === 1 ? "directory" : "directories"}`;
}

/** How a Moves directory reads: the repository root is `./`. */
export function displayDirectory(directory: string): string {
  return directory === "" ? "./" : directory;
}

/**
 * The directory pair one rename moved between, with the directories both
 * sides share at the end removed, so `api/cmd/testdata/a.json` to
 * `cmd/api/testdata/a.json` reads as `api/cmd/` to `cmd/api/`. `undefined`
 * when the file stayed in its directory.
 */
function movedDirectories(
  previousPath: string,
  path: string,
): { readonly from: string; readonly to: string } | undefined {
  const previous = previousPath.split("/").slice(0, -1);
  const next = path.split("/").slice(0, -1);
  if (previous.join("/") === next.join("/")) return undefined;
  // Stop before a side runs out: `api/` to `deploy/api/` must not read as
  // the root moving into `deploy/`.
  while (
    previous.length > 1 &&
    next.length > 1 &&
    previous.at(-1) === next.at(-1)
  ) {
    previous.pop();
    next.pop();
  }
  return { from: directoryPrefix(previous), to: directoryPrefix(next) };
}

function directoryPrefix(segments: ReadonlyArray<string>): string {
  return segments.length === 0 ? "" : `${segments.join("/")}/`;
}

/**
 * Merges rows that differ only in one segment appearing once on each side,
 * such as `job/a/` to `deploy/a/` and `job/b/` to `deploy/b/`, into one
 * `<name>` row. A row with no partner stays as it is.
 */
function mergeNamedRows(
  rows: ReadonlyArray<MutableMoveRow>,
): Array<MutableMoveRow> {
  const groups = new Map<string, Array<MutableMoveRow>>();
  const unnamed: Array<MutableMoveRow> = [];
  for (const row of rows) {
    const template = namedTemplate(row);
    if (template === undefined) {
      unnamed.push(row);
      continue;
    }
    const key = `${template.from}\n${template.to}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const merged = [...unnamed];
  for (const [key, group] of groups) {
    if (group.length === 1) {
      merged.push(...group);
      continue;
    }
    const [from = "", to = ""] = key.split("\n");
    merged.push({
      from,
      to,
      files: group.reduce((sum, row) => sum + row.files, 0),
      editedFiles: group.reduce((sum, row) => sum + row.editedFiles, 0),
      names: group.length,
    });
  }
  return merged;
}

/** The row with its repeated segment replaced by `<name>`, or `undefined` when no segment repeats once on each side. */
function namedTemplate(
  row: MutableMoveRow,
): { readonly from: string; readonly to: string } | undefined {
  const from = row.from.split("/").filter((segment) => segment !== "");
  const to = row.to.split("/").filter((segment) => segment !== "");
  const name = from.find(
    (segment) => countOf(from, segment) === 1 && countOf(to, segment) === 1,
  );
  if (name === undefined) return undefined;
  const replace = (segments: ReadonlyArray<string>) =>
    directoryPrefix(
      segments.map((segment) =>
        segment === name ? NAME_PLACEHOLDER : segment,
      ),
    );
  return { from: replace(from), to: replace(to) };
}

function countOf(segments: ReadonlyArray<string>, value: string): number {
  return segments.filter((segment) => segment === value).length;
}
