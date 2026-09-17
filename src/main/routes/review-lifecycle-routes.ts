import type { Hono } from "hono";
import {
  array,
  boolean,
  integer,
  minLength,
  minValue,
  number,
  optional,
  pipe,
  safeParse,
  strictObject,
  string,
} from "valibot";

import { runWithRequestAbortSignal } from "../../adapters/github/command-runner";
import { parseReviewId, parseWorkspaceProfileId } from "../../domain/ids";
import {
  parseRecentReviewWrite,
  recentReviewWriteRecordSchema,
  type RecentReviewWrite,
} from "../../domain/recent-review-write";
import type { LocalApiContainer } from "../local-api-container";
import { response } from "./http-status";
import { jsonBody } from "./json-body";

/** Opening, loading, refreshing, diffing and merging one Review. */
export function registerReviewLifecycleRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const { mergeWrites, recovery, reviewDiffSources, reviewWorkbench } =
    container;
  app.post("/v1/reviews/open", async (context) => {
    const parsed = safeParse(reviewOpenSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.open(parsed.output))
      : context.json({ error: "invalid_input" }, 400);
  });
  app.post("/v1/reviews/open-merged", async (context) => {
    const parsed = safeParse(reviewOpenSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.openMerged(parsed.output))
      : context.json({ error: "invalid_input" }, 400);
  });
  app.post("/v1/reviews/load", async (context) => {
    const parsed = safeParse(reviewLoadSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.load(parsed.output))
      : context.json({ error: "invalid_input" }, 400);
  });
  app.post("/v1/reviews/merge/recover", async (context) => {
    const parsed = safeParse(reviewRecoverSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const reconciled = await recovery.reconcileReview(
      profileId.value,
      reviewId.value,
    );
    if (reconciled.failed > 0)
      return context.json({ error: "outcome_unknown" }, 409);
    return response(context, await reviewWorkbench.load(parsed.output));
  });
  app.post("/v1/reviews/detect-updates", async (context) => {
    const parsed = safeParse(reviewUpdateSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    // The route is the sole authority for detection-request parsing: typed
    // ids are refined here, and the controller receives only typed input.
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const recentWrites: Array<RecentReviewWrite> = [];
    for (const entry of parsed.output.recentWrites ?? []) {
      const write = parseRecentReviewWrite(entry);
      if (write._tag === "err")
        return context.json({ error: "invalid_input" }, 400);
      recentWrites.push(write.value);
    }
    const detectUpdatesInput = {
      profileId: profileId.value,
      reviewId: reviewId.value,
    };
    return runWithRequestAbortSignal(context.req.raw.signal, async () =>
      response(
        context,
        await reviewWorkbench.detectUpdates(
          recentWrites.length === 0
            ? detectUpdatesInput
            : { ...detectUpdatesInput, recentWrites },
        ),
      ),
    );
  });
  app.post("/v1/reviews/refresh", async (context) => {
    const parsed = safeParse(reviewUpdateSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.refresh(parsed.output))
      : context.json({ error: "invalid_input" }, 400);
  });
  app.post("/v1/reviews/commit-diff", async (context) => {
    const parsed = safeParse(reviewCommitDiffSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.commitDiff(parsed.output))
      : context.json({ error: "invalid_input" }, 400);
  });
  app.post("/v1/reviews/diff-file", async (context) =>
    response(context, await reviewDiffSources.load(await jsonBody(context))),
  );
  app.post("/v1/reviews/merge", async (context) =>
    mergeWrites === undefined
      ? context.json({ error: "merge_unavailable" }, 503)
      : response(context, await mergeWrites.merge(await jsonBody(context))),
  );
}

const reviewOpenSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  host: pipe(string(), minLength(1)),
  owner: pipe(string(), minLength(1)),
  repo: pipe(string(), minLength(1)),
  number: pipe(number(), integer(), minValue(1)),
});
const reviewLoadSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  /** Set only by the maintainer's own open; see `ReviewWorkbenchController.load`. */
  recordOpen: optional(boolean()),
});
/** The recovery routes reload the workbench already on screen, so they never carry `recordOpen`. */
const reviewRecoverSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
});
const reviewUpdateSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  recentWrites: optional(array(recentReviewWriteRecordSchema)),
});
const reviewCommitDiffSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  commitSha: pipe(string(), minLength(7)),
});
