import { readFile } from "node:fs/promises";

import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ViewedFilesStore } from "../adapters/storage/viewed-files-store";
import type {
  AbsolutePath,
  RepoRelativePath,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import {
  localPatchViews,
  type LocalPatchView,
} from "../domain/local-patch-view";
import { err, ok, type Result } from "../domain/result";
import {
  isPullRequestReviewSession,
  type ReviewSession,
} from "../domain/review-session";
import { ReviewPatchIndex } from "./review-patch-index";

/**
 * Copy the Viewed marks whose file patch is byte-identical in the same view of
 * the next session; a changed or missing file loses its mark. A pull request
 * session has one view, Combined; a shared local session has three.
 */
export async function carryViewedFiles(
  profileId: WorkspaceProfileId,
  fromSessionId: ReviewSessionId,
  next: ReviewSession,
  sessions: Pick<ReviewSessionStore, "load">,
  viewedFiles: Pick<ViewedFilesStore, "load" | "save">,
): Promise<Result<void, { readonly reason: "storage" }>> {
  const loaded = await sessions.load(profileId, fromSessionId);
  if (loaded._tag === "err") return err({ reason: "storage" });
  const previousPatches = patchPathsByView(loaded.value);
  const nextPatches = patchPathsByView(next);
  if (previousPatches === undefined || nextPatches === undefined)
    return err({ reason: "storage" });

  const carried: Array<{
    view: LocalPatchView;
    paths: ReadonlyArray<RepoRelativePath>;
  }> = [];
  for (const [view, nextPatchPath] of nextPatches) {
    const previousPatchPath = previousPatches.get(view);
    if (previousPatchPath === undefined) return err({ reason: "storage" });
    const marked = await viewedFiles.load(profileId, fromSessionId, view);
    if (marked._tag === "err") return err({ reason: "storage" });
    if (marked.value.length === 0) {
      carried.push({ view, paths: [] });
      continue;
    }
    const [before, after] = await Promise.all([
      readFile(previousPatchPath, "utf8").catch(() => undefined),
      readFile(nextPatchPath, "utf8").catch(() => undefined),
    ]);
    if (before === undefined || after === undefined)
      return err({ reason: "storage" });
    const previous = ReviewPatchIndex.create(before);
    const current = ReviewPatchIndex.create(after);
    carried.push({
      view,
      paths: marked.value.filter((path) => {
        const filePatch = previous.slice(path);
        return filePatch !== undefined && filePatch === current.slice(path);
      }),
    });
  }

  // Save empty sets too: a retry must clear partial marks left by an earlier failed carry.
  for (const { view, paths } of carried) {
    const saved = await viewedFiles.save(profileId, next.id, view, paths);
    if (saved._tag === "err") return err({ reason: "storage" });
  }
  return ok(undefined);
}

/** Each view's stored patch; undefined for a local session prepared without views. */
function patchPathsByView(
  session: ReviewSession,
): ReadonlyMap<LocalPatchView, AbsolutePath> | undefined {
  if (isPullRequestReviewSession(session))
    return new Map([["combined", session.patchPath]]);
  const { viewPatches } = session;
  return viewPatches === undefined
    ? undefined
    : new Map(
        localPatchViews.map((view) => [view, viewPatches[view].patchPath]),
      );
}
