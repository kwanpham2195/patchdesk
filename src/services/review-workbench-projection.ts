import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { InsightStore } from "../adapters/storage/insight-store";
import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ReviewRemoteSnapshot } from "../adapters/storage/review-remote-store";
import type {
  CheckSummary,
  GitHubComments,
  GitHubPublishedFeedback,
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
  type GitHubRepoName,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type { InsightProjection } from "../domain/insight";
import { normalizeNarrativeWalkthrough, type NarrativeWalkthrough } from "../domain/narrative-walkthrough";
import type { MergeReadiness } from "../domain/merge-readiness";
import type { InsightRecord, RetainedInsight } from "../domain/insight-record";
import type { ReviewBatch } from "../domain/review-batch";
import type { ReviewAttempt } from "../domain/review-attempt";
import { parseReviewResult, type ReviewResult } from "../domain/review-result";
import type { ReviewSession } from "../domain/review-session";
import {
  decideReviewRecovery,
  projectReviewRecovery,
  type ReviewRecoveryView,
} from "../domain/review-recovery";
import { ReviewPreparationJournal } from "./review-preparation-journal";
import type { ReviewRunRegistry } from "./review-run-registry";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
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

export type ReviewWorkbenchProjection = {
  readonly state: "review";
  readonly review: {
    readonly id: ReviewId;
    readonly status: "open" | "merged" | "closed";
  };
  readonly session: WorkbenchSessionProjection;
  readonly revision: {
    readonly reviewedHeadSha: GitSha;
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
  readonly draft?: ReviewBatch;
  readonly publishedFeedback: GitHubPublishedFeedback;
  readonly comments: GitHubComments;
  readonly checks: CheckSummary;
  readonly mergeReadiness: MergeReadiness;
  readonly recoveryView?: ReviewRecoveryView;
};

/** Current GitHub context is ephemeral and never replaces the saved local batch. */
export type RemoteReviewContext = {
  readonly pullRequest?: PullRequestSummary;
  readonly currentHeadSha?: GitSha;
  readonly freshness: "fresh" | "updates_available" | "unavailable" | "not_refreshed";
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
 * Read-side owner of the renderer-safe Review model for one local session.
 * Stable Review persistence and explicit remote snapshots are introduced by
 * later tasks; this foundation derives the Review identity from the session
 * and deliberately projects empty commit and published-feedback collections.
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
    private readonly recovery?: {
      readonly paths?: PatchdeskPaths;
      readonly runs?: Pick<ReviewRunRegistry, "find">;
      readonly preparation?: Pick<typeof ReviewPreparationJournal, "activeFor">;
      readonly diagnostics?: Pick<ReviewDiagnosticService, "record">;
    },
    private readonly reviews?: Pick<ReviewStore, "load">,
    private readonly insights?: Pick<InsightStore, "loadTyped">,
  ) {}

  async loadLocal(
    input: LoadWorkbenchInput,
  ): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const session = await this.loadSession(input);
    if (session._tag === "err") return session;
    return this.project(session.value, undefined, "local");
  }

  /** Projects the exact remote snapshot represented by the durable Review. */
  async loadRepresented(input: {
    readonly profileId: WorkspaceProfileId;
    readonly sessionId: ReviewSessionId;
    readonly snapshot: ReviewRemoteSnapshot;
    readonly refreshedAt: IsoTimestamp;
    readonly updatesAvailable?: boolean;
  }): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const session = await this.loadSession({ profileId: input.profileId, sessionId: input.sessionId });
    if (session._tag === "err") return session;
    return this.project(session.value, {
      current: { _tag: "ok", value: input.snapshot.pullRequest },
      comments: { _tag: "ok", value: input.snapshot.comments },
      commits: input.snapshot.commits,
      checks: { _tag: "ok", value: input.snapshot.checks },
    }, "represented", input.refreshedAt, input.updatesAvailable === true);
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
    const pr = {
      host: session.value.key.host,
      owner: session.value.key.owner,
      repo: session.value.key.repo,
      number: session.value.key.prNumber,
    };
    const [current, comments, checks] = await Promise.all([
      this.github.getPullRequest({ profile: profile.value, pr }),
      this.github.getPullRequestComments({ profile: profile.value, pr }),
      this.github.getPullRequestChecks({
        profile: profile.value,
        pr,
        headSha: session.value.key.headSha,
      }),
    ]);
    return this.project(session.value, {
      current,
      comments,
      checks,
    }, "live");
  }

  async refreshRemote(
    input: LoadWorkbenchInput,
  ): Promise<Result<RemoteReviewContext, WorkbenchProjectionFailure>> {
    const projected = await this.load(input);
    if (projected._tag === "err") return projected;
    const value = projected.value;
    return ok({
      ...(value.pullRequest === undefined ? {} : { pullRequest: value.pullRequest }),
      ...(value.revision.currentHeadSha === undefined
        ? {}
        : { currentHeadSha: value.revision.currentHeadSha }),
      freshness: value.revision.freshness,
      refreshedAt: value.revision.refreshedAt,
      comments: value.comments,
      checks: value.checks,
      mergeReadiness: value.mergeReadiness,
    });
  }

  private async loadSession(
    input: LoadWorkbenchInput,
  ): Promise<Result<ReviewSession, WorkbenchProjectionFailure>> {
    const [profile, session] = await Promise.all([
      this.profiles.load(input.profileId),
      this.sessions.load(input.profileId, input.sessionId),
    ]);
    if (profile._tag === "err") return err({ _tag: "ProfileNotFound" });
    if (session._tag === "err") return err({ _tag: "SessionNotFound" });
    return ok(session.value);
  }

  private async project(
    session: ReviewSession,
    remote: {
      readonly current: Awaited<ReturnType<GitHubReader["getPullRequest"]>>;
      readonly comments: Awaited<ReturnType<GitHubReader["getPullRequestComments"]>>;
      readonly commits?: ReadonlyArray<PullRequestCommit>;
      readonly checks: Awaited<ReturnType<GitHubReader["getPullRequestChecks"]>>;
    } | undefined,
    source: "local" | "represented" | "live",
    representedAt?: IsoTimestamp,
    updatesAvailable = false,
  ): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const [fullPatch, attempts] = await Promise.all([
      readFile(session.patchPath, "utf8").catch(() => undefined),
      this.sessions.listAttempts(session.key.profileId, session.id),
    ]);
    if (attempts._tag === "err") return err({ _tag: "SessionStorageUnavailable" });
    const storedInsights = this.insights === undefined
      ? undefined
      : await this.loadStoredInsights(session, fullPatch);
    if (storedInsights?._tag === "err") return storedInsights;
    const patchHash = fullPatch === undefined
      ? undefined
      : createHash("sha256").update(fullPatch).digest("hex");

    const current = remote?.current;
    const currentHeadSha = current?._tag === "ok" ? current.value.headSha : undefined;
    const pullRequest = current?._tag === "ok"
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
    const checks: CheckSummary = remote?.checks?._tag === "ok"
      ? remote.checks.value
      : { overall: "unknown", checks: [] };
    const comments: GitHubComments = remote?.comments?._tag === "ok"
      ? remote.comments.value
      : source !== "local"
        ? { threads: [], complete: false, incompleteReason: "unavailable" }
        : { threads: [], complete: true };
    const freshness = source === "local"
      ? "not_refreshed" as const
      : updatesAvailable
        ? "updates_available" as const
        : currentHeadSha === undefined
          ? "unavailable" as const
          : currentHeadSha === session.key.headSha
            ? "fresh" as const
            : "updates_available" as const;
    const refreshedAt = source === "live"
      ? this.now()
      : source === "represented"
        ? representedAt ?? session.updatedAt
        : session.updatedAt;
    const mergeReadiness = current?._tag === "ok" && remote?.checks?._tag === "ok"
      ? evaluateReadiness(current.value, remote.checks.value, session)
      : { _tag: "Blocked" as const, blockers: ["stale_head" as const], warnings: [] };
    const recoveryView = await this.recoveryView(session, attempts.value);
    const analysis = storedInsights === undefined
      ? projectAnalysis(session, attempts.value, currentHeadSha, source !== "local")
      : projectStoredInsight(storedInsights.value.analysis, session, patchHash);
    const walkthrough = storedInsights === undefined
      ? { status: "not_generated" as const }
      : projectStoredInsight(storedInsights.value.walkthrough, session, patchHash);
    const stableReview = this.reviews === undefined
      ? undefined
      : await this.reviews.load(session.key.profileId, createReviewId(session.key));
    const reviewStatus = stableReview?._tag === "ok"
      ? stableReview.value.status._tag === "Terminal"
        ? stableReview.value.status.state
        : "open" as const
      : this.reviews !== undefined
        ? "open" as const
        : session.state._tag === "Merged"
          ? "merged" as const
          : session.pr.isOpen
            ? "open" as const
            : "closed" as const;

    return ok({
      state: "review",
      review: { id: createReviewId(session.key), status: reviewStatus },
      session: projectSession(session),
      revision: {
        reviewedHeadSha: session.key.headSha,
        ...(currentHeadSha === undefined ? {} : { currentHeadSha }),
        freshness,
        refreshedAt,
      },
      ...(fullPatch === undefined ? {} : { fullPatch }),
      ...(pullRequest === undefined ? {} : { pullRequest }),
      commits: remote?.commits ?? [],
      insights: {
        analysis,
        walkthrough,
      },
      ...(session.batchContent === undefined ? {} : { draft: session.batchContent }),
      publishedFeedback: { reviews: [], comments: [] },
      comments,
      checks,
      mergeReadiness,
      ...(recoveryView === undefined ? {} : { recoveryView }),
    });
  }

  private async loadStoredInsights(
    session: ReviewSession,
    fullPatch: string | undefined,
  ): Promise<Result<StoredInsightRecords, WorkbenchProjectionFailure>> {
    if (this.insights === undefined) return ok({});
    const analysis = await this.insights.loadTyped(
      session.key.profileId,
      createReviewId(session.key),
      "analysis",
      parseRetainedAnalysis,
    );
    const walkthrough = await this.insights.loadTyped(
      session.key.profileId,
      createReviewId(session.key),
      "walkthrough",
      (value) => fullPatch === undefined ? err(undefined) : parseRetainedWalkthrough(value, fullPatch, session.key.profileId),
    );
    if (analysis._tag === "err" && analysis.error.reason !== "not_found") return err({ _tag: "SessionStorageUnavailable" });
    if (walkthrough._tag === "err" && walkthrough.error.reason !== "not_found") return err({ _tag: "SessionStorageUnavailable" });
    return ok({
      ...(analysis._tag === "ok" ? { analysis: analysis.value } : {}),
      ...(walkthrough._tag === "ok" ? { walkthrough: walkthrough.value } : {}),
    });
  }

  private async recoveryView(
    session: ReviewSession,
    attempts: ReadonlyArray<ReviewAttempt>,
  ): Promise<ReviewRecoveryView | undefined> {
    const activePreparation = this.recovery?.paths === undefined
      ? undefined
      : await (this.recovery.preparation?.activeFor ?? ReviewPreparationJournal.activeFor)(
          this.recovery.paths,
          session.key.profileId,
          session.id,
          this.recovery.diagnostics,
        );
    if (activePreparation?._tag === "err") {
      if (this.recovery?.diagnostics !== undefined) {
        await this.recovery.diagnostics.record({
          profileId: session.key.profileId,
          sessionId: session.id,
          category: "recovery",
          phase: "preparation-journal-read",
          retryable: true,
          detail: "The preparation journal could not be read.",
        });
      }
      return projectReviewRecovery({ _tag: "Preparing" });
    }
    const foundAttempt = attempts.find((attempt) => attempt.id === session.currentAttemptId);
    const liveRun = foundAttempt === undefined || this.recovery?.runs === undefined
      ? undefined
      : this.recovery.runs.find({ sessionId: session.id, attemptId: foundAttempt.id }) !== undefined;
    return projectReviewRecovery(decideReviewRecovery({
      session,
      ...(foundAttempt === undefined ? {} : { latestAttempt: foundAttempt }),
      ...(activePreparation?._tag === "ok" && activePreparation.value !== undefined ? { activePreparation: true } : {}),
      ...(liveRun === undefined ? {} : { liveRun }),
    }));
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
  };
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
  if (current.reviewState === "changes_requested") warnings.push("request_changes");
  if (session.visibleResult?.findings.some((finding) => finding.severity === "P0" || finding.severity === "P1")) {
    warnings.push("high_severity_finding");
  }
  return {
    _tag: blockers.length > 0 ? "Blocked" : warnings.length > 0 ? "NeedsAcknowledgement" : "Ready",
    blockers,
    warnings,
  };
}

