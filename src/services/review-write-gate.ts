import type { GitHubReader } from "../adapters/github/github-adapter";
import type { PullRequestSummary } from "../domain/github-context";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type {
  ReviewRemoteSnapshot,
  ReviewRemoteStore,
} from "../adapters/storage/review-remote-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewObservationJournalStore } from "../adapters/storage/review-observation-journal-store";
import {
  isLocalReview,
  isPullRequestReview,
  markReviewRevisionChanged,
  sessionRepresentsReview,
  type PullRequestReview,
  type Review,
} from "../domain/review";
import {
  isPullRequestReviewSession,
  sameReviewRevision,
  type LocalReviewSession,
  type PullRequestReviewSession,
} from "../domain/review-session";
import {
  sameReviewSource,
  type LocalReviewSource,
  type LocalReviewSourceRequest,
} from "../domain/review-source";
import { sameRepositoryIdentity } from "../domain/repository-identity";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import {
  parseContentHash,
  parseGitShaPrefix,
  type ContentHash,
  type IsoTimestamp,
  type ReviewId,
  type WorkspaceProfileId,
} from "../domain/ids";
import { casesHandled, err, ok, type Result } from "../domain/result";
import type { LocalReviewRevisionService } from "./local-review-revision-service";
import { contentHash, hashReviewArtifactContent } from "./review-artifact-hash";

export type ReviewWriteGateFailure = {
  readonly reason: "not_found" | "storage" | "stale" | "terminal" | "not_fresh";
};

export type CurrentHeadFailure = {
  readonly reason: "github_read" | "head_moved";
};

/**
 * The remote half of the write gate: one `getPullRequest` immediately before
 * a write, proving GitHub still reports the head SHA this session pinned.
 * `requireFresh` proves the durable state is coherent; this proves the remote
 * has not moved since. Every caller runs it after the storage gate and before
 * its first GitHub write, so the round trip happens exactly where it did.
 *
 * Two reasons, not one. Every call site renders "GitHub could not be read"
 * and "the head moved under you" differently -- one is a retry, the other is
 * a refresh -- so the distinction is kept here rather than flattened and
 * guessed at again by each caller.
 */
export async function requireCurrentHead(
  github: Pick<GitHubReader, "getPullRequest">,
  profile: WorkspaceProfileConfig,
  session: Pick<PullRequestReviewSession, "key">,
): Promise<Result<PullRequestSummary, CurrentHeadFailure>> {
  const current = await github.getPullRequest({
    profile,
    pr: {
      host: session.key.host,
      owner: session.key.owner,
      repo: session.key.repo,
      number: session.key.source.prNumber,
    },
  });
  if (current._tag === "err") return err({ reason: "github_read" });
  return current.value.headSha === session.key.headSha
    ? ok(current.value)
    : err({ reason: "head_moved" });
}

export type FreshReview = {
  readonly profile: WorkspaceProfileConfig;
  readonly review: PullRequestReview;
  readonly session: PullRequestReviewSession;
  readonly snapshot: ReviewRemoteSnapshot;
};

export type CurrentReviewSession = {
  readonly profile: WorkspaceProfileConfig;
  readonly review: PullRequestReview;
  readonly session: PullRequestReviewSession;
};

/** A local Review whose source still resolves to its session's revision. */
export type FreshLocalReview = {
  readonly profile: WorkspaceProfileConfig;
  readonly review: Review<LocalReviewSource>;
  readonly session: LocalReviewSession;
  /** The profile repository's checkout the source was recomputed from. */
  readonly localPath: string;
};

export type LocalWriteGateFailure = {
  readonly reason:
    | ReviewWriteGateFailure["reason"]
    /** Recomputing the source gave another revision; the Review is now RevisionChanged. */
    | "revision_changed"
    /** The checkout could not be read, or the profile no longer lists it with a `localPath`. */
    | "checkout_unavailable";
};

/** What the gate needs to recompute a local source and record that it moved. */
export type LocalFreshnessSources = {
  readonly revisions: Pick<
    LocalReviewRevisionService,
    "resolve" | "renderPatch"
  >;
  readonly reviews: Pick<ReviewStore, "save">;
  readonly now: () => IsoTimestamp;
};

export type ReviewWriteExpectation = {
  readonly sessionId: PullRequestReviewSession["id"];
  readonly headSha: PullRequestReviewSession["key"]["headSha"];
  readonly patchHash: ContentHash;
};

