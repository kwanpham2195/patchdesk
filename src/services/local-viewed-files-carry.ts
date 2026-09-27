import { readFile } from "node:fs/promises";

import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ViewedFilesStore } from "../adapters/storage/viewed-files-store";
import type {
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
  type LocalReviewSession,
} from "../domain/review-session";
import { ReviewPatchIndex } from "./review-patch-index";

/** Copy only exact file patches from one shared Review session to the same view of the next. */
export async function carryViewedFiles(
  profileId: WorkspaceProfileId,
  fromSessionId: ReviewSessionId,
  next: LocalReviewSession,
  sessions: Pick<ReviewSessionStore, "load">,
  viewedFiles: Pick<ViewedFilesStore, "load" | "save">,
): Promise<Result<void, { readonly reason: "storage" }>> {
  const loaded = await sessions.load(profileId, fromSessionId);
  if (
    loaded._tag === "err" ||
    isPullRequestReviewSession(loaded.value) ||
    loaded.value.viewPatches === undefined ||
    next.viewPatches === undefined
  )
    return err({ reason: "storage" });

  const carried: Array<{
    view: LocalPatchView;
    paths: ReadonlyArray<RepoRelativePath>;
  }> = [];
  for (const view of localPatchViews) {
    const marked = await viewedFiles.load(profileId, fromSessionId, view);
    if (marked._tag === "err") return err({ reason: "storage" });
    if (marked.value.length === 0) {
      carried.push({ view, paths: [] });
      continue;
    }
    const [before, after] = await Promise.all([
      readFile(loaded.value.viewPatches[view].patchPath, "utf8").catch(
        () => undefined,
      ),
      readFile(next.viewPatches[view].patchPath, "utf8").catch(() => undefined),
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
