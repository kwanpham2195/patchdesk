import { createHash } from "node:crypto";
import type { GitHubReader } from "../adapters/github/github-adapter";
import { readFile } from "node:fs/promises";

import * as v from "valibot";

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
import type { ReviewFreshness } from "../domain/review";
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
  parseContentHash,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  parseReviewSessionId,
  type GitHubHost,
  type GitHubOwner,
  type GitSha,
  type IsoTimestamp,
  type PullRequestNumber,
  type ReviewId,
  type ContentHash,
  type GitHubRepoName,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type {
  InsightArtifactStatus,
  InsightProjection,
  InsightScopeProjection,
} from "../domain/insight";
import { parseUnifiedPatch } from "../domain/patch";
import {
  normalizeNarrativeWalkthrough,
  type NarrativeWalkthrough,
} from "../domain/narrative-walkthrough";
import type { MergeReadiness } from "../domain/merge-readiness";
import type {
  InsightFindingDismissal,
  InsightRecord,
  RetainedInsight,
} from "../domain/insight-record";
import {
  parseInsightProvider,
  parseInsightReasoning,
  type InsightProvenance,
} from "../domain/insight-provider";
import type { PendingReviewProjection } from "./pending-review-service";
import {
  projectDirectSummaryReview,
  type DirectSummaryReviewProjection,
} from "./direct-summary-review-service";
import { projectPendingReview } from "./pending-review-service";
import type { PendingReviewState } from "../domain/pending-review";
import { parseReviewResult, type ReviewResult } from "../domain/review-result";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import { readObjectField } from "./read-object-field";

/** Renderer-safe Session identity. It deliberately omits patch/worktree paths and durable internals. */
export type WorkbenchSessionProjection = {
  readonly id: ReviewSessionId;
  readonly key: {
    readonly profileId: WorkspaceProfileId;
    readonly host: GitHubHost;
    readonly owner: GitHubOwner;
    readonly repo: GitHubRepoName;
    readonly prNumber: PullRequestNumber;
    readonly headSha: GitSha;
  };
};
export type AnalysisFindingReviewStatus =
  | { readonly state: "actionable" }
  | { readonly state: "pending_review" }
  | { readonly state: "published" }
  | { readonly state: "locked" };

export type AnalysisReviewActionsProjection = {
  readonly findings: Readonly<Record<string, AnalysisFindingReviewStatus>>;
  readonly canFinishWithAnalysisSummary: boolean;
};

export type ReviewWorkbenchProjection = {
  readonly state: "review";
  readonly review: {
    readonly id: ReviewId;
    readonly status: "open" | "merged" | "closed";
  };
  readonly session: WorkbenchSessionProjection;
  readonly revision: {
    readonly reviewedHeadSha: GitSha;
    readonly patchHash?: ContentHash;
    readonly currentHeadSha?: GitSha;
    readonly freshness:
      | "fresh"
      | "updates_available"
      | "unavailable"
      | "not_refreshed";
    readonly refreshedAt: IsoTimestamp;
  };
  readonly fullPatch?: string;
  readonly pullRequest?: PullRequestSummary;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly insights: {
    readonly analysis: InsightProjection<ReviewResult>;
    readonly walkthrough: InsightProjection<NarrativeWalkthrough>;
  };
  readonly analysisReviewActions: AnalysisReviewActionsProjection;
  readonly pendingReview?: PendingReviewProjection;
  readonly directSummary?: DirectSummaryReviewProjection;
  /** Advisory only; the direct-summary service rechecks the account and PR author before writing. */
  readonly directSummaryDecision: "allowed" | "blocked_author" | "unknown";
  readonly conversation: Conversation;
  readonly checks: CheckSummary;
  readonly mergeReadiness: MergeReadiness;
  readonly mergeReasons: ReadonlyArray<MergeDisplayReason>;
};

export type LoadWorkbenchInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
};

export type WorkbenchProjectionFailure =
  | { readonly _tag: "ProfileNotFound" }
  | { readonly _tag: "SessionNotFound" }
  | { readonly _tag: "ReviewNotFound" }
  | { readonly _tag: "SessionStorageUnavailable" };

/** Mutable draft of `Conversation`, built in statements by `resolveAvatars`. */
type MutableConversation = {
  -readonly [K in keyof Conversation]: Conversation[K];
};

