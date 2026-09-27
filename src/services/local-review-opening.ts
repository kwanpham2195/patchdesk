import { readFile, realpath } from "node:fs/promises";

import { minLength, pipe, strictObject, string } from "valibot";

import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import {
  createReviewId,
  detachedHeadBranch,
  type AbsolutePath,
  type ContentHash,
  type GitSha,
  type IsoTimestamp,
  type LocalBranchName,
  type RepoRelativePath,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type { LocalDraft } from "../domain/local-draft";
import {
  carryLocalDraft,
  type LocalDraftCarryTarget,
} from "../domain/local-draft-carry";
import type { LocalPatchView } from "../domain/local-patch-view";
import { casesHandled, err, ok, type Result } from "../domain/result";
import {
  createReview,
  isLocalReview,
  markReviewOpened,
  moveLocalReviewToSession,
  recordPreparedLocalSession,
  type Review,
} from "../domain/review";
import { definedProps } from "../domain/defined-props";
import type { FailureKinds } from "../domain/failure-kind";
import {
  localReviewSourceRequestSchema,
  reopenLocalSourceRequest,
  type LocalReviewSource,
  type LocalReviewSourceRequest,
} from "../domain/review-source";
import type { LocalReviewSession } from "../domain/review-session";
import { readCheckoutFile } from "./local-apply-checkout";
import type { LocalApplySettlement } from "./local-apply-settlement";
import type { LocalBranchListing } from "./local-base-inference";
import type { UntrackedTooLarge } from "./local-untracked-size";
import type {
  LocalReviewOpenRequest,
  LocalReviewPreparationFailure,
  LocalReviewSessionPreparation,
  ResolvedLocalReview,
} from "./local-review-session-preparation";
import type { ReviewRetention } from "./review-retention";
import type { RepositoryCheckout } from "./local-checkout";
import {
  describeSharedReviews,
  listOpenSharedReviews,
  type CheckoutSharedReviews,
} from "./local-shared-review-list";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type {
  ReviewWorkbenchProjection,
  ReviewWorkbenchProjectionService,
} from "./review-workbench-projection";

export type LocalReviewOpenFailure =
  | {
      readonly reason:
        | "not_found"
        | "repository_not_local"
        /** The named checkout is not a live worktree of the repository (#489). */
        | "checkout_not_found"
        | "unmerged_index"
        | "revision_not_found"
        | "storage"
        | "terminal";
    }
  /** The working tree's untracked files are over the `exceededLimit` snapshot limit; `largestPaths` are the ones to ignore (#485). */
  | {
      readonly reason: "untracked_too_large";
      readonly exceededLimit: UntrackedTooLarge["exceededLimit"];
      readonly largestPaths: ReadonlyArray<string>;
    }
  /** The patch is over the git output cap; `largestFiles` are the ones to leave out or split (#493). */
  | {
      readonly reason: "patch_too_large";
      readonly largestFiles: ReadonlyArray<string>;
    }
  /** The configured checkout at `localPath` is gone, as after the repository moved on disk (#488). */
  | { readonly reason: "checkout_missing"; readonly localPath: AbsolutePath }
  /** The checkout's `HEAD` is not the one the request expects; `currentBranch` is absent when it is detached. */
  | {
      readonly reason: "branch_mismatch";
      readonly currentBranch?: LocalBranchName;
    };

/**
 * An agent's shared Review open with no base (#555): no shared Review of the
 * checkout's branch exists, and no other local branch has a merge base behind
 * `HEAD` to infer one from.
 */
export type LocalReviewBaseRequired = { readonly reason: "base_required" };

/** What an agent names to open (ADR 0052 `review_local`): a commit, or the shared Review with or without its base. */
export type LocalReviewAgentOpenRequest = Omit<
  LocalReviewOpenRequest,
  "request"
> & {
  readonly request:
    | Exclude<LocalReviewSourceRequest, { readonly kind: "local_branch" }>
    | {
        readonly kind: "local_branch";
        readonly baseBranch?: LocalBranchName;
        readonly checkout?: AbsolutePath;
      };
};

/** What the Local review dialog offers for the shared Review: the listing, and the bases the checkout's branch already has an open shared Review against, the one opened last first. */
export type LocalReviewBranches = LocalBranchListing & {
  readonly reviewedBases: ReadonlyArray<LocalBranchName>;
};

/** An agent's open: the Review on its current session, and whether its base was inferred rather than named or reused. */
export type LocalReviewAgentOpened = {
  readonly workbench: ReviewWorkbenchProjection;
  readonly baseInferred: boolean;
};

/** A shared Review refused because the checkout's `HEAD` moved to another branch. */
export type LocalBranchMismatch = Extract<
  LocalReviewOpenFailure,
  { readonly reason: "branch_mismatch" }
>;

/** Refresh refuses while another command holds the Review, and `not_applicable` on a pull request Review or on a working-tree or branch Review stored before the shared Review (#555). */
export type LocalReviewRefreshFailure =
  | LocalReviewOpenFailure
  | { readonly reason: "in_progress" | "not_applicable" };

/** An agent's refresh is refused `rate_limited` until this long after the Review's last one started. */
const AGENT_REFRESH_INTERVAL_MS = 10_000;

/** Refresh's refusals, plus `rate_limited` for an agent's refresh that comes too soon after the last. */
export type LocalReviewAgentRefreshFailure =
  | LocalReviewRefreshFailure
  | { readonly reason: "rate_limited"; readonly retryAfterMs: number };

/** What an agent's refresh read from the checkout (ADR 0052 `refresh_review`). */
export type LocalReviewPrepared = {
  readonly reviewId: ReviewId;
  /** The Review's current session, which an agent's refresh never moves. */
  readonly sessionId: ReviewSessionId;
  /** False when the checkout still holds the current session's content. */
  readonly changed: boolean;
  /** The session the maintainer's Refresh moves the Review to; present when `changed`. */
  readonly preparedSessionId?: ReviewSessionId;
  /** The revision and patch of the content as read. */
  readonly headSha: GitSha;
  readonly baseSha: GitSha;
  readonly patchHash: ContentHash;
};

const nonEmpty = pipe(string(), minLength(1));

/** The wire form of `open`'s request; the route parses each id and the source from it. */
export const localReviewOpenRequestSchema = strictObject({
  profileId: nonEmpty,
  host: nonEmpty,
  owner: nonEmpty,
  repo: nonEmpty,
  source: localReviewSourceRequestSchema,
});

/** How each open and Refresh refusal is classified (ADR 0052 "Error model"). */
export const localReviewFailureKinds = {
  base_required: "conflict",
  not_found: "not_found",
  repository_not_local: "not_found",
  checkout_not_found: "not_found",
  checkout_missing: "not_found",
  revision_not_found: "not_found",
  unmerged_index: "conflict",
  untracked_too_large: "conflict",
  patch_too_large: "conflict",
  terminal: "conflict",
  branch_mismatch: "conflict",
  in_progress: "conflict",
  not_applicable: "conflict",
  storage: "unavailable",
} as const satisfies FailureKinds<
  LocalReviewRefreshFailure["reason"] | LocalReviewBaseRequired["reason"]
>;

/**
 * Opens and refreshes a local Review (ADR 0050). Every open reads the source
 * from the checkout again, so unchanged content lands on the same session and
 * an edit moves the Review to a new one, carrying its Local drafts (#452).
 */
export class LocalReviewOpening {
  /** When each Review's last prepared agent refresh started, in this process: the limit only bounds snapshot cost. */
  private readonly agentRefreshStartedAt = new Map<string, number>();
  /** The Reviews an agent's refresh is reading now; a second one is refused rather than run beside it. */
  private readonly agentRefreshing = new Set<string>();

  constructor(
    private readonly preparation: Pick<
      LocalReviewSessionPreparation,
      | "resolve"
      | "prepare"
      | "listCheckouts"
      | "listBranches"
      | "findCheckout"
      | "readCommitFiles"
    >,
    private readonly projection: Pick<
      ReviewWorkbenchProjectionService,
      "loadLocal"
    >,
    private readonly lifecycle: {
      readonly reviews: Pick<ReviewStore, "load" | "save" | "list">;
      readonly sessions: Pick<ReviewSessionStore, "load">;
      readonly artifacts: Pick<ReviewArtifactStorage, "quarantineReview">;
      readonly coordinator: Pick<
        ReviewOperationCoordinator,
        "withReviewLock" | "acquire" | "release"
      >;
      readonly retention: Pick<ReviewRetention, "pruneSuperseded">;
      readonly applySettlement: Pick<
        LocalApplySettlement,
        "settleEarlierSession"
      >;
    },
    private readonly now: () => IsoTimestamp,
  ) {}

  async open(
    request: LocalReviewOpenRequest,
  ): Promise<Result<ReviewWorkbenchProjection, LocalReviewOpenFailure>> {
    // A branch switch between the unlocked read and the locked one keys
    // another Review, so the open starts once more under that Review's lock.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Reading the source decides the Review id: a shared Review is keyed by the branch `HEAD` names.
      const resolved = await this.preparation.resolve(request);
      if (resolved._tag === "err")
        return err(mapPreparationFailure(resolved.error));
      // The locked open proceeds only on this same Review id, and a shared
      // Review's id is keyed by its branch, so checking here also holds under the lock.
      const mismatch = headMismatch(
        request.request,
        resolved.value.identity.source,
      );
      if (mismatch !== undefined) return err(mismatch);
      const reviewId = createReviewId(resolved.value.identity);
      const opened = await this.lifecycle.coordinator.withReviewLock(
        request.profileId,
        reviewId,
        async () => {
          const result = await this.openLocked(request, reviewId);
          if (result?._tag === "ok")
            await this.recordOpened(request.profileId, reviewId);
          return result;
        },
      );
      if (opened !== undefined) return opened;
    }
    return err({ reason: "storage" });
  }

  /**
   * A coding agent's open (ADR 0052 `review_local`): the agent prepares and
   * the maintainer moves, so a Review that exists for the source is returned
   * on its current session, unmoved, and only a missing one is created. It
   * never stamps `lastOpenedAt`, so the agent does not reorder the sidebar.
   * A shared Review named without a base takes the base of the branch's
   * shared Review the maintainer opened last, else the inferred one (#555).
   * Several such Reviews are expected only after a base change in the dialog.
   */
  async openForAgent(
    input: LocalReviewAgentOpenRequest,
  ): Promise<
    Result<
      LocalReviewAgentOpened,
      LocalReviewOpenFailure | LocalReviewBaseRequired
    >
  > {
    const based = await this.agentRequest(input);
    if (based._tag === "err") return based;
    const opened = await this.openExistingOrCreate({
      ...input,
      request: based.value.request,
    });
    return opened._tag === "ok"
      ? ok({ workbench: opened.value, baseInferred: based.value.baseInferred })
      : opened;
  }

  /** The request an agent's open reads: a named base as named, else the branch's last-opened shared Review's base, else the inferred one. */
  private async agentRequest(input: LocalReviewAgentOpenRequest): Promise<
    Result<
      {
        readonly request: LocalReviewSourceRequest;
        readonly baseInferred: boolean;
      },
      LocalReviewOpenFailure | LocalReviewBaseRequired
    >
  > {
    const { request } = input;
    if (request.kind !== "local_branch")
      return ok({ request, baseInferred: false });
    const { baseBranch, checkout } = request;
    if (baseBranch !== undefined)
      return ok({
        request: {
          kind: "local_branch",
          baseBranch,
          ...definedProps({ checkout }),
        },
        baseInferred: false,
      });
    const listing = await this.listBranches(
      input.profileId,
      input.repository,
      checkout,
    );
    if (listing._tag === "err") return listing;
    const { head, inferred, reviewedBases } = listing.value;
    const [reused] = reviewedBases;
    const base = reused ?? inferred?.baseBranch;
    if (base === undefined) return err({ reason: "base_required" });
    return ok({
      request: {
        kind: "local_branch",
        baseBranch: base,
        // A branch switch after the listing is refused rather than opening another branch's Review on this base.
        expectedHead: head,
        ...definedProps({ checkout }),
      },
      baseInferred: reused === undefined,
    });
  }

  /**
   * The bases of `branch`'s open shared Reviews in this checkout, the one
   * the maintainer opened last first. Empty when the Reviews cannot be listed:
   * the caller then infers a base, as for a branch with none.
   */
  private async reviewedBases(
    profileId: WorkspaceProfileId,
    repository: LocalReviewOpenRequest["repository"],
    checkout: AbsolutePath | undefined,
    branch: LocalBranchName,
  ): Promise<ReadonlyArray<LocalBranchName>> {
    const listed = await listOpenSharedReviews(
      this.lifecycle.reviews,
      profileId,
      repository,
      checkout,
      branch,
    );
    return listed._tag === "ok"
      ? listed.value.map(({ source }) => source.baseBranch)
      : [];
  }

  /**
   * The open shared Reviews of the checkout containing `directory`, each on
   * its current session (ADR 0052 `list_local_reviews`). A read: it prepares
   * nothing and stamps no `lastOpenedAt`. A current session that cannot be
   * read refuses the whole list `storage` rather than hide that Review.
   */
  async listSharedReviews(
    profileId: WorkspaceProfileId,
    directory: AbsolutePath,
  ): Promise<Result<CheckoutSharedReviews, LocalReviewOpenFailure>> {
    const found = await this.findCheckout(profileId, directory);
    if (found._tag === "err") return found;
    const { repository, checkout, configured, head } = found.value;
    const shared = await listOpenSharedReviews(
      this.lifecycle.reviews,
      profileId,
      repository,
      configured ? undefined : checkout,
    );
    if (shared._tag === "err") return shared;
    const reviews = await describeSharedReviews(
      this.lifecycle.sessions,
      shared.value,
    );
    return reviews._tag === "ok"
      ? ok({ head, reviews: reviews.value })
      : reviews;
  }

  private async openExistingOrCreate(
    request: LocalReviewOpenRequest,
  ): Promise<Result<ReviewWorkbenchProjection, LocalReviewOpenFailure>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resolved = await this.preparation.resolve(request);
      if (resolved._tag === "err")
        return err(mapPreparationFailure(resolved.error));
      const mismatch = headMismatch(
        request.request,
        resolved.value.identity.source,
      );
      if (mismatch !== undefined) return err(mismatch);
      const reviewId = createReviewId(resolved.value.identity);
      const opened = await this.lifecycle.coordinator.withReviewLock(
        request.profileId,
        reviewId,
        async () => {
          const existing = await this.lifecycle.reviews.load(
            request.profileId,
            reviewId,
          );
          if (existing._tag === "ok")
            return isLocalReview(existing.value)
              ? this.projectCurrent(existing.value)
              : err({ reason: "storage" as const });
          return this.openLocked(request, reviewId);
        },
      );
      if (opened !== undefined) return opened;
    }
    return err({ reason: "storage" });
  }

  /** The checkouts a local Review of the repository may be opened in (#489). */
  async listCheckouts(
    profileId: WorkspaceProfileId,
    repository: LocalReviewOpenRequest["repository"],
  ): Promise<
    Result<ReadonlyArray<RepositoryCheckout>, LocalReviewOpenFailure>
  > {
    const listed = await this.preparation.listCheckouts(profileId, repository);
    return listed._tag === "ok"
      ? listed
      : err(mapPreparationFailure(listed.error));
  }

  /**
   * A checkout's local branches, the base a shared Review would infer there,
   * and the bases of the open shared Reviews of the branch `HEAD` names
   * (#555); `checkout` absent is the configured one.
   */
  async listBranches(
    profileId: WorkspaceProfileId,
    repository: LocalReviewOpenRequest["repository"],
    checkout: AbsolutePath | undefined,
  ): Promise<Result<LocalReviewBranches, LocalReviewOpenFailure>> {
    const listed = await this.preparation.listBranches(
      profileId,
      repository,
      checkout,
    );
    if (listed._tag === "err") return err(mapPreparationFailure(listed.error));
    const { listing } = listed.value;
    return ok({
      ...listing,
      reviewedBases: await this.reviewedBases(
        profileId,
        repository,
        listed.value.checkout,
        listing.head.kind === "branch"
          ? listing.head.branch
          : detachedHeadBranch,
      ),
    });
  }

  /** The profile repository and checkout an agent's working directory is in (ADR 0052 `review_local`). */
  async findCheckout(
    profileId: WorkspaceProfileId,
    directory: AbsolutePath,
  ): Promise<
    Result<
      {
        readonly repository: LocalReviewOpenRequest["repository"];
        readonly checkout: AbsolutePath;
      } & Pick<RepositoryCheckout, "head" | "configured">,
      LocalReviewOpenFailure
    >
  > {
    const found = await this.preparation.findCheckout(profileId, directory);
    return found._tag === "ok"
      ? found
      : err(mapPreparationFailure(found.error));
  }

  /**
   * Refresh (#452): reads the stored source from the checkout again. It is a
   * command, so it refuses rather than waits while another one holds the
   * Review, and a shared Review on another branch is refused as a reopen is.
   */
  async refresh(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<ReviewWorkbenchProjection, LocalReviewRefreshFailure>> {
    const key = `${profileId}:${reviewId}`;
    if (!this.lifecycle.coordinator.acquire(key))
      return err({ reason: "in_progress" });
    try {
      const read = await this.resolveStoredSource(profileId, reviewId);
      if (read._tag === "err") return read;
      return await this.moveToSession(read.value.resolved, reviewId);
    } finally {
      this.lifecycle.coordinator.release(key);
    }
  }

  /**
   * An agent's refresh (ADR 0052 `refresh_review`): reads the checkout as
   * Refresh does and prepares the session for its content, but leaves the
   * Review, its drafts, and `lastOpenedAt` as they are. The prepared session
   * is recorded so the header shows Updates available and retention keeps it;
   * the maintainer's Refresh then moves to it. Content equal to the current
   * session clears an earlier prepared session. The snapshot runs outside the
   * Review lock, so the maintainer's commands are not refused meanwhile.
   */
  async prepareForAgent(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<LocalReviewPrepared, LocalReviewAgentRefreshFailure>> {
    const key = `${profileId}:${reviewId}`;
    const startedAt = Date.parse(this.now());
    for (const [refreshed, at] of this.agentRefreshStartedAt)
      if (startedAt - at >= AGENT_REFRESH_INTERVAL_MS)
        this.agentRefreshStartedAt.delete(refreshed);
    const previous = this.agentRefreshStartedAt.get(key);
    if (
      previous !== undefined &&
      startedAt - previous < AGENT_REFRESH_INTERVAL_MS
    )
      return err({
        reason: "rate_limited",
        retryAfterMs: previous + AGENT_REFRESH_INTERVAL_MS - startedAt,
      });
    if (this.agentRefreshing.has(key)) return err({ reason: "in_progress" });
    this.agentRefreshing.add(key);
    try {
      const read = await this.resolveStoredSource(profileId, reviewId);
      if (read._tag === "err") return read;
      // Keyed by content and run under the profile lock, so it needs no Review lock.
      const session = await this.preparation.prepare(read.value.resolved);
      if (session._tag === "err")
        return err(mapPreparationFailure(session.error));
      const prepared = await this.lifecycle.coordinator.withReviewLock(
        profileId,
        reviewId,
        () =>
          this.recordPrepared(
            read.value.resolved,
            read.value.stored.currentSessionId,
          ),
      );
      // Only a prepared snapshot starts the window, so a refusal can be retried at once.
      if (prepared._tag === "ok")
        this.agentRefreshStartedAt.set(key, startedAt);
      return prepared;
    } finally {
      this.agentRefreshing.delete(key);
    }
  }

  /**
   * The refusal for opening a stored shared Review as stored while the
   * checkout is on another branch (#477), the rule `open` and `refresh` apply.
   * Undefined for any other source, and when the checkout cannot be read,
   * because a stored session shows without it.
   */
  async branchMismatch(
    review: Review<LocalReviewSource>,
  ): Promise<LocalBranchMismatch | undefined> {
    const { profileId, host, owner, repo, source } = review.identity;
    if (source.kind !== "local_branch") return undefined;
    const request = reopenLocalSourceRequest(source);
    if (request === undefined) return undefined;
    const resolved = await this.preparation.resolve({
      profileId,
      repository: { host, owner, repo },
      request,
    });
    return resolved._tag === "ok"
      ? headMismatch(request, resolved.value.identity.source)
      : undefined;
  }

  /** Reads a stored local Review's source from its checkout again, refusing a branch switch as a reopen does. */
  private async resolveStoredSource(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<
    Result<
      {
        readonly stored: Review<LocalReviewSource>;
        readonly resolved: ResolvedLocalReview;
      },
      LocalReviewRefreshFailure
    >
  > {
    const stored = await this.lifecycle.reviews.load(profileId, reviewId);
    if (stored._tag === "err")
      return err({
        reason: stored.error.reason === "not_found" ? "not_found" : "storage",
      });
    if (!isLocalReview(stored.value)) return err({ reason: "not_applicable" });
    const { host, owner, repo, source } = stored.value.identity;
    // A working-tree or branch Review stored before the shared Review (#555) is not read again.
    if (source.kind === "working_tree" || source.kind === "branch")
      return err({ reason: "not_applicable" });
    const request = reopenLocalSourceRequest(source);
    if (request === undefined) return err({ reason: "storage" });
    const resolved = await this.preparation.resolve({
      profileId,
      repository: { host, owner, repo },
      request,
    });
    if (resolved._tag === "err")
      return err(mapPreparationFailure(resolved.error));
    const mismatch = headMismatch(request, resolved.value.identity.source);
    if (mismatch !== undefined) return err(mismatch);
    if (createReviewId(resolved.value.identity) !== reviewId)
      return err({ reason: "storage" });
    return ok({ stored: stored.value, resolved: resolved.value });
  }

  /**
   * Records the resolved content's session on the Review without moving it.
   * The caller holds the Review lock and read the checkout while the Review
   * was on `readOn`; content read before a move to other content is refused
   * `in_progress`, so the agent reads the checkout again.
   */
  private async recordPrepared(
    resolved: ResolvedLocalReview,
    readOn: ReviewSessionId,
  ): Promise<Result<LocalReviewPrepared, LocalReviewRefreshFailure>> {
    const { profileId } = resolved.identity;
    const reviewId = createReviewId(resolved.identity);
    // Instant for the session prepared before the lock; it rebuilds a worktree retention removed meanwhile.
    const session = await this.preparation.prepare(resolved);
    if (session._tag === "err")
      return err(mapPreparationFailure(session.error));
    const { headSha, baseSha } = session.value.key;
    const patchHash = session.value.canonicalPatchHash;
    if (patchHash === undefined) return err({ reason: "storage" });
    const stored = await this.lifecycle.reviews.load(profileId, reviewId);
    if (stored._tag === "err" || !isLocalReview(stored.value))
      return err({ reason: "storage" });
    const review = stored.value;
    const changed = session.value.id !== review.currentSessionId;
    if (changed && review.currentSessionId !== readOn)
      return err({ reason: "in_progress" });
    const now = this.now();
    const next = changed
      ? review.preparedSessionId === session.value.id
        ? undefined
        : recordPreparedLocalSession(review, {
            sessionId: session.value.id,
            identity: { headSha, baseSha, canonicalPatchHash: patchHash },
            detectedAt: now,
          })
      : review.preparedSessionId === undefined &&
          review.freshness._tag === "Fresh"
        ? undefined
        : moveLocalReviewToSession(review, {
            sessionId: review.currentSessionId,
            headSha: review.currentHeadSha,
            updatedAt: now,
          });
    if (next?._tag === "err") return err({ reason: "terminal" });
    if (next !== undefined) {
      const saved = await this.lifecycle.reviews.save(
        next.value,
        review.updatedAt,
      );
      if (saved._tag === "err") return err({ reason: "storage" });
      // An earlier prepared session is superseded now; retention keeps the current and prepared ones.
      await this.lifecycle.retention.pruneSuperseded(profileId, reviewId);
    }
    return ok({
      reviewId,
      sessionId: review.currentSessionId,
      changed,
      ...definedProps({
        preparedSessionId: changed ? session.value.id : undefined,
      }),
      headSha,
      baseSha,
      patchHash,
    });
  }

  /**
   * Stamps `lastOpenedAt` for the sidebar (ADR 0042) only on a maintainer's
   * open, so the reopen after an Apply leaves the order alone. Best effort:
   * the open has already succeeded, so a failed save is dropped.
   */
  private async recordOpened(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<void> {
    const loaded = await this.lifecycle.reviews.load(profileId, reviewId);
    if (loaded._tag === "err") return;
    await this.lifecycle.reviews.save(
      markReviewOpened(loaded.value, { now: this.now() }),
      loaded.value.updatedAt,
    );
  }

  /**
   * Reads the source again and moves the Review to that session. The caller
   * holds the Review lock for `reviewId`, because a snapshot read before the
   * lock can be older than a session another open saved meanwhile (#451).
   * Undefined when the checkout now keys a different Review.
   */
  async openLocked(
    request: LocalReviewOpenRequest,
    reviewId: ReviewId,
  ): Promise<
    Result<ReviewWorkbenchProjection, LocalReviewOpenFailure> | undefined
  > {
    const resolved = await this.preparation.resolve(request);
    if (resolved._tag === "err")
      return err(mapPreparationFailure(resolved.error));
    if (createReviewId(resolved.value.identity) !== reviewId) return undefined;
    return this.moveToSession(resolved.value, reviewId);
  }

  private async moveToSession(
    resolved: ResolvedLocalReview,
    reviewId: ReviewId,
  ): Promise<Result<ReviewWorkbenchProjection, LocalReviewOpenFailure>> {
    const { profileId } = resolved.identity;
    const session = await this.preparation.prepare(resolved);
    if (session._tag === "err")
      return err(mapPreparationFailure(session.error));
    // Before the Review is read: settling a confirmed Apply marks drafts on it (#484).
    await this.lifecycle.applySettlement.settleEarlierSession({
      profileId,
      reviewId,
      sessionId: session.value.id,
      checkoutPath: resolved.checkoutPath,
    });
    const existing = await this.lifecycle.reviews.load(profileId, reviewId);
    let stored: Review<LocalReviewSource> | undefined;
    if (existing._tag === "ok") {
      if (!isLocalReview(existing.value)) return err({ reason: "storage" });
      stored = existing.value;
    } else if (existing.error.reason === "invalid_stored_value") {
      // A corrupt Review record is moved aside and rebuilt from the checkout.
      const quarantined = await this.lifecycle.artifacts.quarantineReview(
        profileId,
        reviewId,
      );
      if (quarantined._tag === "err") return err({ reason: "storage" });
    } else if (existing.error.reason !== "not_found") {
      return err({ reason: "storage" });
    }
    const now = this.now();
    const drafts = stored?.localDrafts;
    let carried: ReadonlyArray<LocalDraft> | undefined;
    if (drafts !== undefined && stored?.currentSessionId !== session.value.id) {
      carried = await carryToSession(drafts, session.value, this.preparation);
      if (carried === undefined) return err({ reason: "storage" });
    }
    const moved = moveLocalReviewToSession(
      stored ??
        createReview({
          identity: resolved.identity,
          currentSessionId: session.value.id,
          headSha: session.value.key.headSha,
          createdAt: now,
        }),
      {
        sessionId: session.value.id,
        headSha: session.value.key.headSha,
        updatedAt: now,
        ...definedProps({ localDrafts: carried }),
      },
    );
    if (moved._tag === "err") return err({ reason: "terminal" });
    const saved = await this.lifecycle.reviews.save(
      moved.value,
      stored?.updatedAt,
    );
    if (saved._tag === "err") return err({ reason: "storage" });
    this.agentRefreshStartedAt.delete(`${profileId}:${reviewId}`);
    // Awaited under this Review lock, so no other open of the Review moves it meanwhile (#474).
    // Best effort: the retention service records its own failures.
    await this.lifecycle.retention.pruneSuperseded(profileId, reviewId);
    return this.projectCurrent(moved.value);
  }

  private async projectCurrent(
    review: Review<LocalReviewSource>,
  ): Promise<Result<ReviewWorkbenchProjection, LocalReviewOpenFailure>> {
    const projected = await this.projection.loadLocal({
      profileId: review.identity.profileId,
      sessionId: review.currentSessionId,
      refreshedAt: review.updatedAt,
      freshness: review.freshness,
    });
    return projected._tag === "ok"
      ? projected
      : err({
          reason:
            projected.error._tag === "SessionStorageUnavailable"
              ? "storage"
              : "not_found",
        });
  }
}

/**
 * The drafts carried to `session` by ADR 0002's rule, each against the new
 * session's patch of its origin view (#556 D6). Never reads the maintainer's
 * checkout. Undefined when the session cannot be read.
 */
async function carryToSession(
  drafts: ReadonlyArray<LocalDraft>,
  session: LocalReviewSession,
  preparation: Pick<LocalReviewSessionPreparation, "readCommitFiles">,
): Promise<ReadonlyArray<LocalDraft> | undefined> {
  const originView = (draft: LocalDraft): LocalPatchView =>
    draft.view ?? "combined";
  const pathsByView = new Map<LocalPatchView, Set<RepoRelativePath>>();
  for (const draft of drafts) {
    const paths = pathsByView.get(originView(draft)) ?? new Set();
    pathsByView.set(originView(draft), paths.add(draft.anchor.path));
  }
  const targets = new Map<LocalPatchView, LocalDraftCarryTarget>();
  for (const [view, paths] of pathsByView) {
    const target = await carryTargetOf(session, view, [...paths], preparation);
    if (target === undefined) return undefined;
    targets.set(view, target);
  }
  return drafts.map((draft) => {
    const target = targets.get(originView(draft));
    return target === undefined ? draft : carryLocalDraft(draft, target);
  });
}

/**
 * One view's patch of `session` and the text of `paths` in that view's new
 * tree: the Local snapshot, read from the session's worktree, for Combined
 * and Uncommitted; the checkout `HEAD` commit, read as git objects, for
 * Committed.
 */
async function carryTargetOf(
  session: LocalReviewSession,
  view: LocalPatchView,
  paths: ReadonlyArray<RepoRelativePath>,
  preparation: Pick<LocalReviewSessionPreparation, "readCommitFiles">,
): Promise<LocalDraftCarryTarget | undefined> {
  const patchPath =
    view === "combined"
      ? session.patchPath
      : session.viewPatches?.[view].patchPath;
  if (patchPath === undefined) return undefined;
  const patch = await readFile(patchPath, "utf8").catch(() => undefined);
  if (patch === undefined) return undefined;
  if (view === "committed") {
    if (session.checkoutHeadSha === undefined) return undefined;
    const files = await preparation.readCommitFiles(
      session,
      session.checkoutHeadSha,
      paths,
    );
    return { sessionId: session.id, patch, files };
  }
  // `readCheckoutFile` refuses any path whose resolution differs, so the root is resolved first.
  const root = await realpath(session.worktree.path).catch(() => undefined);
  if (root === undefined) return undefined;
  const files = new Map<RepoRelativePath, string>();
  await Promise.all(
    paths.map(async (path) => {
      const bytes = await readCheckoutFile(root, path);
      if (bytes !== undefined) files.set(path, bytes.toString("utf8"));
    }),
  );
  return { sessionId: session.id, patch, files };
}

/** `branch_mismatch` when the checkout's `HEAD` is not the one the request expects; a shared Review names a detached `HEAD` `detachedHeadBranch`. */
function headMismatch(
  request: LocalReviewSourceRequest,
  source: LocalReviewSource,
): LocalBranchMismatch | undefined {
  if (
    request.kind !== "local_branch" ||
    request.expectedHead === undefined ||
    source.kind !== "local_branch"
  )
    return undefined;
  const expected =
    request.expectedHead.kind === "branch"
      ? request.expectedHead.branch
      : detachedHeadBranch;
  if (source.branch === expected) return undefined;
  return {
    reason: "branch_mismatch",
    ...definedProps({
      currentBranch:
        source.branch === detachedHeadBranch ? undefined : source.branch,
    }),
  };
}

function mapPreparationFailure(
  failure: LocalReviewPreparationFailure,
): LocalReviewOpenFailure {
  switch (failure._tag) {
    case "ProfileNotFound":
      return { reason: "not_found" };
    case "RepositoryNotLocal":
      return { reason: "repository_not_local" };
    case "CheckoutNotInRepository":
      return { reason: "checkout_not_found" };
    case "CheckoutMissing":
      return { reason: "checkout_missing", localPath: failure.localPath };
    case "UnmergedIndex":
      return { reason: "unmerged_index" };
    case "UntrackedTooLarge":
      return {
        reason: "untracked_too_large",
        exceededLimit: failure.exceededLimit,
        largestPaths: failure.largestPaths,
      };
    case "LocalRevisionNotFound":
      return { reason: "revision_not_found" };
    case "PatchTooLarge":
      return { reason: "patch_too_large", largestFiles: failure.largestFiles };
    case "ProfileUnavailable":
    case "LocalGitFailed":
    case "SessionStorageUnavailable":
    case "PreparationUnavailable":
    case "PreparationCleanupUnavailable":
      return { reason: "storage" };
    default:
      return casesHandled(failure);
  }
}
