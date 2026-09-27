import { readFile } from "node:fs/promises";

import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { definedProps } from "../domain/defined-props";
import {
  parseContentHash,
  type ContentHash,
  type GitSha,
  type ReviewId,
  type ReviewSessionId,
} from "../domain/ids";
import type { InsightType } from "../domain/insight-record";
import {
  listPatchChangedFiles,
  type PatchChangedFile,
} from "../domain/patch-changed-files";
import { err, ok, type Result } from "../domain/result";
import type { Review } from "../domain/review";
import type { ReviewSession } from "../domain/review-session";
import { reviewSourceTitle } from "../domain/review-source";
import { hashReviewArtifactContent } from "./review-artifact-hash";
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

function describeReviewSession(
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

/**
 * A Review's current session as `get_feedback` and `list_local_reviews` read
 * it: its description, the session record, and its Combined patch as read
 * now, absent when the patch could not be read.
 */
export type CurrentSession = {
  readonly description: ReviewSessionDescription;
  readonly session: ReviewSession;
  readonly patch?: string;
};

/**
 * A stored Review's current session, its patch hashed as read now. An
 * unreadable session record is `storage`; an unreadable patch leaves
 * `patchHash` out.
 */
export async function describeCurrentSession(
  sessions: Pick<ReviewSessionStore, "load">,
  review: Pick<Review, "id" | "identity" | "currentSessionId">,
): Promise<Result<CurrentSession, { readonly reason: "storage" }>> {
  const session = await sessions.load(
    review.identity.profileId,
    review.currentSessionId,
  );
  if (session._tag === "err") return err({ reason: "storage" });
  const patch = await readFile(session.value.patchPath, "utf8").catch(
    () => undefined,
  );
  const patchHash =
    patch === undefined
      ? undefined
      : parseContentHash(hashReviewArtifactContent(patch));
  return ok({
    description: describeReviewSession(
      review.id,
      session.value,
      patchHash?._tag === "ok" ? patchHash.value : undefined,
    ),
    session: session.value,
    ...definedProps({ patch }),
  });
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