/** The remote-read snapshot `project` renders; `undefined` when only the durable Session is available. */
type ProjectRemoteInput = {
  readonly current: Awaited<ReturnType<GitHubReader["getPullRequest"]>>;
  readonly conversation: Awaited<ReturnType<GitHubReader["loadConversation"]>>;
  readonly commits?: ReadonlyArray<PullRequestCommit>;
  readonly checks: Awaited<ReturnType<GitHubReader["getPullRequestChecks"]>>;
  readonly mergeEvidence?: GitHubMergeEvidence;
};

/** Mutable draft of `ProjectRemoteInput`, built in statements by `loadRepresented`. */
type MutableProjectRemoteInput = {
  -readonly [K in keyof ProjectRemoteInput]: ProjectRemoteInput[K];
};

/** Mutable draft of `ReviewWorkbenchProjection["revision"]`, built in statements by `project`. */
type MutableRevisionProjection = {
  -readonly [K in keyof ReviewWorkbenchProjection["revision"]]: ReviewWorkbenchProjection["revision"][K];
};

/** Mutable draft of `ReviewWorkbenchProjection`, built in statements by `project`. */
type MutableReviewWorkbenchProjection = {
  -readonly [K in keyof ReviewWorkbenchProjection]: ReviewWorkbenchProjection[K];
};

/**
 * Read-side owner of the renderer-safe model for the exact snapshot held by
 * the durable Review. It never performs live GitHub reads or session-only
 * projection.
 */
