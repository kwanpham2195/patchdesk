import { tokenizeUnifiedPatch } from "./unified-patch";

/** What the patch did to one changed file. */
export type PatchChangedFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed";

/**
 * One changed file of a patch. `path` is plain text, the new path unless the
 * file was removed, never a path Patchdesk opens.
 */
export type PatchChangedFile = {
  readonly path: string;
  readonly status: PatchChangedFileStatus;
  readonly additions: number;
  readonly deletions: number;
};

/** Where one changed file stands while its patch section is still being read. */
type ChangedFileDraft = {
  oldPath: string;
  newPath: string;
  renamed: boolean;
  /** The old side is `/dev/null`, so the patch creates this file. */
  createdFile: boolean;
  /** The new side is `/dev/null`, so the patch deletes this file. */
  deletedFile: boolean;
  additions: number;
  deletions: number;
};

/** Every file one patch changes, how, and by how many lines, in code-unit path order so two reads agree. */
export function listPatchChangedFiles(
  patch: string,
): ReadonlyArray<PatchChangedFile> {
  const drafts: Array<ChangedFileDraft> = [];
  let current: ChangedFileDraft | undefined;
  for (const token of tokenizeUnifiedPatch(patch)) {
    if (token.kind === "file_header") {
      current = {
        oldPath: token.oldPath ?? "",
        newPath: token.newPath ?? "",
        renamed: false,
        createdFile: false,
        deletedFile: false,
        additions: 0,
        deletions: 0,
      };
      drafts.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (token.kind === "old_file_path")
      current.createdFile = token.path === "/dev/null";
    else if (token.kind === "new_file_path")
      current.deletedFile = token.path === "/dev/null";
    else if (token.kind === "rename_from") {
      current.oldPath = token.path;
      current.renamed = true;
    } else if (token.kind === "rename_to") {
      current.newPath = token.path;
      current.renamed = true;
    } else if (token.kind === "body") {
      if (token.marker === "added") current.additions += 1;
      if (token.marker === "removed") current.deletions += 1;
    }
  }
  return drafts
    .flatMap((draft): ReadonlyArray<PatchChangedFile> => {
      const status = changedFileStatus(draft);
      const path = status === "removed" ? draft.oldPath : draft.newPath;
      return path === ""
        ? []
        : [
            {
              path,
              status,
              additions: draft.additions,
              deletions: draft.deletions,
            },
          ];
    })
    .sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * A file git shows against `/dev/null` on one side was created or deleted
 * whole; a rename is only a rename once neither side is missing.
 */
function changedFileStatus(draft: ChangedFileDraft): PatchChangedFileStatus {
  if (draft.createdFile) return "added";
  if (draft.deletedFile) return "removed";
  return draft.renamed ? "renamed" : "modified";
}

/** Code-unit order, so the list never depends on the reader's locale. */
function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
