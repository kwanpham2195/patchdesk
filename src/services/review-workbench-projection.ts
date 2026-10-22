import type { RetainedGuide } from "#src/domain/guide";
import type { AgentRunRequest } from "#src/domain/agent-run-request";
import type { GitHubReader } from "#src/adapters/github/github-adapter";
import type { GitHubReadFailure } from "#src/adapters/github/gh-request-runner";
import { readFile, stat } from "node:fs/promises";

import {
  avatarDataUri,
  hashAvatarUrl,
} from "#src/adapters/storage/avatar-cache-store";
import type { InsightStore } from "#src/adapters/storage/insight-store";
import type { InsightResourceBundle } from "#src/services/insight-resource-bundle";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type { ProfileStore } from "#src/adapters/storage/profile-store";
import type { WorkspaceProfileConfig } from "#src/domain/workspace-profile";
import type { ReviewSessionStore } from "#src/adapters/storage/review-session-store";
import type { ReviewStore } from "#src/adapters/storage/review-store";
import type { ReviewWriteOperationStore } from "#src/adapters/storage/review-write-operation-store";
import type { LocalApplyOperationStore } from "#src/adapters/storage/local-apply-operation-store";
import type { ViewedFilesStore } from "#src/adapters/storage/viewed-files-store";
import type { ReviewWriteIntentTag } from "#src/domain/review-write-operation";
import {
  isLocalReview,
  sessionRepresentsReview,
  type ReviewFreshness,
} from "#src/domain/review";
import {
  readFeedbackHandoff,
  type FeedbackHandoffReading,
} from "#src/domain/feedback-handoff";
import {
  projectAgentExplanation,
  type AgentExplanationEntry,
} from "#src/domain/agent-explanation";
import {
  projectLocalDraft,
  type LocalDraftEntry,
} from "#src/domain/local-draft";
import type { LocalDraftReply } from "#src/domain/local-draft-reply";
import type { LocalPatchView } from "#src/domain/local-patch-view";
import type { ReviewRemoteSnapshot } from "#src/adapters/storage/review-remote-store";
import type {
  CheckSummary,
  Conversation,
  ConversationEntry,
  GitHubComment,
  GitHubMergeEvidence,
  MergeDisplayReason,
  MergeMethod,
  PullRequestCommit,
  PullRequestSummary,
} from "#src/domain/github-context";
import {
  createReviewId,
  parseInsightRunId,
  parseReviewSessionId,
  parseGitSha,
  parseIsoTimestamp,
  type InsightRunId,
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
} from "#src/domain/ids";
import {
  projectStoredInsight,
  type InsightProjection,
} from "#src/domain/insight";
import {
  changeScopeFromPatch,
  type ChangeScope,
} from "#src/domain/change-scope";
import type { NormalizedBrief } from "#src/domain/brief";
import { definedProps } from "#src/domain/defined-props";
import type { WalkthroughSummary } from "#src/domain/walkthrough-progress";
import type { WalkthroughPageService } from "./walkthrough-result-pages";
import {
  evaluateMergeReadiness,
  readinessMergeability,
  type MergeReadiness,
} from "#src/domain/merge-readiness";
import { deriveMergeReasons } from "#src/domain/merge-display-reasons";
import {
  projectAnalysisReviewActions,
  type AnalysisReviewActionsProjection,
  type WorkbenchRevisionFreshness,
} from "#src/domain/analysis-review-actions";
import {
  analysisMergeInput,
  mergeGateFindings,
  projectAnalysisFindings,
} from "#src/domain/analysis-merge-findings";
import type { PendingReviewProjection } from "./pending-review-service";
import {
  projectDirectSummaryReview,
  type DirectSummaryReviewProjection,
} from "./direct-summary-review-service";
import { projectPendingReview } from "./pending-review-service";
import type { PendingReviewState } from "#src/domain/pending-review";
import type { ReviewResult } from "#src/domain/review-result";
import {
  isPullRequestReviewSession,
  type LocalSessionViewPatch,
  type LocalSessionViewPatches,
  type ReviewSession,
} from "#src/domain/review-session";
import type { ReviewSource } from "#src/domain/review-source";
import { err, ok, type Result } from "#src/domain/result";
import type { ChangeIntentView } from "#src/domain/change-intent";
import { changeIntentView } from "./local-change-intent-service";
import { asPullRequestCommit } from "./local-commit-listing";
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
  /** Files marked Viewed on this session's Combined Diff; absent when the record could not be read. */
  readonly viewedPaths?: ReadonlyArray<RepoRelativePath>;
  /**
   * Present exactly on a shared local Review: each patch view's hash and the
   * paths it touches, so a note is placed in any view before that view's
   * patch is fetched (ADR 0051). Read off the session record, not the files.
   */
  readonly patchViews?: Readonly<
    Record<
      LocalPatchView,
      {
        readonly patchHash: ContentHash;
        readonly paths: ReadonlyArray<string>;
      }
    >
  >;
  /** Present exactly on a shared local Review: whether the move onto this session left a patch to show as Since last Refresh (#604); `none` until a move records one, as on a Review's first session. */
  readonly sinceLastRefresh?: "available" | "none" | "base_moved";
  /**
   * The represented patch bucketed into core/tests/generated/docs/config.
   * Absent exactly when `fullPatch` is: an all-zero gauge would claim the
   * pull request changes nothing rather than that its bytes were unreadable.
   */
  readonly scope?: ChangeScope;
  readonly pullRequest?: PullRequestSummary;
  /** A pull request's commits, or on a shared local Review the newest of its branch's (#557 D1). */
  readonly commits: ReadonlyArray<PullRequestCommit>;
  /** Present exactly on a shared local Review: how many commits the branch has, which `commits` caps (#557 D3). */
  readonly commitTotal?: number;
  readonly insights: {
    readonly analysis: InsightProjection<ReviewResult>;
    readonly walkthrough: Omit<
      InsightProjection<Extract<WalkthroughSummary, { _tag: "ready" }>>,
      "retained"
    > & {
      readonly retained?: {
        readonly runId: InsightRunId;
        readonly sessionId: ReviewSessionId;
        readonly headSha: GitSha;
        readonly generatedAt: IsoTimestamp;
        readonly value: Extract<WalkthroughSummary, { _tag: "ready" }>;
      };
    };
    readonly brief: InsightProjection<NormalizedBrief>;
    readonly guide: InsightProjection<RetainedGuide>;
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
  /** The repository's allowed merge methods; absent when the represented snapshot does not record them. */
  readonly mergeMethods?: ReadonlyArray<MergeMethod>;
  readonly remoteWriteRecovery?: RemoteWriteRecoveryProjection;
  /** An Apply on this local Review whose outcome is not settled; further Applies wait for a check (ADR 0050). */
  readonly localApply?: {
    readonly state: "outcome_unknown" | "check_required";
  };
  /** Present exactly on a local Review, empty when nothing is drafted (ADR 0050 "Local drafts"). */
  readonly localDrafts?: ReadonlyArray<LocalDraftEntry>;
  /** Present exactly on a local Review: the coding agent's latest reply to each draft it answered, empty when none (#600). */
  readonly localDraftReplies?: ReadonlyArray<LocalDraftReply>;
  /** Present exactly on a local Review: the coding agent's explanations on diff lines, empty when none (#665). */
  readonly agentExplanations?: ReadonlyArray<AgentExplanationEntry>;
  /** Present exactly on a local Review, `null` when it has no Change intent (#467). */
  readonly changeIntent?: ChangeIntentView | null;
  /** Present exactly on a local Review, `null` when the drafts have not been handed off since the last move (#603). */
  readonly feedbackHandoff?: FeedbackHandoffReading | null;
  /** Present exactly on a local Review: the agent run requests on this session, empty when none (ADR 0052). */
  readonly agentRunRequests?: ReadonlyArray<AgentRunRequest>;
};

