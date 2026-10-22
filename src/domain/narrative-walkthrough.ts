import type {
  ContentHash,
  GitSha,
  RepoRelativePath,
  ReviewSessionId,
  WorkspaceProfileId,
} from "./ids";
import { ok, type Result } from "./result";
import { parseNarrativePatch } from "./narrative-patch";

/** Immutable identity shared by captured Brief and Walkthrough evidence. */
export type NarrativeSnapshot = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly patchHash: ContentHash;
};

/** One captured hunk, with its original source coordinates. */
export type NarrativeHunk = {
  readonly id: string;
  readonly path: RepoRelativePath;
  readonly header: string;
  readonly raw: string;
  readonly filePrefix?: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
};

/** Alias-to-source manifest shared with captured evidence and Brief citations. */
export function narrativeHunkManifest(patch: string): Result<
  ReadonlyArray<{
    readonly id: string;
    readonly path: RepoRelativePath;
    readonly header: string;
  }>,
  Extract<ReturnType<typeof parseNarrativePatch>, { _tag: "err" }>["error"]
> {
  const parsed = parseNarrativePatch(patch);
  if (parsed._tag === "err") return parsed;
  return ok(
    parsed.value.hunks.map((hunk) => ({
      id: hunk.id,
      path: hunk.path,
      header: hunk.header,
    })),
  );
}

/** Brief citations use exact captured headers and source order. */
export function filterNarrativePatchToHunks(
  patch: string,
  hunkIds: ReadonlyArray<string>,
): string {
  const parsed = parseNarrativePatch(patch);
  if (parsed._tag === "err") return "";
  const requested = new Set(hunkIds);
  const output: Array<string> = [];
  for (const file of parsed.value.files) {
    const selected = file.hunks.filter((hunk) => requested.has(hunk.id));
    if (selected.length === 0) continue;
    output.push(file.prefix, ...selected.map((hunk) => hunk.raw));
  }
  return output.length === 0 ? "" : `${output.join("\n")}\n`;
}
