import { readFile } from "node:fs/promises";

import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type {
  CheckSummary,
  GitHubComments,
  PullRequestSummary,
} from "../domain/github-context";
import type {
  GitHubHost,
  GitHubOwner,
  GitHubRepoName,
  GitSha,
  IsoTimestamp,
  PullRequestNumber,
  ReviewAttemptId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import type { FindingLifecycleEntry } from "../domain/finding-lifecycle";
import { evaluateMergeReadiness, type MergeReadiness } from "../domain/merge-readiness";
import {
  parseRevisionComparison,
  projectReviewScope,
  type ReviewScopeProjection,
  type RevisionComparison,
} from "../domain/review-comparison";
import type { ReviewDraft } from "../domain/review-draft";
import type { ReviewBatch } from "../domain/review-batch";
import type { ReviewResult } from "../domain/review-result";
import type { ReviewSession } from "../domain/review-session";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { err, ok, type Result } from "../domain/result";

export type { ReviewScopeProjection };

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
  readonly currentAttemptId?: ReviewAttemptId;
};

/** Bounded attempt history item; it leaks no adapter or workflow mechanics. */
export type ReviewHistoryItem = {
  readonly id: ReviewAttemptId;
  readonly state: string;
  readonly startedAt: IsoTimestamp;
};

export type PreparedWorkbenchProjection = {
  readonly state: "review_started";
  readonly session: WorkbenchSessionProjection;
  readonly fullPatch?: string;
  readonly pullRequest?: PullRequestSummary;
  readonly reviewedHeadSha: GitSha;
  readonly currentHeadSha?: GitSha;
  readonly freshness: "fresh" | "stale" | "unavailable" | "not_refreshed";
  readonly refreshedAt: IsoTimestamp;
  readonly checks: CheckSummary;
};

export type CompletedWorkbenchProjection = {
  readonly state: "completed";
  readonly session: WorkbenchSessionProjection;
  readonly result: ReviewResult;
  readonly reviewScope: ReviewScopeProjection;
  readonly fullPatch?: string;
  readonly comparison?: RevisionComparison;
  readonly comparisonPatch?: string;
  readonly lifecycle?: ReadonlyArray<FindingLifecycleEntry>;
  readonly comparisonAvailability: "available" | "not_requested" | "incomplete" | "missing";
  readonly pullRequest?: PullRequestSummary;
  readonly reviewedHeadSha: GitSha;
  readonly currentHeadSha?: GitSha;
  readonly freshness: "fresh" | "stale" | "unavailable" | "not_refreshed";
  readonly refreshedAt: IsoTimestamp;
  readonly draft?: ReviewDraft;
  readonly batch?: ReviewBatch;
  readonly comments: GitHubComments;
  readonly checks: CheckSummary;
  readonly history: ReadonlyArray<ReviewHistoryItem>;
  readonly mergeReadiness: MergeReadiness;
};

export type ReviewWorkbenchProjection =
  | PreparedWorkbenchProjection
  | CompletedWorkbenchProjection;

/** Current GitHub context is ephemeral and never replaces the saved local batch. */
export type RemoteReviewContext = {
  readonly pullRequest?: PullRequestSummary;
  readonly currentHeadSha?: GitSha;
  readonly freshness: "fresh" | "stale" | "unavailable" | "not_refreshed";
  readonly refreshedAt: IsoTimestamp;
  readonly comments: GitHubComments;
  readonly checks: CheckSummary;
  readonly mergeReadiness?: MergeReadiness;
};

export type LoadWorkbenchInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
};

export type WorkbenchProjectionFailure =
  | { readonly _tag: "ProfileNotFound" }
  | { readonly _tag: "SessionNotFound" }
  | { readonly _tag: "SessionStorageUnavailable" };

/**
 * Read-side owner of the safe Workbench model for one persisted Session. It
 * assembles bounded saved artifacts plus current GitHub context, owns safe
 * defaults, freshness, comparison availability, and merge readiness. It never
 * prepares a Session, reruns a review, or mutates a draft or Attempt.
 */