export class ReviewWorkbenchProjectionService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly reviews: Pick<ReviewStore, "load">,
    private readonly insights: Pick<InsightStore, "loadTyped" | "load">,
    private readonly paths: PatchdeskPaths,
  ) {}

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
    const remote: MutableProjectRemoteInput = {
      current: { _tag: "ok", value: input.snapshot.pullRequest },
      conversation: ok(input.snapshot.conversation),
      commits: input.snapshot.commits,
      checks: { _tag: "ok", value: input.snapshot.checks },
    };
    if (input.snapshot.mergeEvidence !== undefined)
      remote.mergeEvidence = input.snapshot.mergeEvidence;
    return this.project(
      session.value.profile,
      session.value.session,
      remote,
      input.refreshedAt,
      input.freshness,
      input.pendingReview,
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
   * `conversation.entries` (`IssueComment`/`GeneralThread`) and
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
    const result: MutableConversation = { ...conversation, entries };
    if (conversation.inline !== undefined) {
      const inlineThreads = conversation.inline;
      result.inline = {
        ...inlineThreads,
        threads: await Promise.all(
          inlineThreads.threads.map(async (thread) => ({
            ...thread,
            comments: await Promise.all(thread.comments.map(resolveComment)),
          })),
        ),
      };
    }
    return result;
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
    const [fullPatch, storedInsights] = await Promise.all([
      readFile(session.patchPath, "utf8").catch(() => undefined),
      this.loadStoredInsights(session),
    ]);
    if (storedInsights._tag === "err") return storedInsights;
    const patchHash =
      fullPatch === undefined
        ? undefined
        : createHash("sha256").update(fullPatch).digest("hex");
    // SAFETY: `patchHash` is produced immediately above by
    // `createHash("sha256").digest("hex")`, which always yields a lowercase
    // 64-character hex string — exactly the syntax `parseContentHash`
    // checks — so this cast cannot diverge from a genuine `ContentHash`.
    const patchHashBranded = patchHash as ContentHash | undefined;

    const current = remote?.current;
    const currentHeadSha =
      current?._tag === "ok" ? current.value.headSha : undefined;
    const pullRequest =
      current?._tag === "ok"
        ? current.value
        : session.prContext === undefined
          ? undefined
          : {
              ref: {
                host: session.key.host,
                owner: session.key.owner,
                repo: session.key.repo,
                number: session.key.prNumber,
              },
              ...session.prContext,
              headSha: session.key.headSha,
              isDraft: session.pr.isDraft,
              isOpen: session.pr.isOpen,
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
    const mergeReadiness =
      current?._tag === "ok" && remote?.checks?._tag === "ok"
        ? evaluateReadiness(current.value, remote.checks.value, session)
        : {
            _tag: "Blocked" as const,
            blockers: ["stale_head" as const],
            warnings: [],
          };
    const mergeReasons = deriveMergeReasons(
      current?._tag === "ok" ? current.value : undefined,
      remote?.mergeEvidence,
      checks,
    );
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
    const reviewId = createReviewId(session.key);
    const stableReview = await this.reviews.load(
      session.key.profileId,
      reviewId,
    );
    if (stableReview._tag === "err")
      return stableReview.error.reason === "not_found"
        ? err({ _tag: "ReviewNotFound" })
        : err({ _tag: "SessionStorageUnavailable" });
    if (
      stableReview.value.id !== reviewId ||
      stableReview.value.identity.profileId !== session.key.profileId ||
      stableReview.value.identity.host !== session.key.host ||
      stableReview.value.identity.owner !== session.key.owner ||
      stableReview.value.identity.repo !== session.key.repo ||
      stableReview.value.identity.prNumber !== session.key.prNumber ||
      stableReview.value.currentSessionId !== session.id ||
      stableReview.value.currentHeadSha !== session.key.headSha
    )
      return err({ _tag: "SessionStorageUnavailable" });
    const reviewStatus =
      stableReview.value.status._tag === "Terminal"
        ? stableReview.value.status.state
        : ("open" as const);

    const analysisReviewActions = projectAnalysisReviewActions({
      analysis,
      session,
      freshness,
      patchHash: patchHashBranded,
      pendingReview: pendingReview?.state ?? session.pendingReview,
    });

    const revision: MutableRevisionProjection = {
      reviewedHeadSha: session.key.headSha,
      freshness,
      refreshedAt,
    };
    if (patchHashBranded !== undefined) revision.patchHash = patchHashBranded;
    if (currentHeadSha !== undefined) revision.currentHeadSha = currentHeadSha;

    const projection: MutableReviewWorkbenchProjection = {
      state: "review",
      review: { id: reviewId, status: reviewStatus },
      session: projectSession(session),
      revision,
      commits: remote?.commits ?? [],
      insights: {
        analysis,
        walkthrough,
      },
      analysisReviewActions,
      pendingReview: projectPendingReview(
        pendingReview?.state ?? session.pendingReview ?? { _tag: "None" },
        pendingReview?.unavailable ?? session.pendingReview === undefined,
      ),
      directSummary: projectDirectSummaryReview(session.directSummaryReview),
      directSummaryDecision: directSummaryDecision(profile, pullRequest),
      conversation,
      checks,
      mergeReadiness,
      mergeReasons,
    };
    if (fullPatch !== undefined) projection.fullPatch = fullPatch;
    if (pullRequest !== undefined) projection.pullRequest = pullRequest;
    return ok(projection);
  }

  private async loadStoredInsights(
    session: ReviewSession,
  ): Promise<Result<StoredInsightRecords, WorkbenchProjectionFailure>> {
    // A retained Walkthrough belongs to the Session that produced it. Never
    // validate it against the currently represented Session's patch: Refresh
    // intentionally changes that artifact while old reading evidence remains.
    const [analysis, walkthrough] = await Promise.all([
      this.insights.loadTyped(
        session.key.profileId,
        createReviewId(session.key),
        "analysis",
        // The callback's parameter is left uninferred here (rather than
        // annotated `unknown`) so it takes its type from `loadTyped`'s
        // signature; this is the actual I/O boundary where a stored
        // Insight's `retained` value first becomes available to parse.
        (input) => {
          const envelope = v.safeParse(retainedEnvelopeSchema, input);
          if (!envelope.success) return err(undefined);
          const base = parseRetainedBase(envelope.output);
          if (base._tag === "err") return base;
          const value = parseReviewResult(readObjectField(input, "value"));
          return value._tag === "err"
            ? err(undefined)
            : ok({ ...base.value, value: value.value });
        },
      ),
      this.loadWalkthroughRecord(session),
    ]);
    // A corrupt or schema-drifted Insight record is ignored: the Review still
    // opens and the Insight reads as not generated, so a re-run heals it.
    if (
      analysis._tag === "err" &&
      analysis.error.reason !== "not_found" &&
      analysis.error.reason !== "invalid_stored_value"
    )
      return err({ _tag: "SessionStorageUnavailable" });
    if (
      walkthrough._tag === "err" &&
      walkthrough.error.reason !== "not_found" &&
      walkthrough.error.reason !== "invalid_stored_value"
    )
      return err({ _tag: "SessionStorageUnavailable" });
    const analysisArtifact =
      analysis._tag === "ok" && analysis.value.retained !== undefined
        ? await this.readInsightScope(
            session.key.profileId,
            analysis.value.retained,
          )
        : undefined;
    const records: MutableStoredInsightRecords = {};
    if (analysis._tag === "ok") records.analysis = analysis.value;
    if (walkthrough._tag === "ok")
      records.walkthrough = walkthrough.value.record;
    if (analysisArtifact?.scope !== undefined)
      records.analysisScope = analysisArtifact.scope;
    if (analysisArtifact?.artifactStatus !== undefined)
      records.analysisArtifactStatus = analysisArtifact.artifactStatus;
    if (
      walkthrough._tag === "ok" &&
      walkthrough.value.artifactStatus !== undefined
    )
      records.walkthroughArtifactStatus = walkthrough.value.artifactStatus;
    return ok(records);
  }

  private async readInsightScope(
    profileId: WorkspaceProfileId,
    retained: RetainedInsight<ReviewResult>,
  ): Promise<{
    readonly scope?: InsightScopeProjection;
    readonly artifactStatus: InsightArtifactStatus;
  }> {
    const retainedSession = await this.sessions.load(
      profileId,
      retained.revision.sessionId,
    );
    if (retainedSession._tag === "err") return { artifactStatus: "mismatch" };
    const patch = await readFile(retainedSession.value.patchPath, "utf8").catch(
      () => undefined,
    );
    if (patch === undefined) return { artifactStatus: "mismatch" };
    const actualHash = createHash("sha256").update(patch).digest("hex");
    if (actualHash !== retained.revision.patchHash)
      return { artifactStatus: "mismatch" };
    const files = parseUnifiedPatch(patch);
    return {
      artifactStatus: "verified",
      scope: {
        baseShort: (retainedSession.value.pr.baseSha ?? "unknown").slice(0, 7),
        headShort: retained.revision.headSha.slice(0, 7),
        commitCount: 0,
        fileCount: files.length,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
        changedFiles: files.map((file) => ({
          path: file.newPath,
          additions: file.additions,
          deletions: file.deletions,
        })),
      },
    };
  }

  private async loadWalkthroughRecord(session: ReviewSession): Promise<
    Result<
      {
        readonly record: InsightRecord<RetainedInsight<NarrativeWalkthrough>>;
        readonly artifactStatus?: InsightArtifactStatus;
      },
      {
        readonly reason: "not_found" | "invalid_stored_value" | "storage";
      }
    >
  > {
    const loaded = await this.insights.load(
      session.key.profileId,
      createReviewId(session.key),
      "walkthrough",
    );
    if (loaded._tag === "err") {
      if (loaded.error.reason === "not_found")
        return err({ reason: "not_found" });
      if (loaded.error.reason === "invalid_stored_value")
        return err({ reason: "invalid_stored_value" });
      return err({ reason: "storage" });
    }
    if (loaded.value.retained === undefined) {
      // SAFETY: `retained` is undefined, and the generic `T` in
      // `InsightRecord<RetainedInsight<T>>` only ever appears inside
      // `retained.value`. With no `retained` present on the loaded record,
      // its shape is identical for every `T`, so re-typing it here to
      // `NarrativeWalkthrough` cannot misrepresent the value.
      return ok({
        record: loaded.value as InsightRecord<
          RetainedInsight<NarrativeWalkthrough>
        >,
      });
    }
    const retainedValue = loaded.value.retained;
    const envelope = v.safeParse(retainedEnvelopeSchema, retainedValue);
    if (!envelope.success) return err({ reason: "invalid_stored_value" });
    const base = parseRetainedBase(envelope.output);
    if (base._tag === "err") return err({ reason: "invalid_stored_value" });
    // Readable-without-artifact fallback: preserves bounded prose while
    // dropping hunk coordinates that no longer have trusted patch bytes to
    // resolve against. Each stored field degrades independently instead of
    // rejecting the whole record, matching the original hand-walked reader.
    const fallback = (): Result<
      {
        readonly record: InsightRecord<RetainedInsight<NarrativeWalkthrough>>;
        readonly artifactStatus: InsightArtifactStatus;
      },
      {
        readonly reason: "not_found" | "invalid_stored_value" | "storage";
      }
    > => {
      const rawValue = readObjectField(retainedValue, "value");
      const rawChapters = readObjectField(rawValue, "chapters");
      const chapters = Array.isArray(rawChapters)
        ? rawChapters.slice(0, 12).map((chapter, chapterIndex) => {
            const rawSections = readObjectField(chapter, "sections");
            const sections = Array.isArray(rawSections)
              ? rawSections.slice(0, 32).map((section, sectionIndex) => ({
                  id: `section-${chapterIndex + 1}-${sectionIndex + 1}`,
                  title: v.parse(
                    boundedTextSchema(160, "Untitled section"),
                    readObjectField(section, "title"),
                  ),
                  prose: v.parse(
                    boundedTextSchema(
                      4_000,
                      "Stored section text is unavailable.",
                    ),
                    readObjectField(section, "prose"),
                  ),
                  hunkIds: [],
                  hunks: [],
                }))
              : [];
            return {
              id: `chapter-${chapterIndex + 1}`,
              title: v.parse(
                boundedTextSchema(80, "Untitled chapter"),
                readObjectField(chapter, "title"),
              ),
              sections,
            };
          })
        : [];
      const value: NarrativeWalkthrough = {
        snapshot: { profileId: session.key.profileId, ...base.value.revision },
        citationStatus: "unverified",
        title: v.parse(
          boundedTextSchema(200, "Stored Walkthrough"),
          readObjectField(rawValue, "title"),
        ),
        focus: v.parse(
          boundedTextSchema(2_000, "Stored source evidence is unavailable."),
          readObjectField(rawValue, "focus"),
        ),
        chapters,
        support: { id: "support", title: "Support", hunkIds: [], hunks: [] },
      };
      return ok({
        record: { ...loaded.value, retained: { ...base.value, value } },
        artifactStatus: "mismatch",
      });
    };
    const retainedSession = await this.sessions.load(
      session.key.profileId,
      base.value.revision.sessionId,
    );
    if (retainedSession._tag === "err") return fallback();
    const retainedPatch = await readFile(
      retainedSession.value.patchPath,
      "utf8",
    ).catch(() => undefined);
    if (retainedPatch === undefined) return fallback();
    const actualHash = createHash("sha256").update(retainedPatch).digest("hex");
    if (actualHash !== base.value.revision.patchHash) return fallback();
    const normalized = normalizeNarrativeWalkthrough(
      readObjectField(retainedValue, "value"),
      retainedPatch,
      {
        profileId: session.key.profileId,
        sessionId: base.value.revision.sessionId,
        headSha: base.value.revision.headSha,
        patchHash: base.value.revision.patchHash,
      },
    );
    if (normalized._tag === "err") return err({ reason: "storage" });
    return ok({
      record: {
        ...loaded.value,
        retained: { ...base.value, value: normalized.value },
      },
      artifactStatus: "verified",
    });
  }
}

