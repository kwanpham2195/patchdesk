import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { definedProps } from "../domain/defined-props";
import type {
  ContentHash,
  GitSha,
  ReviewId,
  ReviewSessionId,
} from "../domain/ids";
import type { InsightType } from "../domain/insight-record";
import {
  listPatchChangedFiles,
  type PatchChangedFile,
} from "../domain/patch-changed-files";
import { err, ok, type Result } from "../domain/result";
import type { ReviewSession } from "../domain/review-session";
import { reviewSourceTitle } from "../domain/review-source";
import type { ReviewWorkbenchProjection } from "./review-workbench-projection";

/**
 * The code a result is about (ADR 0012): every MCP result that describes a
 * session carries it, so the agent can tell whether a Finding or a note is
 * about the code it has now (ADR 0052 "Tools, v1").
 */
export type ReviewSessionDescription = {
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly baseSha: GitSha;
  /** Absent when the session's patch could not be read. */
  readonly patchHash?: ContentHash;
};

/** What `review_local` answers: the session, its title, its changed files, and which Insights are retained. */
export type LocalReviewOpened = ReviewSessionDescription & {
  readonly title: string;
  readonly changedFiles: ReadonlyArray<PatchChangedFile>;
  readonly retainedInsights: ReadonlyArray<InsightType>;
};

export function describeReviewSession(
  reviewId: ReviewId,
  session: ReviewSession,
  patchHash: ContentHash | undefined,
): ReviewSessionDescription {
  return {
    reviewId,
    sessionId: session.id,
    headSha: session.key.headSha,
    baseSha: session.key.baseSha,
    ...definedProps({ patchHash }),
  };
}

/** The projection omits the base revision, so the session record supplies it. */
export async function describeProjectedSession(
  sessions: Pick<ReviewSessionStore, "load">,
  projection: Pick<
    ReviewWorkbenchProjection,
    "review" | "session" | "revision"
  >,
): Promise<Result<ReviewSessionDescription, { readonly reason: "storage" }>> {
  const session = await sessions.load(
    projection.session.key.profileId,
    projection.session.id,
  );
  return session._tag === "ok"
    ? ok(
        describeReviewSession(
          projection.review.id,
          session.value,
          projection.revision.patchHash,
        ),
      )
    : err({ reason: "storage" });
}

export async function describeOpenedLocalReview(
  sessions: Pick<ReviewSessionStore, "load">,
  projection: ReviewWorkbenchProjection,
): Promise<Result<LocalReviewOpened, { readonly reason: "storage" }>> {
  // The session was just prepared, so an unreadable patch is a storage failure, not an empty change.
  if (projection.fullPatch === undefined) return err({ reason: "storage" });
  const described = await describeProjectedSession(sessions, projection);
  if (described._tag === "err") return described;
  const insightTypes: ReadonlyArray<InsightType> = [
    "analysis",
    "walkthrough",
    "brief",
  ];
  return ok({
    ...described.value,
    title: reviewSourceTitle(projection.session.key.source),
    changedFiles: listPatchChangedFiles(projection.fullPatch),
    retainedInsights: insightTypes.filter(
      (type) => projection.insights[type].retained !== undefined,
    ),
  });
}