export class ReviewWorkbenchProjectionService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly github: Pick<
      GitHubReader,
      "getPullRequest" | "getPullRequestComments" | "getPullRequestChecks"
    >,
    private readonly now: () => IsoTimestamp,
  ) {}

  /** Opens durable local evidence without polling GitHub. */
  async loadLocal(
    input: LoadWorkbenchInput,
  ): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const [profile, session] = await Promise.all([
      this.profiles.load(input.profileId),
      this.sessions.load(input.profileId, input.sessionId),
    ]);
    if (profile._tag === "err") return err({ _tag: "ProfileNotFound" });
    if (session._tag === "err") return err({ _tag: "SessionNotFound" });
    if (session.value.visibleResult === undefined || (session.value.batchContent === undefined && session.value.draftContent === undefined)) {
      return this.projectPreparedLocal(session.value);
    }
    const [fullPatch, attempts] = await Promise.all([
      readFile(session.value.patchPath, "utf8").catch(() => undefined),
      this.sessions.listAttempts(session.value.key.profileId, session.value.id),
    ]);
    if (attempts._tag === "err") return err({ _tag: "SessionStorageUnavailable" });
    const pr = session.value.prContext === undefined ? undefined : {
      ref: { host: session.value.key.host, owner: session.value.key.owner, repo: session.value.key.repo, number: session.value.key.prNumber },
      ...session.value.prContext,
      headSha: session.value.key.headSha,
      isDraft: session.value.pr.isDraft,
      isOpen: session.value.pr.isOpen,
      reviewState: "unknown" as const,
      mergeability: "unknown" as const,
      labels: [],
      updatedAt: session.value.updatedAt,
    };
    return ok({
      state: "completed",
      session: projectSession(session.value),
      result: session.value.visibleResult,
      reviewScope: projectReviewScope(session.value.scope),
      ...(fullPatch === undefined ? {} : { fullPatch }),
      comparisonAvailability: session.value.scope.kind === "full" ? "not_requested" : "missing",
      ...(pr === undefined ? {} : { pullRequest: pr }),
      reviewedHeadSha: session.value.key.headSha,
      freshness: "not_refreshed",
      refreshedAt: session.value.updatedAt,
      ...(session.value.draftContent === undefined ? {} : { draft: session.value.draftContent }),
      ...(session.value.batchContent === undefined ? {} : { batch: session.value.batchContent }),
      comments: { threads: [] },
      checks: { overall: "unknown", checks: [] },
      history: attempts.value.map((attempt) => ({ id: attempt.id, state: attempt.state._tag, startedAt: attempt.startedAt })),
      mergeReadiness: { _tag: "Blocked", blockers: ["stale_head"], warnings: [] },
    });
  }

  /** Fetches current GitHub data without saving or changing any local review work. */
  async refreshRemote(
    input: LoadWorkbenchInput,
  ): Promise<Result<RemoteReviewContext, WorkbenchProjectionFailure>> {
    const projected = await this.load(input);
    if (projected._tag === "err") return projected;
    const value = projected.value;
    return ok({
      ...(value.pullRequest === undefined ? {} : { pullRequest: value.pullRequest }),
      ...(value.currentHeadSha === undefined ? {} : { currentHeadSha: value.currentHeadSha }),
      freshness: value.freshness,
      refreshedAt: value.refreshedAt,
      comments: value.state === "completed" ? value.comments : { threads: [] },
      checks: value.checks,
      ...(value.state === "completed" && value.mergeReadiness !== undefined ? { mergeReadiness: value.mergeReadiness } : {}),
    });
  }

  async load(
    input: LoadWorkbenchInput,
  ): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const [profile, session] = await Promise.all([
      this.profiles.load(input.profileId),
      this.sessions.load(input.profileId, input.sessionId),
    ]);
    if (profile._tag === "err") return err({ _tag: "ProfileNotFound" });
    if (session._tag === "err") return err({ _tag: "SessionNotFound" });
    if (session.value.visibleResult === undefined || (session.value.draftContent === undefined && session.value.batchContent === undefined)) {
      return this.projectPrepared(profile.value, session.value);
    }
    return this.projectCompleted(profile.value, session.value);
  }

  private async projectPrepared(
    profile: WorkspaceProfileConfig,
    session: ReviewSession,
  ): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const pr = {
      host: session.key.host,
      owner: session.key.owner,
      repo: session.key.repo,
      number: session.key.prNumber,
    };
    const [fullPatch, checks, current] = await Promise.all([
      readFile(session.patchPath, "utf8").catch(() => undefined),
      this.github.getPullRequestChecks({ profile, pr, headSha: session.key.headSha }),
      this.github.getPullRequest({ profile, pr }),
    ]);
    const currentHeadSha = current._tag === "ok" ? current.value.headSha : undefined;
    return ok({
      state: "review_started",
      session: projectSession(session),
      ...(fullPatch === undefined ? {} : { fullPatch }),
      ...(current._tag === "ok" ? { pullRequest: current.value } : {}),
      reviewedHeadSha: session.key.headSha,
      ...(currentHeadSha === undefined ? {} : { currentHeadSha }),
      freshness:
        currentHeadSha === undefined
          ? "unavailable"
          : currentHeadSha === session.key.headSha
            ? "fresh"
            : "stale",
      refreshedAt: this.now(),
      checks: checks._tag === "ok" ? checks.value : { overall: "unknown", checks: [] },
    });
  }

  private async projectPreparedLocal(session: ReviewSession): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const fullPatch = await readFile(session.patchPath, "utf8").catch(() => undefined);
    return ok({
      state: "review_started",
      session: projectSession(session),
      ...(fullPatch === undefined ? {} : { fullPatch }),
      reviewedHeadSha: session.key.headSha,
      freshness: "not_refreshed",
      refreshedAt: session.updatedAt,
      checks: { overall: "unknown", checks: [] },
    });
  }

  private async projectCompleted(
    profile: WorkspaceProfileConfig,
    session: ReviewSession,
  ): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    if (session.visibleResult === undefined || (session.draftContent === undefined && session.batchContent === undefined)) {
      return err({ _tag: "SessionNotFound" });
    }
    const pr = {
      host: session.key.host,
      owner: session.key.owner,
      repo: session.key.repo,
      number: session.key.prNumber,
    };
    const [fullPatch, rawComparison, comparisonPatch, rawLifecycle, comments, checks, current, attempts] =
      await Promise.all([
        readFile(session.patchPath, "utf8").catch(() => undefined),
        session.scope.kind === "incremental"
          ? readFile(session.scope.comparisonMetadataPath, "utf8").catch(() => undefined)
          : Promise.resolve(undefined),
        session.scope.kind === "incremental"
          ? readFile(session.scope.comparisonPatchPath, "utf8").catch(() => undefined)
          : Promise.resolve(undefined),
        session.scope.kind === "incremental"
          ? readFile(session.scope.lifecyclePath, "utf8").catch(() => undefined)
          : Promise.resolve(undefined),
        this.github.getPullRequestComments({ profile, pr }),
        this.github.getPullRequestChecks({ profile, pr, headSha: session.key.headSha }),
        this.github.getPullRequest({ profile, pr }),
        this.sessions.listAttempts(session.key.profileId, session.id),
      ]);
    if (attempts._tag === "err") return err({ _tag: "SessionStorageUnavailable" });
    let comparison: RevisionComparison | undefined;
    let lifecycle: ReadonlyArray<FindingLifecycleEntry> | undefined;
    if (rawComparison !== undefined) {
      try {
        const parsed = parseRevisionComparison(JSON.parse(rawComparison));
        if (parsed._tag === "ok") comparison = parsed.value;
      } catch {
        comparison = undefined;
      }
    }
    if (rawLifecycle !== undefined) {
      try {
        const parsed: unknown = JSON.parse(rawLifecycle);
        if (Array.isArray(parsed)) lifecycle = parsed as ReadonlyArray<FindingLifecycleEntry>;
      } catch {
        lifecycle = undefined;
      }
    }
    const comparisonAvailability =
      session.scope.kind === "full"
        ? ("not_requested" as const)
        : comparison?.completeness === "incomplete"
          ? ("incomplete" as const)
          : comparison !== undefined && comparisonPatch !== undefined
            ? ("available" as const)
            : ("missing" as const);
    const githubAvailable = comments._tag === "ok" && checks._tag === "ok" && current._tag === "ok";
    const safeComments: GitHubComments = comments._tag === "ok" ? comments.value : { threads: [] };
    const safeChecks: CheckSummary = checks._tag === "ok" ? checks.value : { overall: "unknown", checks: [] };
    const currentHeadSha = current._tag === "ok" ? current.value.headSha : undefined;
    const pullRequest: PullRequestSummary | undefined =
      current._tag === "ok"
        ? current.value
        : session.prContext === undefined
          ? undefined
          : {
              ref: pr,
              ...session.prContext,
              headSha: session.key.headSha,
              isDraft: session.pr.isDraft,
              isOpen: session.pr.isOpen,
              reviewState: "unknown",
              mergeability: "unknown",
              labels: [],
              updatedAt: session.updatedAt,
            };
    const freshness =
      currentHeadSha === undefined
        ? ("unavailable" as const)
        : currentHeadSha === session.key.headSha
          ? ("fresh" as const)
          : ("stale" as const);
    const mergeReadiness: MergeReadiness =
      githubAvailable && current._tag === "ok" && checks._tag === "ok"
        ? evaluateMergeReadiness({
            isCurrentHead: current.value.headSha === session.key.headSha,
            isOpen: current.value.isOpen,
            isDraft: current.value.isDraft,
            mergeability: current.value.mergeability,
            checks: checks.value,
            hasGitHubReviewBlocker: current.value.reviewState === "review_pending",
            hasRequestChanges: current.value.reviewState === "changes_requested",
            hasHighSeverityFinding: session.visibleResult.findings.some(
              (finding) => finding.severity === "P0" || finding.severity === "P1",
            ),
          })
        : { _tag: "Blocked" as const, blockers: ["stale_head" as const], warnings: [] };
    return ok({
      state: "completed",
      session: projectSession(session),
      result: session.visibleResult,
      reviewScope: projectReviewScope(session.scope),
      ...(fullPatch === undefined ? {} : { fullPatch }),
      ...(comparison === undefined ? {} : { comparison }),
      ...(comparisonPatch === undefined ? {} : { comparisonPatch }),
      ...(lifecycle === undefined ? {} : { lifecycle }),
      comparisonAvailability,
      ...(pullRequest === undefined ? {} : { pullRequest }),
      reviewedHeadSha: session.key.headSha,
      ...(currentHeadSha === undefined ? {} : { currentHeadSha }),
      freshness,
      refreshedAt: this.now(),
      ...(session.draftContent === undefined ? {} : { draft: session.draftContent }),
      ...(session.batchContent === undefined ? {} : { batch: session.batchContent }),
      comments: safeComments,
      checks: safeChecks,
      history: attempts.value.map((attempt) => ({
        id: attempt.id,
        state: attempt.state._tag,
        startedAt: attempt.startedAt,
      })),
      mergeReadiness,
    });
  }
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
    ...(session.currentAttemptId === undefined ? {} : { currentAttemptId: session.currentAttemptId }),
  };
}
