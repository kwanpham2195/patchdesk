import * as v from "valibot";

import { classifyChangedPath } from "./change-scope";
import { definedProps } from "./defined-props";
import {
  filterNarrativePatchToHunks,
  narrativeHunkManifest,
} from "./narrative-walkthrough";
import { tokenizeUnifiedPatch } from "./unified-patch";

/*
 * The Brief reader draws this block under the heading "Shape". Every symbol
 * here is named for the question the block answers instead -- who owns what
 * after the change -- because `anti-slop/no-shape-in-symbol-names`
 * (`tools/oxlint/anti-slop`) rejects that word in any identifier. The heading
 * and the JSON key therefore differ on purpose.
 */

/** What the patch did to one changed file. */
type BriefOwnershipStatus = "added" | "removed" | "modified" | "renamed";

/**
 * One file of the deterministic skeleton. `path` is plain text, like
 * `ChangeScopeFile.path`: it is a display line and the key a model note must
 * match, never a path Patchdesk opens.
 */
export type BriefOwnershipFile = {
  readonly path: string;
  readonly status: BriefOwnershipStatus;
  readonly additions: number;
  readonly deletions: number;
};

/** One short model note about what a changed file is responsible for afterwards. */
type BriefOwnershipNote = {
  readonly path: string;
  readonly note: string;
};

/**
 * The one hunk whose signature or type explains the rest of the patch. The
 * model names it by alias and writes the caption; `raw` is cut from the patch
 * by Patchdesk, so the diff a reviewer reads is never model-written text.
 */
type BriefOwnershipContract = {
  readonly path: string;
  readonly header: string;
  /** A complete one-hunk unified patch: the file header, then the hunk. */
  readonly raw: string;
  readonly caption: string;
};

/** The Ownership block: Patchdesk's skeleton, the model's notes, and one contract hunk. */
export type BriefOwnership = {
  readonly files: ReadonlyArray<BriefOwnershipFile>;
  readonly notes: ReadonlyArray<BriefOwnershipNote>;
  readonly contract?: BriefOwnershipContract;
};

const MAX_OWNERSHIP_NOTES = 60;
const MAX_OWNERSHIP_NOTE_LENGTH = 140;
const MAX_OWNERSHIP_TEXT_LENGTH = 400;
const MAX_OWNERSHIP_PATH_LENGTH = 1_024;
const MAX_OWNERSHIP_ALIAS_LENGTH = 16;

/**
 * The Ownership keys a Brief child may return. The skeleton is not among them: a
 * model may say what a file is for, never which files the patch touched.
 */
export const briefOwnershipOutputSchema = v.optional(
  v.strictObject({
    notes: v.pipe(
      v.array(
        v.strictObject({
          path: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(MAX_OWNERSHIP_PATH_LENGTH),
          ),
          note: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(MAX_OWNERSHIP_TEXT_LENGTH),
          ),
        }),
      ),
      v.maxLength(MAX_OWNERSHIP_NOTES),
    ),
    contract: v.optional(
      v.strictObject({
        citation: v.pipe(v.string(), v.maxLength(MAX_OWNERSHIP_ALIAS_LENGTH)),
        caption: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(MAX_OWNERSHIP_TEXT_LENGTH),
        ),
      }),
    ),
  }),
);

export type BriefOwnershipOutput = v.InferOutput<
  typeof briefOwnershipOutputSchema
>;

/** The contract a Brief child offered, before Patchdesk resolves its citation. */
type BriefOwnershipContractOutput =
  NonNullable<BriefOwnershipOutput>["contract"];

/** The Ownership block that survived normalization, and what it cost in citations. */
export type NormalizedBriefOwnership = {
  readonly value: BriefOwnership;
  readonly rejected: number;
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

/**
 * The deterministic file skeleton of one patch: which files changed, how, and
 * by how many lines.
 *
 * Generated files are left out because the block answers "who owns what after
 * the change", and nobody owns a lockfile. The order is by path so two runs
 * over the same patch draw the same tree.
 */
export function briefOwnershipFiles(
  patch: string,
): ReadonlyArray<BriefOwnershipFile> {
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
  const files: Array<BriefOwnershipFile> = [];
  for (const draft of drafts) {
    const status = changedFileStatus(draft);
    const file: BriefOwnershipFile = {
      path: status === "removed" ? draft.oldPath : draft.newPath,
      status,
      additions: draft.additions,
      deletions: draft.deletions,
    };
    if (file.path === "" || classifyChangedPath(file) === "generated") continue;
    files.push(file);
  }
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * Builds the Ownership block from one patch and whatever the model offered.
 *
 * A note survives only when its path is one of the changed files the skeleton
 * kept; a note on a file outside the diff is the model naming something it did
 * not read. The contract survives only when its citation names a hunk of this
 * patch, and its diff text is then cut from that patch rather than taken from
 * the model. Everything dropped is counted, so the Brief's citation status
 * records it.
 */
export function normalizeBriefOwnership(
  raw: BriefOwnershipOutput,
  patch: string,
): NormalizedBriefOwnership {
  const files = briefOwnershipFiles(patch);
  if (raw === undefined) return { value: { files, notes: [] }, rejected: 0 };
  const changedPaths = new Set(files.map((file) => file.path));
  const notes: Array<BriefOwnershipNote> = [];
  const noted = new Set<string>();
  let rejected = 0;
  for (const item of raw.notes) {
    const note = item.note.trim().slice(0, MAX_OWNERSHIP_NOTE_LENGTH);
    if (!changedPaths.has(item.path) || noted.has(item.path) || note === "") {
      rejected += 1;
      continue;
    }
    noted.add(item.path);
    notes.push({ path: item.path, note });
  }
  const contract = resolveOwnershipContract(raw.contract, patch);
  if (raw.contract !== undefined && contract === undefined) rejected += 1;
  return {
    value: { files, notes, ...definedProps({ contract }) },
    rejected,
  };
}

/** `undefined` when the citation names no hunk of this patch, so the block is dropped. */
function resolveOwnershipContract(
  raw: BriefOwnershipContractOutput,
  patch: string,
): BriefOwnershipContract | undefined {
  if (raw === undefined) return undefined;
  const caption = raw.caption.trim().slice(0, MAX_OWNERSHIP_NOTE_LENGTH);
  if (caption === "") return undefined;
  const hunks = narrativeHunkManifest(patch);
  if (hunks._tag === "err") return undefined;
  const hunk = hunks.value.find((entry) => entry.id === raw.citation);
  if (hunk === undefined) return undefined;
  const filtered = filterNarrativePatchToHunks(patch, [hunk.id]);
  if (filtered === "") return undefined;
  return { path: hunk.path, header: hunk.header, raw: filtered, caption };
}

/**
 * A file git shows against `/dev/null` on one side was created or deleted
 * whole; a rename is only a rename once neither side is missing.
 */
function changedFileStatus(draft: ChangedFileDraft): BriefOwnershipStatus {
  if (draft.createdFile) return "added";
  if (draft.deletedFile) return "removed";
  return draft.renamed ? "renamed" : "modified";
}

/** Code-unit order, so the tree never depends on the reader's locale. */
function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