type StoredInsightRecords = {
  readonly analysis?: InsightRecord<RetainedInsight<ReviewResult>>;
  readonly walkthrough?: InsightRecord<RetainedInsight<NarrativeWalkthrough>>;
};

function projectStoredInsight<T>(
  record: InsightRecord<RetainedInsight<T>> | undefined,
  session: ReviewSession,
  patchHash: string | undefined,
): InsightProjection<T> {
  const retained = record?.retained === undefined
    ? undefined
    : {
        sessionId: record.retained.revision.sessionId,
        headSha: record.retained.revision.headSha,
        generatedAt: record.retained.generatedAt,
        value: record.retained.value,
      };
  if (record?.activeRun !== undefined) {
    return {
      status: "running",
      ...(retained === undefined ? {} : { retained }),
      activeRun: {
        sessionId: record.activeRun.revision.sessionId,
        startedAt: record.activeRun.startedAt,
      },
    };
  }
  if (record?.replacementFailure !== undefined) {
    return {
      status: "failed",
      ...(retained === undefined ? {} : { retained }),
      replacementFailure: {
        ...(record.replacementFailure.incidentId === undefined ? {} : { incidentId: record.replacementFailure.incidentId }),
        retryable: record.replacementFailure.retryable,
      },
    };
  }
  if (retained === undefined) return { status: "not_generated" };
  const retainedRecord = record?.retained;
  const isCurrent = retainedRecord?.revision.sessionId === session.id
    && retainedRecord.revision.headSha === session.key.headSha
    && retainedRecord.revision.patchHash === patchHash;
  return { status: isCurrent ? "current" : "outdated", retained };
}

