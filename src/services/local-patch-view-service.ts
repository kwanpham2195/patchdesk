import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ViewedFilesStore } from "../adapters/storage/viewed-files-store";
import type { FailureKinds } from "../domain/failure-kind";
import type {
  ContentHash,
  RepoRelativePath,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import { definedProps } from "../domain/defined-props";
import type { LocalPatchView } from "../domain/local-patch-view";
import { err, ok, type Result } from "../domain/result";
import { isPullRequestReviewSession } from "../domain/review-session";

export type LocalPatchViewFailure = {
  readonly reason: "not_found" | "stale_head" | "not_local_branch" | "storage";
};

export const localPatchViewFailureKinds = {
  not_found: "not_found",
  stale_head: "conflict",
  not_local_branch: "conflict",
  storage: "unavailable",
} as const satisfies FailureKinds<LocalPatchViewFailure["reason"]>;

export type LocalPatchViewResult = {
  readonly sessionId: ReviewSessionId;
  readonly view: LocalPatchView;
  readonly patch: string;
  /** SHA-256 of `patch` as read, so a file replaced under the session reads as a different patch. */
  readonly patchHash: ContentHash;
  /** Files marked Viewed on this view; absent when the record could not be read. */
  readonly viewedPaths?: ReadonlyArray<RepoRelativePath>;
};

/**
 * Reads one patch view of a shared local Review's current session from the
 * files written at prepare (ADR 0050). A switch runs no git and reads nothing
 * from the checkout, so the diff stays as captured until Refresh.
 */
export class LocalPatchViewService {
  constructor(
    private readonly dependencies: {
      readonly reviews: Pick<ReviewStore, "load">;
      readonly sessions: Pick<ReviewSessionStore, "load">;
      readonly viewedFiles: Pick<ViewedFilesStore, "load">;
    },
  ) {}

  async load(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly sessionId: ReviewSessionId;
    readonly view: LocalPatchView;
  }): Promise<Result<LocalPatchViewResult, LocalPatchViewFailure>> {
    const review = await this.dependencies.reviews.load(
      input.profileId,
      input.reviewId,
    );
    if (review._tag === "err")
      return err({
        reason: review.error.reason === "not_found" ? "not_found" : "storage",
      });
    // A session the Review moved past is an old capture; the renderer refetches for the current one.
    if (review.value.currentSessionId !== input.sessionId)
      return err({ reason: "stale_head" });
    const session = await this.dependencies.sessions.load(
      input.profileId,
      input.sessionId,
    );
    if (session._tag === "err")
      return err({
        reason: session.error.reason === "not_found" ? "not_found" : "storage",
      });
    if (isPullRequestReviewSession(session.value))
      return err({ reason: "not_local_branch" });
    const stored = session.value.viewPatches?.[input.view];
    if (stored === undefined) return err({ reason: "not_local_branch" });
    const [patch, viewed] = await Promise.all([
      readFile(stored.patchPath, "utf8").catch(() => undefined),
      this.dependencies.viewedFiles.load(
        input.profileId,
        input.sessionId,
        input.view,
      ),
    ]);
    if (patch === undefined) return err({ reason: "storage" });
    return ok({
      sessionId: input.sessionId,
      view: input.view,
      patch,
      // SAFETY: a SHA-256 hex digest is 64 lowercase hex characters, the exact shape `parseContentHash` accepts.
      patchHash: createHash("sha256")
        .update(patch)
        .digest("hex") as ContentHash,
      ...definedProps({
        viewedPaths: viewed._tag === "ok" ? viewed.value : undefined,
      }),
    });
  }
}
