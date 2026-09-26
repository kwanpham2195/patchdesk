import { readFile, realpath } from "node:fs/promises";

import { minLength, pipe, strictObject, string } from "valibot";

import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { ReviewStore } from "../adapters/storage/review-store";
import {
  createReviewId,
  parseContentHash,
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
import { carryLocalDraft } from "../domain/local-draft-carry";
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
import { contentHash } from "./review-artifact-hash";
import type {
  LocalReviewOpenRequest,
  LocalReviewPreparationFailure,
  LocalReviewSessionPreparation,
  ResolvedLocalReview,
} from "./local-review-session-preparation";
import type { ReviewRetention } from "./review-retention";
import type { RepositoryCheckout } from "./local-checkout";
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
  /** The checkout's `HEAD` is not the one the request expects; `currentBranch` is absent when it is detached. */
  | {
      readonly reason: "branch_mismatch";
      readonly currentBranch?: LocalBranchName;
    };

/** A working-tree Review refused because the checkout's `HEAD` moved to another branch. */
export type LocalBranchMismatch = Extract<
  LocalReviewOpenFailure,
  { readonly reason: "branch_mismatch" }
>;

/** Refresh refuses while another command holds the Review, and on a Review that is not local. */
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
  not_found: "not_found",
  repository_not_local: "not_found",
  checkout_not_found: "not_found",
  revision_not_found: "not_found",
  unmerged_index: "conflict",
  terminal: "conflict",
  branch_mismatch: "conflict",
  in_progress: "conflict",
  not_applicable: "conflict",
  storage: "unavailable",
} as const satisfies FailureKinds<LocalReviewRefreshFailure["reason"]>;

/**
 * Opens and refreshes a local Review (ADR 0050). Every open reads the source
 * from the checkout again, so unchanged content lands on the same session and
 * an edit moves the Review to a new one, carrying its Local drafts (#452).
 */
export class LocalReviewOpening {
  /** When each Review's last agent refresh started, in this process: the limit only bounds snapshot cost. */
  private readonly agentRefreshStartedAt = new Map<string, number>();

