import { createHash } from "node:crypto";
import type { GitHubReader } from "../adapters/github/github-adapter";
import type { GitHubReadFailure } from "../adapters/github/gh-request-runner";
import { readFile, stat } from "node:fs/promises";

import {
  avatarDataUri,
  hashAvatarUrl,
} from "../adapters/storage/avatar-cache-store";
import type { InsightStore } from "../adapters/storage/insight-store";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
import type { LocalApplyOperationStore } from "../adapters/storage/local-apply-operation-store";
import type { ViewedFilesStore } from "../adapters/storage/viewed-files-store";
import type { ReviewWriteIntentTag } from "../domain/review-write-operation";
import {
  sessionRepresentsReview,
  type ReviewFreshness,
} from "../domain/review";
import type { ReviewRemoteSnapshot } from "../adapters/storage/review-remote-store";
import type {
  CheckSummary,
  Conversation,
  ConversationEntry,
  GitHubComment,
  GitHubMergeEvidence,
  MergeDisplayReason,
  PullRequestCommit,
  PullRequestSummary,
} from "../domain/github-context";
import {
  createReviewId,
  parseGitHubLogin,
  type GitHubHost,
  type GitHubOwner,
  type GitSha,
  type IsoTimestamp,
  type ReviewId,
  type ContentHash,
  type GitHubRepoName,
  type RepoRelativePath,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import {
  projectStoredInsight,
  type InsightProjection,
} from "../domain/insight";
import { changeScopeFromPatch, type ChangeScope } from "../domain/change-scope";
import type { NormalizedBrief } from "../domain/brief";
import { definedProps } from "../domain/defined-props";
import type { NarrativeWalkthrough } from "../domain/narrative-walkthrough";
import {
  evaluateMergeReadiness,
  readinessMergeability,
  type MergeReadiness,
} from "../domain/merge-readiness";
import { deriveMergeReasons } from "../domain/merge-display-reasons";
import {
  projectAnalysisReviewActions,
  type AnalysisReviewActionsProjection,
  type WorkbenchRevisionFreshness,
} from "../domain/analysis-review-actions";
import {
  analysisMergeInput,
  mergeGateFindings,
  projectAnalysisFindings,
} from "../domain/analysis-merge-findings";
import type { PendingReviewProjection } from "./pending-review-service";
import {
  projectDirectSummaryReview,
  type DirectSummaryReviewProjection,
} from "./direct-summary-review-service";
import { projectPendingReview } from "./pending-review-service";
import type { PendingReviewState } from "../domain/pending-review";
import type { ReviewResult } from "../domain/review-result";
import {
  isPullRequestReviewSession,
  type ReviewSession,
} from "../domain/review-session";
import type { ReviewSource } from "../domain/review-source";
import { err, ok, type Result } from "../domain/result";
import { RetainedInsightReader } from "./retained-insight-reader";

/** Renderer-safe Session identity. It deliberately omits patch/worktree paths and durable internals. */
type WorkbenchSessionProjection = {
  readonly id: ReviewSessionId;
  readonly key: {
    readonly profileId: WorkspaceProfileId;
    readonly host: GitHubHost;
    readonly owner: GitHubOwner;
    readonly repo: GitHubRepoName;
    readonly source: ReviewSource;
    readonly headSha: GitSha;
  };
};
/** Bounded renderer view of the one durable Review write awaiting recovery. */
type RemoteWriteRecoveryProjection = {
  readonly operation: ReviewWriteIntentTag;
  readonly resolution: "check_required" | "manual_resolution_required";
};

export type ReviewWorkbenchProjection = {
  readonly state: "review";
  /** Configured GitHub account identity used to verify self-assignment receipts. */
  readonly viewerLogin: string;
  readonly review: {
    readonly id: ReviewId;
    readonly status: "open" | "merged" | "closed";
    /** Absent until the maintainer first leaves the Review; Conversation marks nothing without it. */
    readonly lastLooked?: { readonly seenThrough?: IsoTimestamp };
  };
  readonly session: WorkbenchSessionProjection;
  readonly localCheckout?: {
    readonly state: "metadata_only";
    readonly message: string;
  };
  readonly revision: {
    readonly reviewedHeadSha: GitSha;
    readonly patchHash?: ContentHash;
    readonly currentHeadSha?: GitSha;
    readonly freshness: WorkbenchRevisionFreshness;
    readonly refreshedAt: IsoTimestamp;
  };
  readonly fullPatch?: string;
  /** Files marked Viewed in this session's Diff; absent when the record could not be read. */
  readonly viewedPaths?: ReadonlyArray<RepoRelativePath>;
  /**
   * The represented patch bucketed into core/tests/generated/docs/config.
   * Absent exactly when `fullPatch` is: an all-zero gauge would claim the
   * pull request changes nothing rather than that its bytes were unreadable.
   */
  readonly scope?: ChangeScope;
  readonly pullRequest?: PullRequestSummary;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly insights: {
    readonly analysis: InsightProjection<ReviewResult>;
    readonly walkthrough: InsightProjection<NarrativeWalkthrough>;
    readonly brief: InsightProjection<NormalizedBrief>;
  };
  /** Absent on a local Review, which has no Finding review command (ADR 0050). */
  readonly analysisReviewActions?: AnalysisReviewActionsProjection;
  readonly pendingReview?: PendingReviewProjection;
  readonly directSummary?: DirectSummaryReviewProjection;
  /** Advisory only; the direct-summary service rechecks the account and PR author before writing. */
  readonly directSummaryDecision?: "allowed" | "blocked_author" | "unknown";
  readonly conversation: Conversation;
  readonly checks: CheckSummary;
  readonly mergeReadiness: MergeReadiness;
  readonly mergeReasons: ReadonlyArray<MergeDisplayReason>;
  readonly remoteWriteRecovery?: RemoteWriteRecoveryProjection;
  /** An Apply on this local Review whose outcome is not settled; further Applies wait for a check (ADR 0050). */
  readonly localApply?: {
    readonly state: "outcome_unknown" | "check_required";
  };
};

/** A patch file's contents plus the identity a cached hash of them is keyed on. */
type ReadPatchFile = {
  readonly contents: string;
  /** Absent when the file was readable but could not be stat'd, so its hash cannot be cached. */
  readonly identity?: { readonly size: number; readonly modifiedAtMs: number };
};

type CachedPatchHash = {
  readonly hash: ContentHash;
  readonly size: number;
  readonly modifiedAtMs: number;
};

const maxCachedPatchHashes = 32;

/**
 * Stat before read, matching `ReviewDiffSourceService.loadPatchIndex`: a
 * write landing between the two then pairs the older identity with the newer
 * bytes, so the next projection misses the cache and rehashes, rather than
 * pairing a newer identity with bytes it never hashed.
 */
async function readPatchFile(path: string): Promise<ReadPatchFile | undefined> {
  const stats = await stat(path).catch(() => undefined);
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the ordering is the point: awaiting these together lets a concurrent write pair a newer identity with older bytes, which would cache a hash that never matches the file again
  const contents = await readFile(path, "utf8").catch(() => undefined);
  if (contents === undefined) return undefined;
  return {
    contents,
    ...definedProps({
      identity:
        stats === undefined
          ? undefined
          : { size: stats.size, modifiedAtMs: stats.mtimeMs },
    }),
  };
}

export type LoadWorkbenchInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
};