function projectAnalysisReviewActions(input: {
  readonly analysis: InsightProjection<ReviewResult>;
  readonly session: ReviewSession;
  readonly freshness: ReviewWorkbenchProjection["revision"]["freshness"];
  readonly patchHash: ContentHash | undefined;
  readonly pendingReview: PendingReviewState | undefined;
}): AnalysisReviewActionsProjection {
  const retained = input.analysis.retained;
  const current =
    retained !== undefined &&
    retained.runId !== undefined &&
    input.analysis.status === "current" &&
    input.analysis.artifactStatus === "verified" &&
    input.freshness === "fresh" &&
    input.patchHash !== undefined &&
    retained.sessionId === input.session.id &&
    retained.headSha === input.session.key.headSha;
  if (
    !current ||
    retained === undefined ||
    retained.runId === undefined ||
    input.patchHash === undefined
  )
    return { findings: {}, canFinishWithAnalysisSummary: false };
  const locked =
    input.pendingReview?._tag === "WriteInFlight" ||
    input.pendingReview?._tag === "OutcomeUnknown";
  const receipts = input.session.findingReviewReceipts ?? [];
  const findings: Record<string, AnalysisFindingReviewStatus> = {};
  for (const finding of retained.value.findings) {
    if (finding.disposition === "dismissed") continue;
    const receipt = receipts.find(
      (candidate) =>
        candidate.analysisRunId === retained.runId &&
        candidate.findingId === finding.id &&
        candidate.sessionId === input.session.id &&
        candidate.headSha === input.session.key.headSha &&
        candidate.patchHash === input.patchHash,
    );
    const unresolved =
      input.pendingReview?._tag === "Pending" &&
      input.pendingReview.unresolvedFinding?.analysisRunId === retained.runId &&
      input.pendingReview.unresolvedFinding.findingId === finding.id &&
      input.pendingReview.unresolvedFinding.sessionId === input.session.id &&
      input.pendingReview.unresolvedFinding.headSha ===
        input.session.key.headSha &&
      input.pendingReview.unresolvedFinding.patchHash === input.patchHash;
    findings[finding.id] =
      receipt === undefined
        ? locked || unresolved
          ? { state: "locked" }
          : { state: "actionable" }
        : receipt.state === "pending"
          ? { state: "pending_review" }
          : { state: "published" };
  }
  const pendingReviewNodeId =
    input.pendingReview?._tag === "Pending"
      ? input.pendingReview.review.nodeId
      : undefined;
  return {
    findings,
    canFinishWithAnalysisSummary:
      pendingReviewNodeId !== undefined &&
      receipts.some(
        (receipt) =>
          receipt.state === "pending" &&
          receipt.pendingReviewNodeId === pendingReviewNodeId &&
          receipt.analysisRunId === retained.runId &&
          receipt.sessionId === input.session.id &&
          receipt.headSha === input.session.key.headSha &&
          receipt.patchHash === input.patchHash,
      ),
  };
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
      prNumber: session.key.prNumber,
      headSha: session.key.headSha,
    },
  };
}

