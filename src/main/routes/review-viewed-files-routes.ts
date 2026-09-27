import type { Hono } from "hono";
import {
  array,
  maxLength,
  optional,
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
} from "valibot";

import { MAX_VIEWED_FILES } from "../../adapters/storage/viewed-files-store";
import {
  parseRepoRelativePath,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type RepoRelativePath,
} from "../../domain/ids";
import { localPatchViews } from "../../domain/local-patch-view";
import type { LocalApiContainer } from "../local-api-container";
import { response } from "./http-status";
import { jsonBody } from "./json-body";

const viewedFilesSchema = strictObject({
  profileId: string(),
  reviewId: string(),
  sessionId: string(),
  /** Absent is Combined, the only view a pull request Review has. */
  view: optional(picklist(localPatchViews)),
  paths: pipe(
    array(pipe(string(), maxLength(1_024))),
    maxLength(MAX_VIEWED_FILES),
  ),
});

/** Saves the full set of files marked Viewed on one patch view of a Review session's Diff. */
export function registerReviewViewedFilesRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const { viewedFiles } = container;
  app.post("/v1/reviews/viewed-files", async (context) => {
    const parsed = safeParse(viewedFilesSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    const sessionId = parseReviewSessionId(parsed.output.sessionId);
    const paths: Array<RepoRelativePath> = [];
    for (const raw of parsed.output.paths) {
      const path = parseRepoRelativePath(raw);
      if (path._tag === "err")
        return context.json({ error: "invalid_input" }, 400);
      paths.push(path.value);
    }
    if (
      profileId._tag === "err" ||
      reviewId._tag === "err" ||
      sessionId._tag === "err"
    )
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await viewedFiles.save({
        profileId: profileId.value,
        reviewId: reviewId.value,
        sessionId: sessionId.value,
        view: parsed.output.view ?? "combined",
        paths,
      }),
    );
  });
}
