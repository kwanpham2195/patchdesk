import type { Hono } from "hono";
import {
  array,
  boolean,
  integer,
  minLength,
  minValue,
  number,
  optional,
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
} from "valibot";

import { runWithRequestAbortSignal } from "../../adapters/github/command-runner";
import {
  parseContentHash,
  parseGitSha,
  parseIsoTimestamp,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../domain/ids";
import {
  parseRecentReviewWrite,
  recentReviewWriteRecordSchema,
  type RecentReviewWrite,
} from "../../domain/recent-review-write";
import type { LocalApiContainer } from "../local-api-container";
import { response } from "./http-status";
import { jsonBody } from "./json-body";
import { reviewRecoverySchema } from "./review-recovery-schema";

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
    const parsed = safeParse(reviewRecoverySchema, await jsonBody(context));
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
  app.post("/v1/reviews/merge", async (context) => {
    if (mergeWrites === undefined)
      return context.json({ error: "merge_unavailable" }, 503);
    const parsed = safeParse(mergeCommandSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const body = parsed.output;
    const profileId = parseWorkspaceProfileId(body.profileId);
    const reviewId = parseReviewId(body.reviewId);
    const sessionId = parseReviewSessionId(body.sessionId);
    const expectedHeadSha = parseGitSha(body.expectedHeadSha);
    const expectedBaseSha = parseGitSha(body.expectedBaseSha);
    const expectedPatchHash = parseContentHash(body.expectedPatchHash);
    const expectedRevision = parseIsoTimestamp(body.expectedRevision);
    if (
      profileId._tag === "err" ||
      reviewId._tag === "err" ||
      sessionId._tag === "err" ||
      expectedHeadSha._tag === "err" ||
      expectedBaseSha._tag === "err" ||
      expectedPatchHash._tag === "err" ||
      expectedRevision._tag === "err"
    )
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await mergeWrites.merge({
        profileId: profileId.value,
        reviewId: reviewId.value,
        sessionId: sessionId.value,
        expectedHeadSha: expectedHeadSha.value,
        expectedBaseSha: expectedBaseSha.value,
        expectedPatchHash: expectedPatchHash.value,
        expectedRevision: expectedRevision.value,
        method: body.method,
        acknowledgedWarnings: body.acknowledgedWarnings,
      }),
    );
  });
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
/** Mirrors the renderer's merge payload in `use-review-merge-action.ts`; a new field changes both. */
const mergeCommandSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  sessionId: pipe(string(), minLength(1)),
  expectedHeadSha: pipe(string(), minLength(1)),
  expectedBaseSha: pipe(string(), minLength(1)),
  expectedPatchHash: pipe(string(), minLength(1)),
  expectedRevision: pipe(string(), minLength(1)),
  method: picklist(["merge", "squash", "rebase"]),
  acknowledgedWarnings: strictObject({
    revision: strictObject({
      headSha: string(),
      baseSha: string(),
      patchHash: string(),
    }),
    warningCodes: array(
      picklist(["request_changes", "findings_need_acknowledgement"]),
    ),
  }),
});
