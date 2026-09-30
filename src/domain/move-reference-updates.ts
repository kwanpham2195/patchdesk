import type { PatchChangedFile } from "./patch-changed-files";
import { tokenizeUnifiedPatch } from "./unified-patch";

/*
 * A move makes every importer of the moved code change too. In Go the edit
 * reaches past the import block: `sharedmocks.NewRepo(t)` becomes
 * `bulkupdatemocks.NewRepo(t)` because the package qualifier follows the
 * import. Counting those files with the move keeps a package move from
 * reading as a pull request that edits a hundred files (#718).
 */

/** The changed lines of one file the patch edits in place: not added, removed, or renamed. */
type EditedFile = {
  readonly path: string;
  readonly removed: Array<string>;
  readonly added: Array<string>;
};

/** Languages whose import and qualifier rules this module knows; any other file is a real change. */
const REFERENCE_UPDATE_EXTENSIONS = [
  ".go",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const IMPORT_SPECIFIER = /['"]([^'"]+)['"]/;

const QUALIFIER_PLACEHOLDER = "\u0000";

/** `alias "path"`, `_ "path"`, or `"path"`: one spec inside a Go import block. */
const GO_IMPORT_SPEC = /^(?:([A-Za-z_]\w*|\.)\s+)?"([^"\s]+)"$/;
const GO_IMPORT_LINE = /^import\s+(?:([A-Za-z_]\w*|\.)\s+)?"([^"\s]+)"$/;
const GO_IMPORT_BLOCK_EDGE = /^(?:import\s*\(|\))$/;
const GO_PACKAGE_CLAUSE = /^package\s+\w+$/;
/** An ECMAScript import or re-export line with a string specifier. */
const MODULE_IMPORT_LINE =
  /^import\s+['"][^'"]+['"];?$|^(?:import|export)\b[^'"]*\bfrom\s*['"][^'"]+['"];?$|^\}\s*from\s*['"][^'"]+['"];?$/;
const MODULE_DEFAULT_OR_NAMESPACE =
  /^import\s+(?:type\s+)?(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)/;

/**
 * How many Go or JavaScript-family files this patch edits only to follow a
 * move: the file swaps at least one import for one that points into a
 * directory a renamed file moved to, and every other changed line matches its
 * removed counterpart, in order, once the package qualifiers those import
 * changes rename are set aside. A file that only adds an import or export, a
 * file in another language, and a file the patch adds, removes, or renames
 * are never counted.
 */
export function countMoveReferenceUpdates(
  patch: string,
  changedFiles: ReadonlyArray<PatchChangedFile>,
): number {
  const movedTo = new Set<string>();
  for (const file of changedFiles) {
    if (file.previousPath === undefined) continue;
    const to = directoryOf(file.path);
    if (to !== directoryOf(file.previousPath) && to !== "") movedTo.add(to);
  }
  if (movedTo.size === 0) return 0;
  let count = 0;
  for (const file of editedFiles(patch))
    if (isReferenceUpdate(file, movedTo)) count += 1;
  return count;
}

function editedFiles(patch: string): ReadonlyArray<EditedFile> {
  const files: Array<EditedFile> = [];
  let current: (EditedFile & { skipped: boolean }) | undefined;
  for (const token of tokenizeUnifiedPatch(patch)) {
    if (token.kind === "file_header") {
      if (current !== undefined && !current.skipped) files.push(current);
      const path = token.newPath ?? "";
      current = {
        path,
        removed: [],
        added: [],
        skipped: !REFERENCE_UPDATE_EXTENSIONS.some((extension) =>
          path.endsWith(extension),
        ),
      };
    } else if (current === undefined) continue;
    else if (token.kind === "old_file_path" || token.kind === "new_file_path")
      current.skipped ||= token.path === "/dev/null";
    // A renamed file is counted with the move already.
    else if (token.kind === "rename_from") current.skipped = true;
    else if (token.kind === "body" && token.marker === "removed")
      current.removed.push(token.text.trim());
    else if (token.kind === "body" && token.marker === "added")
      current.added.push(token.text.trim());
  }
  if (current !== undefined && !current.skipped) files.push(current);
  return files;
}

function isReferenceUpdate(
  file: EditedFile,
  movedTo: ReadonlySet<string>,
): boolean {
  const removedImports = file.removed.filter(isImportLine);
  const addedImports = file.added.filter(isImportLine);
  if (removedImports.length === 0 || addedImports.length === 0) return false;
  if (
    !addedImports.some((line) => pointsIntoMovedDirectory(line, file, movedTo))
  )
    return false;
  const qualifiers = new Set([
    ...removedImports.flatMap(importQualifiers),
    ...addedImports.flatMap(importQualifiers),
  ]);
  const normalize = (lines: ReadonlyArray<string>) =>
    lines.flatMap((line) =>
      line === "" || isImportLine(line)
        ? []
        : [withoutQualifiers(line, qualifiers)],
    );
  const removed = normalize(file.removed);
  const added = normalize(file.added);
  return (
    removed.length === added.length &&
    removed.every((line, index) => line === added[index])
  );
}

/**
 * Whether an import's specifier names a directory a file moved to: a Go
 * module path ending in it, or a relative module path that resolves into it.
 */
function pointsIntoMovedDirectory(
  line: string,
  file: EditedFile,
  movedTo: ReadonlySet<string>,
): boolean {
  const specifier = IMPORT_SPECIFIER.exec(line)?.[1];
  if (specifier === undefined) return false;
  const resolved = specifier.startsWith(".")
    ? resolveRelative(directoryOf(file.path), specifier)
    : specifier;
  const wrapped = `/${resolved}/`;
  for (const directory of movedTo)
    if (wrapped.includes(`/${directory}`)) return true;
  return false;
}

/** `dir/` for `dir/name`; `""` at the repository root. */
function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

function resolveRelative(directory: string, specifier: string): string {
  const parts = directory.split("/").filter((part) => part !== "");
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}

function isImportLine(line: string): boolean {
  return (
    GO_IMPORT_SPEC.test(line) ||
    GO_IMPORT_LINE.test(line) ||
    GO_IMPORT_BLOCK_EDGE.test(line) ||
    GO_PACKAGE_CLAUSE.test(line) ||
    MODULE_IMPORT_LINE.test(line)
  );
}

/** The identifiers an import line lets the file's code write before a `.`. */
function importQualifiers(line: string): ReadonlyArray<string> {
  const go = GO_IMPORT_SPEC.exec(line) ?? GO_IMPORT_LINE.exec(line);
  if (go !== null) {
    const alias = go[1];
    if (alias === "_" || alias === ".") return [];
    return [alias ?? go[2]?.split("/").at(-1) ?? ""].filter(
      (name) => name !== "",
    );
  }
  const module = MODULE_DEFAULT_OR_NAMESPACE.exec(line);
  return module?.[1] === undefined ? [] : [module[1]];
}

function withoutQualifiers(line: string, qualifiers: ReadonlySet<string>) {
  let result = line;
  for (const qualifier of qualifiers)
    result = result.replace(
      new RegExp(`(?<![\\w$.])${escapeRegExp(qualifier)}\\.`, "g"),
      `${QUALIFIER_PLACEHOLDER}.`,
    );
  return result;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