function deriveMergeReasons(
  current: PullRequestSummary | undefined,
  evidence: GitHubMergeEvidence | undefined,
  checks: CheckSummary,
): ReadonlyArray<MergeDisplayReason> {
  const aggregate =
    evidence ??
    (current === undefined
      ? undefined
      : {
          mergeable: current.mergeability,
          mergeStateStatus: "unavailable" as const,
          reviewDecision:
            current.reviewState === "approved"
              ? ("approved" as const)
              : current.reviewState === "changes_requested"
                ? ("changes_requested" as const)
                : current.reviewState === "review_pending"
                  ? ("review_required" as const)
                  : ("unknown" as const),
        });
  if (aggregate === undefined) return [];
  const protection = aggregate.policy?.branchProtection;
  // Only a positive classic branch-protection count matches an approval
  // requirement. Zero and rules that do not expose approval configuration are
  // unavailable evidence, not an exact policy claim.
  const requiredCount =
    protection?.state === "available" &&
    protection.value.requiredApprovingReviewCount !== undefined &&
    protection.value.requiredApprovingReviewCount > 0
      ? protection.value.requiredApprovingReviewCount
      : undefined;
  const policySource =
    requiredCount === undefined
      ? ("github_pr_state" as const)
      : ("branch_protection" as const);
  if (aggregate.reviewDecision === "review_required") {
    return [
      {
        code: "review_required",
        message:
          requiredCount === undefined
            ? "Approval required by GitHub."
            : `${requiredCount} approving review${requiredCount === 1 ? "" : "s"} required by branch protection.`,
        source: policySource,
        availability: requiredCount === undefined ? "partial" : "available",
        openOnGitHub: requiredCount === undefined,
      },
    ];
  }
  if (aggregate.reviewDecision === "changes_requested")
    return [
      {
        code: "changes_requested",
        message: "Changes requested.",
        source: "github_pr_state",
        availability: "available",
        openOnGitHub: false,
      },
    ];
  if (aggregate.mergeStateStatus === "behind")
    return [
      {
        code: "behind",
        message: "Update this branch with the base branch.",
        source: "github_pr_state",
        availability: "available",
        openOnGitHub: false,
      },
    ];
  if (
    aggregate.mergeStateStatus === "dirty" ||
    aggregate.mergeable === "conflicting"
  )
    return [
      {
        code: "conflicts",
        message: "Resolve merge conflicts.",
        source: "github_pr_state",
        availability: "available",
        openOnGitHub: false,
      },
    ];
  if (checks.overall === "failing")
    return [
      {
        code: "checks",
        message: "Required checks have not passed.",
        source: "checks",
        availability: "available",
        openOnGitHub: false,
      },
    ];
  if (
    aggregate.mergeStateStatus === "blocked" ||
    aggregate.mergeable === "blocked"
  )
    return [
      {
        code: "blocked",
        message: "GitHub merge requirements are not satisfied.",
        source: "github_pr_state",
        availability: requiredCount === undefined ? "partial" : "available",
        openOnGitHub: true,
      },
    ];
  return [];
}