/** A patch file's contents plus the identity a cached hash of them is keyed on. */
type ReadPatchFile = {
  readonly contents: string;
  readonly identity: { readonly size: number; readonly modifiedAtMs: number };
};

type CachedPatchHash = ReadPatchFile["identity"] & {
  readonly hash: ContentHash;
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
  if (stats === undefined || contents === undefined) return undefined;
  return {
    contents,
    identity: { size: stats.size, modifiedAtMs: stats.mtimeMs },
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
  readonly allowedMergeMethods?: ReadonlyArray<MergeMethod>;
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
    private readonly jobs: InsightResourceBundle["jobs"],
    private readonly walkthroughPages: Pick<WalkthroughPageService, "summary">,
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
        allowedMergeMethods: input.snapshot.mergePolicy?.allowedMergeMethods,
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
   * Resolves comment `authorAvatarUrl` values to cached `data:` URIs allowed by
   * the renderer's `img-src 'self' data:` CSP. Only `conversation.entries`
   * (`IssueComment`/`ReviewComment`/`GeneralThread`) and `conversation.inline`
   * reach `ConversationThreadCard`; `ReviewSummary`/`PrDescription` pass through
   * unchanged. A per-call cache avoids rereading repeated commenters' avatars.
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
   * Hashes the patch at most once per `(path, size, mtimeMs)` identity, the key
   * `ReviewDiffSourceService.loadPatchIndex` uses. The hash stays derived from
   * the file, not the Session record, so a replaced patch projects a new hash.
   * The identity is taken before the read and after the hash; a write between
   * them retries once, then fails, so contents and hash describe one state.
   */
  private async readHashedPatch(
    patchPath: string,
  ): Promise<
    Result<
      (ReadPatchFile & { readonly hash: ContentHash }) | undefined,
      WorkbenchProjectionFailure
    >
  > {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the retry must observe the file after the previous attempt
      const patch = await readPatchFile(patchPath);
      if (patch === undefined) return ok(undefined);
      const identity = patch.identity;
      const cached = this.patchHashes.get(patchPath);
      const reused =
        cached?.size === identity.size &&
        cached.modifiedAtMs === identity.modifiedAtMs
          ? cached.hash
          : undefined;
      const hashed =
        reused === undefined ? await this.jobs.hashFile(patchPath) : ok(reused);
      if (hashed._tag === "err")
        return err({ _tag: "SessionStorageUnavailable" });
      const after = await stat(patchPath).catch(() => undefined);
      if (
        after?.size !== identity.size ||
        after.mtimeMs !== identity.modifiedAtMs
      )
        continue;
      this.patchHashes.delete(patchPath);
      this.patchHashes.set(patchPath, { hash: hashed.value, ...identity });
      if (this.patchHashes.size > maxCachedPatchHashes) {
        // SAFETY: the size check guarantees a nonempty map.
        const oldest = this.patchHashes.keys().next().value as string;
        this.patchHashes.delete(oldest);
      }
      return ok({ ...patch, hash: hashed.value });
    }
    return err({ _tag: "SessionStorageUnavailable" });
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
    const [hashedPatch, storedInsights, viewed, walkthroughSummary] =
      await Promise.all([
        this.readHashedPatch(session.patchPath),
        this.retainedInsights.loadStoredInsights(session),
        this.viewedFiles.load(session.key.profileId, session.id, "combined"),
        this.walkthroughPages.summary(
          session.key.profileId,
          createReviewId(session.key),
        ),
      ]);
    if (storedInsights._tag === "err") return storedInsights;
    if (hashedPatch._tag === "err") return hashedPatch;
    const fullPatch = hashedPatch.value?.contents;
    const patchHash = hashedPatch.value?.hash;

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
    const summary =
      walkthroughSummary._tag === "ok" ? walkthroughSummary.value : undefined;
    const ready = summary?._tag === "ready" ? summary : undefined;
    const retainedRun =
      ready === undefined ? undefined : parseInsightRunId(ready.runId);
    const retainedSession =
      ready === undefined ? undefined : parseReviewSessionId(ready.sessionId);
    const retainedHead =
      ready === undefined ? undefined : parseGitSha(ready.revision.headSha);
    const retainedAt =
      ready === undefined ? undefined : parseIsoTimestamp(ready.generatedAt);
    const walkthrough: ReviewWorkbenchProjection["insights"]["walkthrough"] = {
      status:
        summary === undefined
          ? "failed"
          : summary.run !== null
            ? "running"
            : summary.failure !== null &&
                summary.failure.reason !== "cancelled" &&
                summary.failure.reason !== "superseded"
              ? "failed"
              : ready === undefined
                ? "not_generated"
                : ready.sessionId === session.id &&
                    ready.revision.headSha === session.key.headSha &&
                    String(ready.revision.patchHash) === patchHash
                  ? "current"
                  : "outdated",
      ...definedProps({
        retained:
          ready === undefined ||
          retainedRun?._tag !== "ok" ||
          retainedSession?._tag !== "ok" ||
          retainedHead?._tag !== "ok" ||
          retainedAt?._tag !== "ok"
            ? undefined
            : {
                runId: retainedRun.value,
                sessionId: retainedSession.value,
                headSha: retainedHead.value,
                generatedAt: retainedAt.value,
                value: ready,
              },
      }),
    };
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
      commits:
        isPullRequestReviewSession(session) || session.commits === undefined
          ? (remote?.commits ?? [])
          : session.commits.newest.map((commit) =>
              asPullRequestCommit(commit, session.checkoutHeadSha),
            ),
      insights: {
        analysis,
        walkthrough,
        brief,
        guide: projectStoredInsight(
          storedInsights.value.guide,
          session,
          patchHash,
          undefined,
          undefined,
          storedInsights.value.guide?.retained === undefined
            ? undefined
            : "verified",
        ),
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
        mergeMethods: remote?.allowedMergeMethods,
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
        localDrafts: isLocalReview(stableReview.value)
          ? (stableReview.value.localDrafts ?? []).map(projectLocalDraft)
          : undefined,
        localDraftReplies: isLocalReview(stableReview.value)
          ? (stableReview.value.localDraftReplies ?? [])
          : undefined,
        agentExplanations: isLocalReview(stableReview.value)
          ? (stableReview.value.agentExplanations ?? []).map(
              projectAgentExplanation,
            )
          : undefined,
        agentRunRequests: isLocalReview(stableReview.value)
          ? (stableReview.value.agentRunRequests ?? []).filter(
              (request) => request.sessionId === session.id,
            )
          : undefined,
        changeIntent: !isLocalReview(stableReview.value)
          ? undefined
          : stableReview.value.changeIntent === undefined
            ? null
            : changeIntentView(stableReview.value.changeIntent),
        feedbackHandoff: isLocalReview(stableReview.value)
          ? (readFeedbackHandoff(stableReview.value.handoff) ?? null)
          : undefined,
        localCheckout: projectLocalCheckoutWarning(
          session.localCheckoutWarning,
        ),
        fullPatch,
        viewedPaths: viewed._tag === "ok" ? viewed.value : undefined,
        patchViews: isPullRequestReviewSession(session)
          ? undefined
          : projectPatchViews(session.viewPatches),
        sinceLastRefresh:
          isPullRequestReviewSession(session) ||
          session.viewPatches === undefined
            ? undefined
            : session.round === undefined
              ? "none"
              : session.round._tag === "Patch"
                ? "available"
                : "base_moved",
        commitTotal: isPullRequestReviewSession(session)
          ? undefined
          : session.commits?.total,
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

function projectPatchViews(
  views: LocalSessionViewPatches | undefined,
): ReviewWorkbenchProjection["patchViews"] {
  if (views === undefined) return undefined;
  const project = ({ patchHash, paths }: LocalSessionViewPatch) => ({
    patchHash,
    paths,
  });
  return {
    combined: project(views.combined),
    committed: project(views.committed),
    uncommitted: project(views.uncommitted),
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