  constructor(
    private readonly preparation: Pick<
      LocalReviewSessionPreparation,
      "resolve" | "prepare" | "listCheckouts" | "findCheckout"
    >,
    private readonly projection: Pick<
      ReviewWorkbenchProjectionService,
      "loadLocal"
    >,
    private readonly lifecycle: {
      readonly reviews: Pick<ReviewStore, "load" | "save">;
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
      // Reading the source decides the Review id: a working tree is keyed by the branch `HEAD` names.
      const resolved = await this.preparation.resolve(request);
      if (resolved._tag === "err")
        return err(mapPreparationFailure(resolved.error));
      // The locked open proceeds only on this same Review id, and a working
      // tree's id is keyed by its branch, so checking here also holds under the lock.
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
   */
  async openForAgent(
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

  /** The profile repository and checkout an agent's working directory is in (ADR 0052 `review_local`). */
  async findCheckout(
    profileId: WorkspaceProfileId,
    directory: AbsolutePath,
  ): Promise<
    Result<
      {
        readonly repository: LocalReviewOpenRequest["repository"];
        readonly checkout: AbsolutePath;
      },
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
   * Review, and a working tree on another branch is refused as a reopen is.
   */
  async refresh(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<ReviewWorkbenchProjection, LocalReviewRefreshFailure>> {
    const key = `${profileId}:${reviewId}`;
    if (!this.lifecycle.coordinator.acquire(key))
      return err({ reason: "in_progress" });
    try {
      const resolved = await this.resolveStoredSource(profileId, reviewId);
      if (resolved._tag === "err") return resolved;
      return await this.moveToSession(resolved.value, reviewId);
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
   * session clears an earlier prepared session.
   */
  async prepareForAgent(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<LocalReviewPrepared, LocalReviewAgentRefreshFailure>> {
    const key = `${profileId}:${reviewId}`;
    const startedAt = Date.parse(this.now());
    const previous = this.agentRefreshStartedAt.get(key);
    if (
      previous !== undefined &&
      startedAt - previous < AGENT_REFRESH_INTERVAL_MS
    )
      return err({
        reason: "rate_limited",
        retryAfterMs: previous + AGENT_REFRESH_INTERVAL_MS - startedAt,
      });
    if (!this.lifecycle.coordinator.acquire(key))
      return err({ reason: "in_progress" });
    try {
      this.agentRefreshStartedAt.set(key, startedAt);
      const resolved = await this.resolveStoredSource(profileId, reviewId);
      if (resolved._tag === "err") return resolved;
      return await this.recordPrepared(resolved.value, reviewId);
    } finally {
      this.lifecycle.coordinator.release(key);
    }
  }

  /**
   * The refusal for opening a stored working-tree Review as stored while the
   * checkout is on another branch (#477), the rule `open` and `refresh` apply.
   * Undefined for any other source, and when the checkout cannot be read,
   * because a stored session shows without it.
   */
  async branchMismatch(
    review: Review<LocalReviewSource>,
  ): Promise<LocalBranchMismatch | undefined> {
    const { profileId, host, owner, repo, source } = review.identity;
    if (source.kind !== "working_tree") return undefined;
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
  ): Promise<Result<ResolvedLocalReview, LocalReviewRefreshFailure>> {
    const stored = await this.lifecycle.reviews.load(profileId, reviewId);
    if (stored._tag === "err")
      return err({
        reason: stored.error.reason === "not_found" ? "not_found" : "storage",
      });
    if (!isLocalReview(stored.value)) return err({ reason: "not_applicable" });
    const { host, owner, repo, source } = stored.value.identity;
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
    return resolved;
  }

  /** Prepares the resolved content's session and records it on the Review without moving it. The caller holds the Review lock. */
  private async recordPrepared(
    resolved: ResolvedLocalReview,
    reviewId: ReviewId,
  ): Promise<Result<LocalReviewPrepared, LocalReviewOpenFailure>> {
    const { profileId } = resolved.identity;
    const session = await this.preparation.prepare(resolved);
    if (session._tag === "err")
      return err(mapPreparationFailure(session.error));
    const { headSha, baseSha } = session.value.key;
    const patchHash = parseContentHash(
      await contentHash(session.value.patchPath),
    );
    if (patchHash._tag === "err") return err({ reason: "storage" });
    // Read after the preparation, as a move does, so the save carries every draft written meanwhile.
    const stored = await this.lifecycle.reviews.load(profileId, reviewId);
    if (stored._tag === "err" || !isLocalReview(stored.value))
      return err({ reason: "storage" });
    const review = stored.value;
    const changed = session.value.id !== review.currentSessionId;
    const now = this.now();
    const next = changed
      ? review.preparedSessionId === session.value.id
        ? undefined
        : recordPreparedLocalSession(review, {
            sessionId: session.value.id,
            identity: { headSha, baseSha, canonicalPatchHash: patchHash.value },
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
      patchHash: patchHash.value,
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
      carried = await carryToSession(drafts, session.value);
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
 * The drafts carried to `session` by ADR 0002's rule, reading the new patch
 * and each drafted file from the session's own worktree at its head, never
 * from the maintainer's checkout. Undefined when the session cannot be read.
 */
async function carryToSession(
  drafts: ReadonlyArray<LocalDraft>,
  session: LocalReviewSession,
): Promise<ReadonlyArray<LocalDraft> | undefined> {
  const [patch, root] = await Promise.all([
    readFile(session.patchPath, "utf8").catch(() => undefined),
    // `readCheckoutFile` refuses any path whose resolution differs, so the root is resolved first.
    realpath(session.worktree.path).catch(() => undefined),
  ]);
  if (patch === undefined || root === undefined) return undefined;
  const paths = new Set(drafts.map((draft) => draft.anchor.path));
  const files = new Map<RepoRelativePath, string>();
  await Promise.all(
    [...paths].map(async (path) => {
      const bytes = await readCheckoutFile(root, path);
      if (bytes !== undefined) files.set(path, bytes.toString("utf8"));
    }),
  );
  return drafts.map((draft) =>
    carryLocalDraft(draft, { sessionId: session.id, patch, files }),
  );
}

function headMismatch(
  request: LocalReviewSourceRequest,
  source: LocalReviewSource,
): LocalBranchMismatch | undefined {
  if (request.kind !== "working_tree" || request.expectedHead === undefined)
    return undefined;
  if (source.kind !== "working_tree") return undefined;
  const expected =
    request.expectedHead.kind === "branch"
      ? request.expectedHead.branch
      : undefined;
  if (source.branch === expected) return undefined;
  return {
    reason: "branch_mismatch",
    ...definedProps({ currentBranch: source.branch }),
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
    case "UnmergedIndex":
      return { reason: "unmerged_index" };
    case "LocalRevisionNotFound":
      return { reason: "revision_not_found" };
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
