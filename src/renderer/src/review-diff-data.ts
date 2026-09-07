import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { GitStatus } from "@pierre/trees";

/** Immutable textual change totals for one file in a parsed review patch. */
export type FileChangeStats = {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
};

/** Pierre file metadata plus the presentation totals derived from its hunks. */
export type ParsedReviewDiff = {
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly statsByPath: ReadonlyMap<string, FileChangeStats>;
  readonly gitStatusByPath: ReadonlyMap<string, GitStatus>;
};

/** Parse a stored unified patch once for Pierre rendering and navigator totals. */
export function parseReviewDiff(patch: string): ParsedReviewDiff {
  const files = parsePatchFiles(patch, diffCacheKeyPrefix(patch)).flatMap(
    (value) => value.files,
  );
  const statsByPath = new Map<string, FileChangeStats>();
  const gitStatusByPath = new Map<string, GitStatus>();

  for (const file of files) {
    let additions = 0;
    let deletions = 0;
    for (const hunk of file.hunks) {
      for (const content of hunk.hunkContent) {
        if (content.type !== "change") continue;
        additions += content.additions;
        deletions += content.deletions;
      }
    }
    statsByPath.set(file.name, { path: file.name, additions, deletions });
    gitStatusByPath.set(file.name, gitStatusForFileDiff(file));
  }

  return { files, statsByPath, gitStatusByPath };
}

/**
 * Pierre's worker cache is keyed by `cacheKey` alone with no content check,
 * and `parsePatchFiles` derives those keys positionally, so a constant prefix
 * would let a Scope-filtered patch inherit the unfiltered patch's highlighted
 * lines for a different file. The length guards against a hash collision.
 */
function diffCacheKeyPrefix(patch: string): string {
  return `patchdesk-${fnv1a32(patch)}-${patch.length}`;
}

/** 32-bit FNV-1a; a patch can be megabytes, so BigInt hashing is too slow here. */
function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function gitStatusForFileDiff(file: FileDiffMetadata): GitStatus {
  switch (file.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}