export type WorkbenchProjectionFailure =
  | { readonly _tag: "ProfileNotFound" }
  | { readonly _tag: "SessionNotFound" }
  | { readonly _tag: "ReviewNotFound" }
  | { readonly _tag: "SessionStorageUnavailable" };

/** Live-read evidence `project` combines with the durable Session; absent when no GitHub read was attempted. */
type ProjectRemoteInput = {
  readonly current: Awaited<ReturnType<GitHubReader["getPullRequest"]>>;
  readonly conversation: Result<Conversation, GitHubReadFailure>;
  readonly commits?: ReadonlyArray<PullRequestCommit>;
  /** Whichever check read classified `required`; see `loadRepresented`. */
  readonly checks: Awaited<ReturnType<GitHubReader["getPullRequestChecks"]>>;
  readonly mergeEvidence?: GitHubMergeEvidence;
  /** `snapshot.mergePolicy?.complete`; absent means no read was attempted. */
  readonly mergePolicyComplete?: boolean;
};
/**
 * Read-side owner of the renderer-safe model for the exact snapshot held by
 * the durable Review. It never performs live GitHub reads or session-only
 * projection.
 */
export class ReviewWorkbenchProjectionService {
  private readonly retainedInsights: RetainedInsightReader;
  private readonly patchHashes = new Map<string, CachedPatchHash>();

  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly reviews: Pick<ReviewStore, "load">,
    private readonly insights: Pick<InsightStore, "loadTyped">,
    private readonly paths: PatchdeskPaths,
    private readonly writeOperations: Pick<ReviewWriteOperationStore, "load">,
    private readonly viewedFiles: Pick<ViewedFilesStore, "load">,
    private readonly localApplyOperations: Pick<
      LocalApplyOperationStore,
      "load"
    >,
  ) {
    this.retainedInsights = new RetainedInsightReader(
      this.sessions,
      this.insights,
    );
  }

  /** Projects the exact remote snapshot represented by the durable Review. */
  async loadRepresented(input: {
    readonly profileId: WorkspaceProfileId;
    readonly sessionId: ReviewSessionId;
    readonly snapshot: ReviewRemoteSnapshot;
    readonly refreshedAt: IsoTimestamp;
    readonly freshness: ReviewFreshness;
    readonly pendingReview?: {
      readonly state: PendingReviewState;
      readonly unavailable: boolean;
    };
  }): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const session = await this.loadSession({
      profileId: input.profileId,
      sessionId: input.sessionId,
    });
    if (session._tag === "err") return session;
    if (!isPullRequestReviewSession(session.value.session))
      return err({ _tag: "SessionNotFound" });
    const remote: ProjectRemoteInput = {
      current: { _tag: "ok", value: input.snapshot.pullRequest },
      conversation: ok(input.snapshot.conversation),
      commits: input.snapshot.commits,
      // Only a complete merge policy says which checks GitHub requires, and
      // the merge gate reads that same field, so badge and gate cannot
      // disagree. An incomplete read classified nothing and may be truncated.
      checks: ok(
        input.snapshot.mergePolicy?.complete === true
          ? input.snapshot.mergePolicy.checks
          : input.snapshot.checks,
      ),
      ...definedProps({
        mergeEvidence: input.snapshot.mergeEvidence,
        mergePolicyComplete: input.snapshot.mergePolicy?.complete,
      }),
    };
    return this.project(
      session.value.profile,
      session.value.session,
      remote,
      input.refreshedAt,
      input.freshness,
      input.pendingReview,
    );
  }

  /**
   * Projects a local Review's current session. It has no GitHub snapshot, so
   * Conversation, checks, merge, and the pending review stay empty or absent.
   */
  async loadLocal(input: {
    readonly profileId: WorkspaceProfileId;
    readonly sessionId: ReviewSessionId;
    readonly refreshedAt: IsoTimestamp;
    readonly freshness: ReviewFreshness;
  }): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const session = await this.loadSession(input);
    if (session._tag === "err") return session;
    if (isPullRequestReviewSession(session.value.session))
      return err({ _tag: "SessionNotFound" });
    return this.project(
      session.value.profile,
      session.value.session,
      undefined,
      input.refreshedAt,
      input.freshness,
    );
  }

  private async loadSession(input: LoadWorkbenchInput): Promise<
    Result<
      {
        readonly profile: WorkspaceProfileConfig;
        readonly session: ReviewSession;
      },
      WorkbenchProjectionFailure
    >
  > {
    const [profile, session] = await Promise.all([
      this.profiles.load(input.profileId),
      this.sessions.load(input.profileId, input.sessionId),
    ]);
    if (profile._tag === "err") return err({ _tag: "ProfileNotFound" });
    if (session._tag === "err") return err({ _tag: "SessionNotFound" });
    return ok({ profile: profile.value, session: session.value });
  }

  /**
   * Resolves each comment's `authorAvatarUrl` to a cached `data:` URI the
   * renderer's `img-src 'self' data:` CSP can actually load. Only
   * `conversation.entries` (`IssueComment`/`ReviewComment`/`GeneralThread`) and
   * `conversation.inline` reach the renderer via `ConversationThreadCard`;
   * `ReviewSummary`/`PrDescription` entries carry no comment and pass
   * through untouched. A per-call cache avoids re-reading the same avatar
   * file for every comment a repeat commenter left.
   */
  private async resolveAvatars(
    conversation: Conversation,
    profileId: WorkspaceProfileId,
  ): Promise<Conversation> {
    const resolved = new Map<string, string | undefined>();
    const resolveUrl = async (
      avatarUrl: string,
    ): Promise<string | undefined> => {
      const cached = resolved.get(avatarUrl);
      if (cached !== undefined || resolved.has(avatarUrl)) return cached;
      const read = await avatarDataUri(
        this.paths,
        profileId,
        hashAvatarUrl(avatarUrl),
      );
      const dataUri = read._tag === "ok" ? read.value : undefined;
      resolved.set(avatarUrl, dataUri);
      return dataUri;
    };
    const resolveComment = async <T extends GitHubComment>(
      comment: T,
    ): Promise<T> => {
      if (comment.authorAvatarUrl === undefined) return comment;
      const dataUri = await resolveUrl(comment.authorAvatarUrl);
      return dataUri === undefined
        ? comment
        : { ...comment, authorAvatarDataUri: dataUri };
    };
    const entries = await Promise.all(
      conversation.entries.map(async (entry): Promise<ConversationEntry> => {
        if (entry._tag === "IssueComment")
          return { ...entry, comment: await resolveComment(entry.comment) };
        if (entry._tag === "ReviewComment")
          return { ...entry, comment: await resolveComment(entry.comment) };
        if (entry._tag === "GeneralThread")
          return {
            ...entry,
            thread: {
              ...entry.thread,
              comments: await Promise.all(
                entry.thread.comments.map(resolveComment),
              ),
            },
          };
        return entry;
      }),
    );
    const inlineThreads = conversation.inline;
    const inline =
      inlineThreads === undefined
        ? undefined
        : {
            ...inlineThreads,
            threads: await Promise.all(
              inlineThreads.threads.map(async (thread) => ({
                ...thread,
                comments: await Promise.all(
                  thread.comments.map(resolveComment),
                ),
              })),
            ),
          };
    return { ...conversation, entries, ...definedProps({ inline }) };
  }

  /**
   * Hashes the patch at most once per `(path, size, mtimeMs)` identity, the
   * same cache key `ReviewDiffSourceService.loadPatchIndex` uses. The hash
   * decides whether a retained Insight still describes the bytes on disk, so
   * it stays derived from the file rather than read off the Session record: a
   * patch replaced under a live Session must still project a different hash.
   */
  private patchHashOf(patchPath: string, patch: ReadPatchFile): ContentHash {
    const identity = patch.identity;
    const cached = this.patchHashes.get(patchPath);
    if (
      identity !== undefined &&
      cached !== undefined &&
      cached.size === identity.size &&
      cached.modifiedAtMs === identity.modifiedAtMs
    ) {
      this.patchHashes.delete(patchPath);
      this.patchHashes.set(patchPath, cached);
      return cached.hash;
    }
    // SAFETY: `createHash("sha256").digest("hex")` always yields a
    // 64-character lowercase hex string, which already satisfies
    // ContentHash's runtime shape (`parseContentHash` checks exactly
    // `/^[a-f0-9]{64}$/`).
    const hash = createHash("sha256")
      .update(patch.contents)
      .digest("hex") as ContentHash;
    if (identity === undefined) return hash;
    this.patchHashes.delete(patchPath);
    this.patchHashes.set(patchPath, { hash, ...identity });
    while (this.patchHashes.size > maxCachedPatchHashes) {
      // SAFETY: the loop condition guarantees a nonempty map, so the iterator
      // yields a key.
      const oldest = this.patchHashes.keys().next().value as string;
      this.patchHashes.delete(oldest);
    }
    return hash;
  }

  private async project(
    profile: WorkspaceProfileConfig,
    session: ReviewSession,
    remote: ProjectRemoteInput | undefined,
    representedAt: IsoTimestamp,
    durableFreshness: ReviewFreshness,
    pendingReview?: {
      readonly state: PendingReviewState;
      readonly unavailable: boolean;
    },
  ): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const viewerLogin = parseGitHubLogin(profile.ghAccount);
    if (viewerLogin._tag === "err")
      return err({ _tag: "SessionStorageUnavailable" });
    const [patch, storedInsights, viewed] = await Promise.all([
      readPatchFile(session.patchPath),
      this.retainedInsights.loadStoredInsights(session),
      this.viewedFiles.load(session.key.profileId, session.id),
    ]);
    if (storedInsights._tag === "err") return storedInsights;
    const fullPatch = patch?.contents;
    const patchHash =
      patch === undefined
        ? undefined
        : this.patchHashOf(session.patchPath, patch);

    const pullRequestSession = isPullRequestReviewSession(session)
      ? session
      : undefined;
    const current = remote?.current;
    const currentHeadSha =
      current?._tag === "ok" ? current.value.headSha : undefined;
    const pullRequest =
      current?._tag === "ok"
        ? current.value
        : pullRequestSession?.prContext === undefined
          ? undefined
          : {
              ref: {
                host: pullRequestSession.key.host,
                owner: pullRequestSession.key.owner,
                repo: pullRequestSession.key.repo,
                number: pullRequestSession.key.source.prNumber,
              },
              ...pullRequestSession.prContext,
              headSha: pullRequestSession.key.headSha,
              isDraft: pullRequestSession.pr.isDraft,
              isOpen: pullRequestSession.pr.isOpen,
              reviewState: "unknown" as const,
              mergeability: "unknown" as const,
              labels: [],
              updatedAt: session.updatedAt,
            };
    const checks: CheckSummary =
      remote?.checks?._tag === "ok"
        ? remote.checks.value
        : { overall: "unknown", checks: [] };
    const rawConversation: Conversation =
      remote?.conversation?._tag === "ok"
        ? remote.conversation.value
        : { prDescription: "", entries: [] };
    const conversation = await this.resolveAvatars(
      rawConversation,
      session.key.profileId,
    );
    const freshness =
      durableFreshness._tag === "Fresh"
        ? ("fresh" as const)
        : durableFreshness._tag === "RevisionChanged"
          ? ("updates_available" as const)
          : ("unavailable" as const);
    const refreshedAt = representedAt;
    // One aggregate feeds both the readiness verdict and the reasons panel.
    const mergeAggregate = aggregateMergeEvidence(
      current?._tag === "ok" ? current.value : undefined,
      remote?.mergeEvidence,
    );
    const mergeReadiness =
      current?._tag === "ok" &&
      remote?.checks?._tag === "ok" &&
      mergeAggregate !== undefined
        ? evaluateMergeReadiness({
            isCurrentHead: current.value.headSha === session.key.headSha,
            isOpen: current.value.isOpen,
            isDraft: current.value.isDraft,
            mergeability: readinessMergeability(
              mergeAggregate,
              remote?.mergePolicyComplete,
            ),
            checks,
            hasFailingChecks: checks.overall === "failing",
            hasGitHubReviewBlocker:
              mergeAggregate.reviewDecision === "review_required",
            hasRequestChanges:
              mergeAggregate.reviewDecision === "changes_requested",
            // The merge gate reads the same Findings through the same two
            // helpers, so the badge never offers a merge the gate refuses.
            ...analysisMergeInput(
              mergeGateFindings(
                storedInsights.value.analysis,
                {
                  sessionId: session.id,
                  headSha: session.key.headSha,
                  patchHash,
                },
                pullRequestSession?.findingReviewReceipts,
              ),
              profile.analysisMergePolicy,
            ),
          })
        : {
            _tag: "Blocked" as const,
            blockers: ["stale_head" as const],
            warnings: [],
          };
    const mergeReasons = deriveMergeReasons(mergeAggregate, checks);
    const analysis = projectStoredInsight(
      storedInsights.value.analysis,
      session,
      patchHash,
      (value, record) => projectAnalysisFindings(value, record),
      storedInsights.value.analysisScope,
      storedInsights.value.analysisArtifactStatus,
    );
    const walkthrough = projectStoredInsight(
      storedInsights.value.walkthrough,
      session,
      patchHash,
      undefined,
      undefined,
      storedInsights.value.walkthroughArtifactStatus,
    );
    // A retained Brief carries its own resolved citation labels, so it needs
    // neither a decorator nor a scope read -- only its artifact status, which
    // says whether the patch those citations were resolved against survives.
    const brief = projectStoredInsight(
      storedInsights.value.brief,
      session,
      patchHash,
      undefined,
      undefined,
      storedInsights.value.briefArtifactStatus,
    );
    const reviewId = createReviewId(session.key);
    const [stableReview, activeWrite, localApply] = await Promise.all([
      this.reviews.load(session.key.profileId, reviewId),
      this.writeOperations.load(session.key.profileId, reviewId),
      this.localApplyOperations.load(session.key.profileId, reviewId),
    ]);
    if (stableReview._tag === "err")
      return stableReview.error.reason === "not_found"
        ? err({ _tag: "ReviewNotFound" })
        : err({ _tag: "SessionStorageUnavailable" });
    if (activeWrite._tag === "err" || localApply._tag === "err")
      return err({ _tag: "SessionStorageUnavailable" });
    if (
      stableReview.value.id !== reviewId ||
      stableReview.value.currentSessionId !== session.id ||
      !sessionRepresentsReview(stableReview.value, session)
    )
      return err({ _tag: "SessionStorageUnavailable" });
    const reviewStatus =
      stableReview.value.status._tag === "Terminal"
        ? stableReview.value.status.state
        : ("open" as const);

    const analysisReviewActions =
      pullRequestSession === undefined
        ? undefined
        : projectAnalysisReviewActions({
            analysis,
            session: pullRequestSession,
            freshness,
            patchHash,
            pendingReview:
              pendingReview?.state ?? pullRequestSession.pendingReview,
            threads: conversation.inline?.threads ?? [],
          });

    const revision: ReviewWorkbenchProjection["revision"] = {
      reviewedHeadSha: session.key.headSha,
      freshness,
      refreshedAt,
      ...definedProps({ patchHash, currentHeadSha }),
    };

    const projection: ReviewWorkbenchProjection = {
      state: "review",
      viewerLogin: viewerLogin.value,
      review: {
        id: reviewId,
        status: reviewStatus,
        ...definedProps({
          lastLooked:
            stableReview.value.lastLooked === undefined
              ? undefined
              : definedProps({
                  seenThrough: stableReview.value.lastLooked.seenThrough,
                }),
        }),
      },
      session: projectSession(session),
      revision,
      commits: remote?.commits ?? [],
      insights: {
        analysis,
        walkthrough,
        brief,
      },
      // A local Review has no pending review and no Finding review command (ADR 0050).
      ...definedProps({
        analysisReviewActions,
        pendingReview:
          pullRequestSession === undefined
            ? undefined
            : projectPendingReview(
                pendingReview?.state ??
                  pullRequestSession.pendingReview ?? { _tag: "None" },
                pendingReview?.unavailable ??
                  pullRequestSession.pendingReview === undefined,
              ),
        directSummary:
          pullRequestSession === undefined
            ? undefined
            : projectDirectSummaryReview(
                pullRequestSession.directSummaryReview,
              ),
        directSummaryDecision:
          pullRequestSession === undefined
            ? undefined
            : directSummaryDecision(profile, pullRequest),
      }),
      conversation,
      checks,
      mergeReadiness,
      mergeReasons,
      ...definedProps({
        remoteWriteRecovery:
          activeWrite.value === undefined
            ? undefined
            : {
                operation: activeWrite.value.intent._tag,
                resolution:
                  activeWrite.value.state._tag === "OutcomeUnknown"
                    ? activeWrite.value.state.resolution
                    : "check_required",
              },
      }),
      ...definedProps({
        localApply:
          localApply.value?.state === "OutcomeUnknown"
            ? { state: "outcome_unknown" as const }
            : localApply.value?.state === "CheckRequired"
              ? { state: "check_required" as const }
              : undefined,
        localCheckout: projectLocalCheckoutWarning(
          session.localCheckoutWarning,
        ),
        fullPatch,
        viewedPaths: viewed._tag === "ok" ? viewed.value : undefined,
        scope:
          fullPatch === undefined ? undefined : changeScopeFromPatch(fullPatch),
        pullRequest,
      }),
    };
    return ok(projection);
  }
}