function evaluateReadiness(
  current: PullRequestSummary,
  checks: CheckSummary,
  session: ReviewSession,
): MergeReadiness {
  const blockers: MergeReadiness["blockers"][number][] = [];
  if (current.headSha !== session.key.headSha) blockers.push("stale_head");
  if (!current.isOpen) blockers.push("closed");
  if (current.isDraft) blockers.push("draft");
  if (current.mergeability === "conflicting") blockers.push("conflicting");
  if (current.mergeability === "blocked") blockers.push("merge_blocked");
  if (current.mergeability === "unknown") blockers.push("mergeability_unknown");
  if (checks.overall === "failing") blockers.push("required_check");
  if (current.reviewState === "review_pending") blockers.push("github_review");
  const warnings: MergeReadiness["warnings"][number][] = [];
  if (current.reviewState === "changes_requested")
    warnings.push("request_changes");
  return {
    _tag:
      blockers.length > 0
        ? "Blocked"
        : warnings.length > 0
          ? "NeedsAcknowledgement"
          : "Ready",
    blockers,
    warnings,
  };
}

type StoredInsightRecords = {
  readonly analysis?: InsightRecord<RetainedInsight<ReviewResult>>;
  readonly walkthrough?: InsightRecord<RetainedInsight<NarrativeWalkthrough>>;
  readonly analysisScope?: InsightScopeProjection;
  readonly analysisArtifactStatus?: InsightArtifactStatus;
  readonly walkthroughArtifactStatus?: InsightArtifactStatus;
};

