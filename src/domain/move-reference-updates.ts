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
  readonly removed: Array<string>;
  readonly added: Array<string>;
};

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
 * How many files this patch edits only to follow a move: every changed line
 * is an import, re-export, or package line, or matches a removed line once
 * the package qualifiers those import changes rename are set aside. A file
 * the patch adds, removes, renames, or edits without a changed import is
 * never one.
 */
export function countMoveReferenceUpdates(patch: string): number {
  let count = 0;
  for (const file of editedFiles(patch))
    if (isReferenceUpdate(file)) count += 1;
  return count;
}

function editedFiles(patch: string): ReadonlyArray<EditedFile> {
  const files: Array<EditedFile> = [];
  let current: (EditedFile & { skipped: boolean }) | undefined;
  for (const token of tokenizeUnifiedPatch(patch)) {
    if (token.kind === "file_header") {
      if (current !== undefined && !current.skipped) files.push(current);
      current = { removed: [], added: [], skipped: false };
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

function isReferenceUpdate(file: EditedFile): boolean {
  const removedImports = file.removed.filter(isImportLine);
  const addedImports = file.added.filter(isImportLine);
  if (removedImports.length === 0 && addedImports.length === 0) return false;
  const qualifiers = new Set([
    ...removedImports.flatMap(importQualifiers),
    ...addedImports.flatMap(importQualifiers),
  ]);
  const normalize = (lines: ReadonlyArray<string>) =>
    lines
      .flatMap((line) =>
        line === "" || isImportLine(line)
          ? []
          : [withoutQualifiers(line, qualifiers)],
      )
      .sort();
  const removed = normalize(file.removed);
  const added = normalize(file.added);
  return (
    removed.length === added.length &&
    removed.every((line, index) => line === added[index])
  );
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