/** Shared precondition for every operation that can mutate GitHub or review state. */
export class ReviewWriteGate {
  constructor(
    private readonly profiles: Pick<ProfileStore, "load">,
    private readonly reviews: Pick<ReviewStore, "load">,
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly remote: Pick<ReviewRemoteStore, "load">,
    private readonly observationJournals: Pick<
      ReviewObservationJournalStore,
      "load"
    >,
    private readonly localSources: LocalFreshnessSources,
  ) {}

  /** Resolve the stable Review owner before recovery mutates session evidence. */
  async requireCurrentSession(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<CurrentReviewSession, ReviewWriteGateFailure>> {
    const [profile, review] = await Promise.all([
      this.profiles.load(profileId),
      this.reviews.load(profileId, reviewId),
    ]);
    if (profile._tag === "err" && profile.error.reason === "not_found")
      return err({ reason: "not_found" });
    if (review._tag === "err" && review.error.reason === "not_found")
      return err({ reason: "not_found" });
    if (profile._tag === "err" || review._tag === "err")
      return err({ reason: "storage" });
    if (
      review.value.identity.profileId !== profileId ||
      review.value.id !== reviewId
    )
      return err({ reason: "stale" });
    if (review.value.status._tag === "Terminal")
      return err({ reason: "terminal" });
    // Pull request metadata writes have no local Review counterpart (ADR 0050).
    if (!isPullRequestReview(review.value)) return err({ reason: "stale" });
    const session = await this.sessions.load(
      profileId,
      review.value.currentSessionId,
    );
    if (session._tag === "err")
      return session.error.reason === "not_found"
        ? err({ reason: "not_found" })
        : err({ reason: "storage" });
    if (
      !isPullRequestReviewSession(session.value) ||
      !sessionRepresentsReview(review.value, session.value)
    )
      return err({ reason: "stale" });
    return ok({
      profile: profile.value,
      review: review.value,
      session: session.value,
    });
  }

  async requireFresh(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    expected?: ReviewWriteExpectation,
  ): Promise<Result<FreshReview, ReviewWriteGateFailure>> {
    const journal = await this.observationJournals.load(profileId, reviewId);
    if (journal._tag === "err" || journal.value !== undefined) {
      return err({ reason: "not_fresh" });
    }
    const [profile, review] = await Promise.all([
      this.profiles.load(profileId),
      this.reviews.load(profileId, reviewId),
    ]);
    if (profile._tag === "err" && profile.error.reason === "not_found")
      return err({ reason: "not_found" });
    if (review._tag === "err" && review.error.reason === "not_found")
      return err({ reason: "not_found" });
    if (profile._tag === "err" || review._tag === "err")
      return err({ reason: "storage" });
    const value = review.value;
    if (value.status._tag === "Terminal") return err({ reason: "terminal" });
    // A local Review is Fresh only by recomputing its source: `requireFreshLocal`.
    if (!isPullRequestReview(value)) return err({ reason: "not_fresh" });
    if (
      value.representedRemote === undefined ||
      value.freshness._tag !== "Fresh"
    )
      return err({ reason: "not_fresh" });
    if (value.identity.profileId !== profileId || value.id !== reviewId)
      return err({ reason: "stale" });
    const session = await this.sessions.load(profileId, value.currentSessionId);
    if (session._tag === "err")
      return session.error.reason === "not_found"
        ? err({ reason: "not_found" })
        : err({ reason: "storage" });
    const snapshot = await this.remote.load({
      profileId,
      reviewId,
      snapshotHash: value.representedRemote.snapshotHash,
    });
    if (snapshot._tag === "err") return err({ reason: "stale" });
    const snapshotRef = snapshot.value.pullRequest.ref;
    if (
      snapshot.value.pullRequest.headSha !== value.representedRemote.headSha ||
      snapshotRef.host !== value.identity.host ||
      snapshotRef.owner !== value.identity.owner ||
      snapshotRef.repo !== value.identity.repo ||
      snapshotRef.number !== value.identity.source.prNumber
    )
      return err({ reason: "stale" });
    if (
      !isPullRequestReviewSession(session.value) ||
      !sessionRepresentsReview(value, session.value) ||
      session.value.key.headSha !== value.representedRemote.headSha
    )
      return err({ reason: "stale" });
    if (expected !== undefined) {
      if (
        expected.sessionId !== session.value.id ||
        expected.headSha !== session.value.key.headSha
      )
        return err({ reason: "stale" });
      const patchHash = await contentHash(session.value.patchPath).catch(
        () => undefined,
      );
      if (patchHash === undefined || patchHash !== expected.patchHash)
        return err({ reason: "stale" });
    }
    return ok({
      profile: profile.value,
      review: value,
      session: session.value,
      snapshot: snapshot.value,
    });
  }

  /**
   * The local branch of the freshness gate (ADR 0050 "Freshness"): the source
   * is recomputed from the checkout immediately before the write, with no
   * cache. A different head/base pair is rendered and hashed so the Review
   * records `RevisionChanged` with the observed identity, and the write is
   * refused. The caller holds the Review lock, since this may save the Review.
   */
  async requireFreshLocal(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    expected: ReviewWriteExpectation,
  ): Promise<Result<FreshLocalReview, LocalWriteGateFailure>> {
    const [profile, review] = await Promise.all([
      this.profiles.load(profileId),
      this.reviews.load(profileId, reviewId),
    ]);
    if (profile._tag === "err" && profile.error.reason === "not_found")
      return err({ reason: "not_found" });
    if (review._tag === "err" && review.error.reason === "not_found")
      return err({ reason: "not_found" });
    if (profile._tag === "err" || review._tag === "err")
      return err({ reason: "storage" });
    const value = review.value;
    if (!isLocalReview(value)) return err({ reason: "stale" });
    if (value.status._tag === "Terminal") return err({ reason: "terminal" });
    if (value.identity.profileId !== profileId || value.id !== reviewId)
      return err({ reason: "stale" });
    if (value.freshness._tag !== "Fresh") return err({ reason: "not_fresh" });
    const session = await this.sessions.load(profileId, value.currentSessionId);
    if (session._tag === "err")
      return session.error.reason === "not_found"
        ? err({ reason: "not_found" })
        : err({ reason: "storage" });
    if (
      isPullRequestReviewSession(session.value) ||
      session.value.id !== value.currentSessionId ||
      !sessionRepresentsReview(value, session.value) ||
      expected.sessionId !== session.value.id ||
      expected.headSha !== session.value.key.headSha
    )
      return err({ reason: "stale" });
    const patchHash = await contentHash(session.value.patchPath).catch(
      () => undefined,
    );
    if (patchHash === undefined || patchHash !== expected.patchHash)
      return err({ reason: "stale" });
    const localPath = profile.value.repos.find((candidate) =>
      sameRepositoryIdentity(candidate, value.identity),
    )?.localPath;
    if (localPath === undefined) return err({ reason: "checkout_unavailable" });
    const request = localSourceRequest(value.identity.source);
    if (request === undefined) return err({ reason: "storage" });
    const current = await this.localSources.revisions.resolve(
      profileId,
      localPath,
      request,
    );
    if (current._tag === "err")
      return err({
        reason:
          current.error._tag === "LocalRevisionNotFound"
            ? "revision_changed"
            : "checkout_unavailable",
      });
    if (
      sameReviewSource(current.value.source, value.identity.source) &&
      sameReviewRevision(current.value.revision, session.value.key)
    )
      return ok({
        profile: profile.value,
        review: value,
        session: session.value,
        localPath,
      });
    const patch = await this.localSources.revisions.renderPatch(
      localPath,
      current.value.revision,
    );
    const canonicalPatchHash =
      patch._tag === "ok"
        ? parseContentHash(hashReviewArtifactContent(patch.value))
        : undefined;
    // Without the new patch's hash the evidence is incomplete, so the Review is left as it was.
    if (canonicalPatchHash?._tag === "ok") {
      const detectedAt = this.localSources.now();
      await this.localSources.reviews.save(
        markReviewRevisionChanged(
          value,
          {
            detectedAt,
            identity: {
              ...current.value.revision,
              canonicalPatchHash: canonicalPatchHash.value,
            },
          },
          detectedAt,
        ),
        value.updatedAt,
      );
    }
    return err({ reason: "revision_changed" });
  }
}

/** The request that recomputes a stored local source from its checkout. */
function localSourceRequest(
  source: LocalReviewSource,
): LocalReviewSourceRequest | undefined {
  switch (source.kind) {
    case "working_tree":
      return { kind: "working_tree" };
    case "branch":
      return {
        kind: "branch",
        branch: source.branch,
        baseBranch: source.baseBranch,
      };
    case "commit": {
      const commit = parseGitShaPrefix(source.commitSha);
      return commit._tag === "ok"
        ? { kind: "commit", commit: commit.value }
        : undefined;
    }
    default:
      return casesHandled(source);
  }
}