function parseRetainedBase(input: unknown): Result<RetainedInsight<unknown>, undefined> {
  const revision = readObjectField(input, "revision");
  const runId = parseInsightRunId(readObjectField(input, "runId"));
  const sessionId = parseReviewSessionId(readObjectField(revision, "sessionId"));
  const headSha = parseGitSha(readObjectField(revision, "headSha"));
  const patchHash = parseContentHash(readObjectField(revision, "patchHash"));
  const generatedAt = parseIsoTimestamp(readObjectField(input, "generatedAt"));
  if ([runId, sessionId, headSha, patchHash, generatedAt].some((value) => value._tag === "err")) return err(undefined);
  if (runId._tag === "err" || sessionId._tag === "err" || headSha._tag === "err" || patchHash._tag === "err" || generatedAt._tag === "err") return err(undefined);
  return ok({ runId: runId.value, revision: { sessionId: sessionId.value, headSha: headSha.value, patchHash: patchHash.value }, generatedAt: generatedAt.value, value: undefined });
}

function parseRetainedAnalysis(input: unknown): Result<RetainedInsight<ReviewResult>, undefined> {
  const base = parseRetainedBase(input);
  if (base._tag === "err") return base;
  const value = parseReviewResult(readObjectField(input, "value"));
  return value._tag === "err" ? err(undefined) : ok({ ...base.value, value: value.value });
}