/** Mutable draft of `StoredInsightRecords`, built in statements by `loadStoredInsights`. */
type MutableStoredInsightRecords = {
  -readonly [K in keyof StoredInsightRecords]: StoredInsightRecords[K];
};

/**
 * `projectStoredInsight` is generic in `T`, so a locally declared
 * `-readonly [K in keyof InsightProjection<T>]` draft type (the pattern used
 * elsewhere in this file for concrete, non-generic shapes) is flagged by
 * `anti-slop/no-known-value-widening`: a generic mapped-type alias is always
 * treated as a container that can silently swallow the literal evidence in
 * an assigned object. Building and returning each branch's literal directly,
 * omitting an optional key with `...(cond && { key })` instead of a typed
 * draft plus assignment, keeps every branch checked against this function's
 * own `InsightProjection<T>` return type and avoids that widening entirely.
 * `cond && {...}` (a `LogicalExpression`) also isn't the ternary-with-`{}`
 * shape `no-conditional-empty-object-spread` matches: when `cond` is false
 * it spreads `false`, which — like spreading `undefined` or `null` —
 * contributes no properties, so omission behaves identically to the
 * original conditional spread.
 */
function projectStoredInsight<T>(
  record: InsightRecord<RetainedInsight<T>> | undefined,
  session: ReviewSession,
  patchHash: string | undefined,
  decorate: (value: T, record: InsightRecord<RetainedInsight<T>>) => T = (
    value,
  ) => value,
  scope?: InsightScopeProjection,
  artifactStatus?: InsightArtifactStatus,
): InsightProjection<T> {
  const retained =
    record?.retained === undefined
      ? undefined
      : {
          runId: record.retained.runId,
          sessionId: record.retained.revision.sessionId,
          headSha: record.retained.revision.headSha,
          generatedAt: record.retained.generatedAt,
          value: decorate(record.retained.value, record),
          ...(scope !== undefined && { scope }),
        };
  if (record?.activeRun !== undefined) {
    return {
      status: "running",
      ...(artifactStatus !== undefined && { artifactStatus }),
      ...(record.walkthroughProgress !== undefined && {
        progress: record.walkthroughProgress,
      }),
      ...(retained !== undefined && { retained }),
      activeRun: {
        runId: record.activeRun.id,
        sessionId: record.activeRun.revision.sessionId,
        startedAt: record.activeRun.startedAt,
      },
    };
  }
  if (record?.replacementFailure !== undefined) {
    return {
      status: "failed",
      ...(artifactStatus !== undefined && { artifactStatus }),
      ...(record.walkthroughProgress !== undefined && {
        progress: record.walkthroughProgress,
      }),
      ...(retained !== undefined && { retained }),
      replacementFailure: {
        runId: record.replacementFailure.runId,
        ...(record.replacementFailure.category !== undefined && {
          category: record.replacementFailure.category,
        }),
        model: record.replacementFailure.model,
        reasoning: record.replacementFailure.reasoning,
        retryable: record.replacementFailure.retryable,
      },
    };
  }
  if (retained === undefined)
    return {
      status: "not_generated",
      ...(record?.walkthroughProgress !== undefined && {
        progress: record.walkthroughProgress,
      }),
    };
  const retainedRecord = record?.retained;
  const isCurrent =
    retainedRecord?.revision.sessionId === session.id &&
    retainedRecord.revision.headSha === session.key.headSha &&
    retainedRecord.revision.patchHash === patchHash;
  return {
    status: isCurrent ? "current" : "outdated",
    ...(artifactStatus !== undefined && { artifactStatus }),
    ...(record?.walkthroughProgress !== undefined && {
      progress: record.walkthroughProgress,
    }),
    retained,
  };
}