function directSummaryDecision(
  profile: WorkspaceProfileConfig,
  pullRequest: PullRequestSummary | undefined,
): "allowed" | "blocked_author" | "unknown" {
  if (pullRequest?.author === undefined || profile.ghAccount.length === 0)
    return "unknown";
  return pullRequest.author.toLowerCase() === profile.ghAccount.toLowerCase()
    ? "blocked_author"
    : "allowed";
}

function projectSession(session: ReviewSession): WorkbenchSessionProjection {
  return {
    id: session.id,
    key: {
      profileId: session.key.profileId,
      host: session.key.host,
      owner: session.key.owner,
      repo: session.key.repo,
      source: session.key.source,
      headSha: session.key.headSha,
    },
  };
}

function projectLocalCheckoutWarning(
  warning: ReviewSession["localCheckoutWarning"],
): ReviewWorkbenchProjection["localCheckout"] {
  if (warning === undefined) return undefined;
  return {
    state: "metadata_only",
    message:
      warning === "missing_local_path"
        ? "No local checkout is configured. This Review uses the GitHub snapshot; local file expansion and commit inspection are unavailable."
        : "The local checkout could not be prepared. This Review uses the GitHub snapshot; local file expansion and commit inspection are unavailable.",
  };
}

// A Review projected without a merge-policy read falls back to the pull
// request summary's own review verdict. `unavailable` is the honest value for
// the missing aggregate field: it is not a merge-state claim.
function aggregateMergeEvidence(
  current: PullRequestSummary | undefined,
  evidence: GitHubMergeEvidence | undefined,
): GitHubMergeEvidence | undefined {
  if (evidence !== undefined) return evidence;
  if (current === undefined) return undefined;
  return {
    mergeable: current.mergeability,
    mergeStateStatus: "unavailable",
    reviewDecision:
      current.reviewState === "approved"
        ? "approved"
        : current.reviewState === "changes_requested"
          ? "changes_requested"
          : current.reviewState === "review_pending"
            ? "review_required"
            : "unknown",
  };
}