function parseRetainedWalkthrough(input: unknown, patch: string, profileId: WorkspaceProfileId): Result<RetainedInsight<NarrativeWalkthrough>, undefined> {
  const base = parseRetainedBase(input);
  if (base._tag === "err") return base;
  const normalized = normalizeNarrativeWalkthrough(readObjectField(input, "value"), patch, {
    profileId,
    sessionId: base.value.revision.sessionId,
    headSha: base.value.revision.headSha,
    patchHash: base.value.revision.patchHash,
  });
  return normalized._tag === "err" ? err(undefined) : ok({ ...base.value, value: normalized.value });
}

function projectAnalysis(
  session: ReviewSession,
  attempts: ReadonlyArray<ReviewAttempt>,
  currentHeadSha: GitSha | undefined,
  isRemote: boolean,
): InsightProjection<ReviewResult> {
  const retained = session.visibleResult === undefined
    ? undefined
    : {
        sessionId: session.id,
        headSha: session.key.headSha,
        generatedAt: session.updatedAt,
        value: session.visibleResult,
      };
  const attempt = attempts.find((candidate) => candidate.id === session.currentAttemptId);
  if (session.state._tag === "Running") {
    return {
      status: "running",
      ...(retained === undefined ? {} : { retained }),
      ...(attempt === undefined ? {} : { activeRun: { sessionId: session.id, startedAt: attempt.startedAt } }),
    };
  }
  if (session.state._tag === "ReviewFailed") {
    return {
      status: "failed",
      ...(retained === undefined ? {} : { retained }),
      replacementFailure: { retryable: true },
    };
  }
  if (retained === undefined) return { status: "not_generated" };
  return {
    status: isRemote && currentHeadSha !== undefined && currentHeadSha !== session.key.headSha
      ? "outdated"
      : "current",
    retained,
  };
}