function projectAnalysisFindings(
  value: ReviewResult,
  record: InsightRecord<RetainedInsight<ReviewResult>>,
): ReviewResult {
  const dismissed = new Set(
    (record.dismissals ?? []).map(
      (entry: InsightFindingDismissal) => entry.findingId,
    ),
  );
  return {
    ...value,
    findings: value.findings.map((finding) => ({
      ...finding,
      disposition: dismissed.has(finding.id) ? "dismissed" : "open",
    })),
  };
}

/**
 * Envelope for one stored `RetainedInsight`'s scalar fields, decoded at the
 * I/O boundary. Every field stays `v.unknown()` here — this schema only
 * establishes that the field is present, exactly like the `readObjectField`
 * walk it replaces; the real per-field validation still happens in the
 * domain parsers (`parseInsightRunId`, `parseGitSha`, ...) below, so a
 * malformed value degrades identically to before: any missing or
 * wrong-shaped piece fails at the domain parser instead of here, and both
 * paths converge on the same `err(undefined)`.
 */
const retainedEnvelopeSchema = v.object({
  runId: v.unknown(),
  revision: v.optional(
    v.object({
      sessionId: v.unknown(),
      headSha: v.unknown(),
      patchHash: v.unknown(),
    }),
  ),
  generatedAt: v.unknown(),
  provenance: v.unknown(),
});
type RetainedEnvelope = v.InferOutput<typeof retainedEnvelopeSchema>;

const provenanceEnvelopeSchema = v.object({
  provider: v.unknown(),
  model: v.unknown(),
  reasoning: v.unknown(),
});
type ProvenanceEnvelope = v.InferOutput<typeof provenanceEnvelopeSchema>;

/** Matches the original inline check (`model.trim().length > 0 && model.length <= 200`) without a runtime `typeof`. */
const provenanceModelSchema = v.pipe(
  v.string(),
  v.check((value) => value.trim().length > 0, "model must not be blank"),
  v.maxLength(200),
);

/**
 * A bounded-text field that never fails: a non-blank string is truncated to
 * `maxLength` (its original, untrimmed bytes — matching the prior
 * `value.slice(0, maxLength)` behavior exactly), anything else falls back.
 */
function boundedTextSchema(maxLength: number, fallback: string) {
  return v.pipe(
    v.unknown(),
    v.transform((value) => {
      const parsed = v.safeParse(v.string(), value);
      return parsed.success && parsed.output.trim().length > 0
        ? parsed.output.slice(0, maxLength)
        : fallback;
    }),
  );
}

function parseRetainedBase(
  envelope: RetainedEnvelope,
): Result<RetainedInsight<unknown>, undefined> {
  const runId = parseInsightRunId(envelope.runId);
  const sessionId = parseReviewSessionId(envelope.revision?.sessionId);
  const headSha = parseGitSha(envelope.revision?.headSha);
  const patchHash = parseContentHash(envelope.revision?.patchHash);
  const generatedAt = parseIsoTimestamp(envelope.generatedAt);
  const provenanceEnvelope = v.safeParse(
    provenanceEnvelopeSchema,
    envelope.provenance,
  );
  const provenance = provenanceEnvelope.success
    ? parseRetainedProvenance(provenanceEnvelope.output)
    : err(undefined);
  if (
    runId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err" ||
    generatedAt._tag === "err" ||
    provenance._tag === "err"
  )
    return err(undefined);
  return ok({
    runId: runId.value,
    revision: {
      sessionId: sessionId.value,
      headSha: headSha.value,
      patchHash: patchHash.value,
    },
    generatedAt: generatedAt.value,
    provenance: provenance.value,
    value: undefined,
  });
}

function parseRetainedProvenance(
  envelope: ProvenanceEnvelope,
): Result<InsightProvenance, undefined> {
  const provider = parseInsightProvider(envelope.provider);
  const model = v.safeParse(provenanceModelSchema, envelope.model);
  const reasoning = parseInsightReasoning(envelope.reasoning);
  return provider._tag === "ok" && model.success && reasoning._tag === "ok"
    ? ok({ provider: provider.value, model: model.output, reasoning: reasoning.value })
    : err(undefined);
}
