import {
  createReviewSessionId,
  type AbsolutePath,
  type ContentHash,
  type GitSha,
  type IsoTimestamp,
  type ReviewSessionId,
} from "./ids";
import { definedProps } from "./defined-props";
import type { LocalPatchView } from "./local-patch-view";
import type { ReviewIdentity } from "./review";
import type {
  LocalReviewSource,
  PullRequestReviewSource,
  ReviewSource,
} from "./review-source";
import type { PullRequestSnapshot } from "./github-context";
import type { DirectSummaryReviewState } from "./direct-summary-review";
import type {
  FindingReviewReceipt,
  PendingReviewState,
} from "./pending-review";

export type ReviewLocalCheckoutWarning =
  | "missing_local_path"
  | "local_checkout_unavailable";

/** The fields every session kind shares; the kind lives in `key.source`. */
export type ReviewSessionFields = {
  readonly schemaVersion: 6;
  readonly id: ReviewSessionId;
  readonly patchPath: AbsolutePath;
  readonly canonicalPatchHash?: ContentHash;
  readonly localCheckoutWarning?: ReviewLocalCheckoutWarning;
  readonly worktree: ReviewWorktreeRef;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

/**
 * Immutable local artifacts and current durable GitHub-write evidence for one
 * pinned pull request revision. `pr`, `prContext`, and the GitHub pending
 * review state exist only on this kind (ADR 0050).
 */
export type PullRequestReviewSession = ReviewSessionFields & {
  readonly key: ReviewSessionKey<PullRequestReviewSource>;
  readonly pr: PullRequestSnapshot & { readonly baseSha: GitSha };
  readonly prContext?: {
    readonly title: string;
    readonly description?: string;
    readonly author: string;
    readonly headBranch: string;
    readonly baseBranch: string;
  };
  readonly pendingReview?: PendingReviewState;
  readonly findingReviewReceipts?: ReadonlyArray<FindingReviewReceipt>;
  readonly directSummaryReview?: DirectSummaryReviewState;
};

/** Immutable local artifacts for one pinned revision of a local Review source. */
export type LocalReviewSession = ReviewSessionFields & {
  readonly key: ReviewSessionKey<LocalReviewSource>;
  /**
   * The checkout's `HEAD` when a shared Review's Local snapshot was taken:
   * the snapshot's parent, so it is not part of the session key. Present on
   * every `local_branch` session, absent on the other kinds.
   */
  readonly checkoutHeadSha?: GitSha;
  /**
   * The checkout's read-only fingerprint from the latest prepare that landed
   * on this session (#611), which the update check compares with the
   * checkout. Metadata, not identity: a later prepare may replace it. Only a
   * `local_branch` session has one, and not always: one stored before #611,
   * or whose fingerprint could not be read, has none.
   */
  readonly checkoutFingerprint?: ContentHash;
  /**
   * The session's three patches, written at prepare so a view switch reads a
   * stored file and runs no git. Present on every `local_branch` session,
   * absent on the other kinds; Combined is `patchPath` itself.
   */
  readonly viewPatches?: LocalSessionViewPatches;
  /**
   * The commits in `baseSha..checkoutHeadSha`, listed at prepare so the
   * navigator runs no git (#557 D1). Present on every `local_branch` session,
   * absent on the other kinds.
   */
  readonly commits?: LocalSessionCommits;
};

/** One commit of a shared Review's branch, as `git log` reports it. */
export type LocalCommit = {
  readonly sha: GitSha;
  readonly subject: string;
  readonly authorName: string;
  readonly authoredAt: IsoTimestamp;
};

/** The newest commits of a shared Review's branch, capped (#557 D3), and how many there are in all. */
export type LocalSessionCommits = {
  readonly newest: ReadonlyArray<LocalCommit>;
  readonly total: number;
};

/** One stored patch of a local session and the paths it touches (`listPatchTouchedPaths`). */
export type LocalSessionViewPatch = {
  readonly patchPath: AbsolutePath;
  readonly patchHash: ContentHash;
  readonly paths: ReadonlyArray<string>;
};

export type LocalSessionViewPatches = Readonly<
  Record<LocalPatchView, LocalSessionViewPatch>
>;

/** The local work for one pinned revision of a Review source. */
export type ReviewSession = PullRequestReviewSession | LocalReviewSession;

/** Narrow a session to the pull request kind before any GitHub read or write. */
export function isPullRequestReviewSession(
  session: ReviewSession,
): session is PullRequestReviewSession {
  return session.key.source.kind === "pull_request";
}

/** A Review identity plus the pinned revision; the session id is derived from it. */
export type ReviewSessionKey<Source extends ReviewSource = ReviewSource> =
  ReviewIdentity<Source> & ReviewRevision;

export type ReviewRevision = {
  readonly headSha: GitSha;
  readonly baseSha: GitSha;
};

export function sameReviewRevision(
  left: ReviewRevision,
  right: ReviewRevision,
): boolean {
  return left.headSha === right.headSha && left.baseSha === right.baseSha;
}

export type ReviewWorktreeRef = {
  readonly path: AbsolutePath;
  readonly headSha: GitSha;
};

/** Constructs a deterministic session without filesystem or GitHub effects. */
export function createReviewSession(input: {
  readonly key: ReviewSessionKey<PullRequestReviewSource>;
  readonly pr: PullRequestSnapshot & { readonly baseSha: GitSha };
  readonly prContext?: PullRequestReviewSession["prContext"];
  readonly patchPath: AbsolutePath;
  readonly canonicalPatchHash?: ContentHash;
  readonly localCheckoutWarning?: ReviewLocalCheckoutWarning;
  readonly worktree: ReviewWorktreeRef;
  readonly createdAt: IsoTimestamp;
}): PullRequestReviewSession {
  return {
    schemaVersion: 6,
    id: createReviewSessionId(input.key),
    key: input.key,
    pr: input.pr,
    patchPath: input.patchPath,
    worktree: input.worktree,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    ...definedProps({
      prContext: input.prContext,
      canonicalPatchHash: input.canonicalPatchHash,
      localCheckoutWarning: input.localCheckoutWarning,
    }),
  };
}

/**
 * Constructs a local session; its patch hash is the hash of the patch as
 * written (ADR 0050). A `local_branch` session needs `checkoutHeadSha`,
 * `viewPatches`, and `commits`, and the other kinds take none; the session store refuses
 * to save or read one that breaks this.
 */
export function createLocalReviewSession(input: {
  readonly key: ReviewSessionKey<LocalReviewSource>;
  readonly patchPath: AbsolutePath;
  readonly canonicalPatchHash: ContentHash;
  readonly worktree: ReviewWorktreeRef;
  readonly createdAt: IsoTimestamp;
  readonly checkoutHeadSha?: GitSha;
  readonly checkoutFingerprint?: ContentHash;
  readonly viewPatches?: LocalSessionViewPatches;
  readonly commits?: LocalSessionCommits;
}): LocalReviewSession {
  return {
    schemaVersion: 6,
    id: createReviewSessionId(input.key),
    key: input.key,
    patchPath: input.patchPath,
    canonicalPatchHash: input.canonicalPatchHash,
    worktree: input.worktree,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    ...definedProps({
      checkoutHeadSha: input.checkoutHeadSha,
      checkoutFingerprint: input.checkoutFingerprint,
      viewPatches: input.viewPatches,
      commits: input.commits,
    }),
  };
}
