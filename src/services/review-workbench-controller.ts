import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  createReviewSessionId,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  parseReviewSessionId,
  parseAbsolutePath,
  parseWorkspaceProfileId,
  type IsoTimestamp,
  type WorkspaceProfileId,
  type ReviewSessionId,
  type GitSha,
} from "../domain/ids";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { PullRequestSummary } from "../domain/github-context";
import { evaluateMergeReadiness, type MergeReadiness } from "../domain/merge-readiness";
import { ReviewContextService } from "./review-context-service";
import { ReviewSessionService, type StartDependencies } from "./review-session-service";
import { ReviewWorktreeService } from "./review-worktree-service";
import type { ReviewComparisonService } from "./review-comparison-service";
import type { PriorFindingEvidence } from "../domain/finding-lifecycle";
import type { FindingLifecycleEntry } from "../domain/finding-lifecycle";
import { parseRevisionComparison, type RevisionComparison } from "../domain/review-comparison";

export type ReviewWorkbenchFailure = { readonly reason: "invalid_input" | "not_found" | "github_read" | "head_changed" | "storage" };
export type ReviewWorkbenchProjection =
  | { readonly state: "review_started"; readonly session: ReviewSession }
  | {
      readonly state: "completed";
      readonly session: ReviewSession;
      readonly result: NonNullable<ReviewSession["visibleResult"]>;
      readonly reviewScope: ReviewSession["scope"];
      readonly fullPatch?: string;
      readonly comparison?: RevisionComparison;
      readonly comparisonPatch?: string;
      readonly lifecycle?: ReadonlyArray<FindingLifecycleEntry>;
      readonly comparisonAvailability: "available" | "not_requested" | "incomplete" | "missing";
      readonly pullRequest?: PullRequestSummary;
      readonly reviewedHeadSha: string;
      readonly currentHeadSha?: string;
      readonly freshness: "fresh" | "stale" | "unavailable";
      readonly refreshedAt: string;
      readonly draft: NonNullable<ReviewSession["draftContent"]>;
      readonly comments: Awaited<ReturnType<GitHubReader["getPullRequestComments"]>> extends { readonly value: infer T } ? T : never;
      readonly checks: Awaited<ReturnType<GitHubReader["getPullRequestChecks"]>> extends { readonly value: infer T } ? T : never;
      readonly history: ReadonlyArray<{ readonly id: string; readonly state: string; readonly startedAt: string }>;
      readonly mergeReadiness: MergeReadiness;
    };

/** Opens a selected PR through persisted session state; it never manufactures a completed review or draft. */
export class ReviewWorkbenchController {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly github: Pick<GitHubReader, "getPullRequest" | "getPullRequestComments" | "getPullRequestChecks" | "getPullRequestDiff" | "compareRevisions">,
    private readonly paths: ConstructorParameters<typeof ReviewSessionService>[0],
    private readonly now: () => IsoTimestamp,
    private readonly startDependencies?: StartDependencies,
    private readonly comparisons?: ReviewComparisonService,
  ) {}

  async open(input: unknown): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(field(input, "profileId"));
    const host = parseGitHubHost(field(input, "host"));
    const owner = parseGitHubOwner(field(input, "owner"));
    const repo = parseGitHubRepoName(field(input, "repo"));
    const number = parsePullRequestNumber(field(input, "number"));
    if (profileId._tag === "err" || host._tag === "err" || owner._tag === "err" || repo._tag === "err" || number._tag === "err") return err({ reason: "invalid_input" });
    const profile = await this.profiles.load(profileId.value);
    if (profile._tag === "err") return err({ reason: profile.error.reason === "not_found" ? "not_found" : "storage" });
    const pr = { host: host.value, owner: owner.value, repo: repo.value, number: number.value };
    const current = await this.github.getPullRequest({ profile: profile.value, pr });
    if (current._tag === "err") return err({ reason: "github_read" });
    const sessionId = createReviewSessionId({ profileId: profileId.value, host: host.value, owner: owner.value, repo: repo.value, prNumber: number.value, headSha: current.value.headSha });
    const stored = await this.sessions.load(profileId.value, sessionId);
    // Older metadata-only sessions have no attempt/artifacts, so they must be prepared
    // before the workbench can honestly present a runnable review.
    if (stored._tag === "ok" && stored.value.state._tag !== "Created") return this.project(profile.value, stored.value);
    if (stored._tag === "err" && stored.error.reason !== "not_found") return err({ reason: "storage" });
    const requestedMode = field(input, "mode");
    if (requestedMode !== undefined && requestedMode !== "full" && requestedMode !== "incremental") return err({ reason: "invalid_input" });
    const incremental = requestedMode === "incremental";
    let scope: ReviewSession["scope"] | undefined;
    if (incremental) {
      const baseSessionId = parseReviewSessionId(field(input, "baseSessionId"));
      if (baseSessionId._tag === "err" || this.comparisons === undefined) return err({ reason: "invalid_input" });
      const base = await this.sessions.load(profileId.value, baseSessionId.value);
      if (base._tag === "err" || base.value.key.host !== host.value || base.value.key.owner !== owner.value || base.value.key.repo !== repo.value || base.value.key.prNumber !== number.value || base.value.visibleResult === undefined) return err({ reason: "not_found" });
      const matchingRepo = profile.value.repos.find((candidate) => candidate.host === host.value && candidate.owner === owner.value && candidate.repo === repo.value);
      const prior = priorFindings(base.value);
      const prepared = matchingRepo?.localPath === undefined
        ? await this.prepareGitHubComparison({ profile: profile.value, pr, profileId: profileId.value, targetSessionId: sessionId, baseSessionId: base.value.id, baseHeadSha: base.value.key.headSha, headSha: current.value.headSha, previousFindings: prior })
        : await this.comparisons.prepare({ profileId: profileId.value, targetSessionId: sessionId, baseSessionId: base.value.id, baseHeadSha: base.value.key.headSha, headSha: current.value.headSha, previousFindings: prior, localPath: matchingRepo.localPath });
      // A metadata-only comparison cannot prove all changed code was seen. Start the
      // normal full review rather than create a misleading incremental session.
      if (prepared === undefined) {
        scope = undefined;
      } else if (prepared._tag === "err") {
        return err({ reason: prepared.error.reason === "head_changed" ? "head_changed" : "storage" });
      } else {
      // The comparison can take long enough for the PR to update. Recheck immediately
      // before a saved session would reference its artifacts.
      const verifiedCurrent = await this.github.getPullRequest({ profile: profile.value, pr });
      if (verifiedCurrent._tag === "err") return err({ reason: "github_read" });
      if (verifiedCurrent.value.headSha !== current.value.headSha) return err({ reason: "head_changed" });
      const comparisonPatchPath = parseAbsolutePath(prepared.value.comparisonPatchPath);
      const comparisonMetadataPath = parseAbsolutePath(prepared.value.comparisonMetadataPath);
      const previousFindingsPath = parseAbsolutePath(prepared.value.previousFindingsPath);
      const lifecyclePath = parseAbsolutePath(prepared.value.lifecyclePath);
      if (comparisonPatchPath._tag === "err" || comparisonMetadataPath._tag === "err" || previousFindingsPath._tag === "err" || lifecyclePath._tag === "err") return err({ reason: "storage" });
      scope = { kind: "incremental", baseSessionId: base.value.id, baseHeadSha: base.value.key.headSha, headSha: current.value.headSha, comparisonPatchPath: comparisonPatchPath.value, comparisonMetadataPath: comparisonMetadataPath.value, previousFindingsPath: previousFindingsPath.value, lifecyclePath: lifecyclePath.value };
      }
    }
    const matchingRepo = profile.value.repos.find((candidate) => candidate.host === host.value && candidate.owner === owner.value && candidate.repo === repo.value);
    const dependencies = this.startDependencies ?? {
      github: this.github,
      worktrees: new ReviewWorktreeService(this.paths, { async run() { return err({ _tag: "GitReadFailed" }); } }),
      context: new ReviewContextService(),
    };
    const created = await new ReviewSessionService(this.paths, this.now, dependencies).startReview({ profileId: profileId.value, host: host.value, owner: owner.value, repo: repo.value, number: number.value, headSha: current.value.headSha, isDraft: current.value.isDraft, isOpen: current.value.isOpen, prContext: { title: current.value.title, author: current.value.author, headBranch: current.value.headBranch, baseBranch: current.value.baseBranch }, profile: profile.value, ...(matchingRepo?.localPath === undefined ? {} : { localPath: matchingRepo.localPath }), ...(scope === undefined ? {} : { scope }) });
    return created._tag === "err" ? err({ reason: "storage" }) : this.project(profile.value, created.value.session);
  }

  async load(input: unknown): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(field(input, "profileId"));
    const sessionId = parseReviewSessionId(field(input, "sessionId"));
    if (profileId._tag === "err" || sessionId._tag === "err") return err({ reason: "invalid_input" });
    const [profile, session] = await Promise.all([this.profiles.load(profileId.value), this.sessions.load(profileId.value, sessionId.value)]);
    if (profile._tag === "err" || session._tag === "err") return err({ reason: "not_found" });
    return this.project(profile.value, session.value);
  }

  private async project(profile: WorkspaceProfileConfig, session: ReviewSession): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    if (session.visibleResult === undefined || session.draftContent === undefined) return ok({ state: "review_started", session });
    const pr = { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber };
    const [fullPatch, rawComparison, comparisonPatch, rawLifecycle, comments, checks, current, attempts] = await Promise.all([
      readFile(session.patchPath, "utf8").catch(() => undefined),
      session.scope.kind === "incremental" ? readFile(session.scope.comparisonMetadataPath, "utf8").catch(() => undefined) : Promise.resolve(undefined),
      session.scope.kind === "incremental" ? readFile(session.scope.comparisonPatchPath, "utf8").catch(() => undefined) : Promise.resolve(undefined),
      session.scope.kind === "incremental" ? readFile(session.scope.lifecyclePath, "utf8").catch(() => undefined) : Promise.resolve(undefined),
      this.github.getPullRequestComments({ profile, pr }),
      this.github.getPullRequestChecks({ profile, pr, headSha: session.key.headSha }),
      this.github.getPullRequest({ profile, pr }),
      this.sessions.listAttempts(session.key.profileId, session.id),
    ]);
    if (attempts._tag === "err") return err({ reason: "storage" });
    let comparison: RevisionComparison | undefined;
    let lifecycle: ReadonlyArray<FindingLifecycleEntry> | undefined;
    if (rawComparison !== undefined) {
      try {
        const parsed = parseRevisionComparison(JSON.parse(rawComparison));
        if (parsed._tag === "ok") comparison = parsed.value;
      } catch { comparison = undefined; }
    }
    if (rawLifecycle !== undefined) {
      try {
        const parsed: unknown = JSON.parse(rawLifecycle);
        if (Array.isArray(parsed)) lifecycle = parsed as ReadonlyArray<FindingLifecycleEntry>;
      } catch { lifecycle = undefined; }
    }
    const comparisonAvailability = session.scope.kind === "full"
      ? "not_requested" as const
      : comparison?.completeness === "incomplete"
        ? "incomplete" as const
        : comparison !== undefined && comparisonPatch !== undefined
          ? "available" as const
          : "missing" as const;
    const githubAvailable = comments._tag === "ok" && checks._tag === "ok" && current._tag === "ok";
    const safeComments = comments._tag === "ok" ? comments.value : { threads: [] };
    const safeChecks = checks._tag === "ok" ? checks.value : { overall: "unknown" as const, checks: [] };
    const currentHeadSha = current._tag === "ok" ? current.value.headSha : undefined;
    const pullRequest: PullRequestSummary | undefined = current._tag === "ok"
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
    const freshness = currentHeadSha === undefined ? "unavailable" as const : currentHeadSha === session.key.headSha ? "fresh" as const : "stale" as const;
    const mergeReadiness = githubAvailable
      ? evaluateMergeReadiness({ isCurrentHead: current.value.headSha === session.key.headSha, isOpen: current.value.isOpen, isDraft: current.value.isDraft, mergeability: current.value.mergeability, checks: checks.value, hasGitHubReviewBlocker: current.value.reviewState === "review_pending", hasRequestChanges: current.value.reviewState === "changes_requested", hasHighSeverityFinding: session.visibleResult.findings.some((finding) => finding.severity === "P0" || finding.severity === "P1") })
      : { _tag: "Blocked" as const, blockers: ["stale_head" as const], warnings: [] };
    return ok({
      state: "completed",
      session,
      result: session.visibleResult,
      reviewScope: session.scope,
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
      draft: session.draftContent,
      comments: safeComments as never,
      checks: safeChecks as never,
      history: attempts.value.map((attempt) => ({ id: attempt.id, state: attempt.state._tag, startedAt: attempt.startedAt })),
      mergeReadiness,
    });
  }

  private async prepareGitHubComparison(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestSummary["ref"];
    readonly profileId: WorkspaceProfileId;
    readonly targetSessionId: ReviewSessionId;
    readonly baseSessionId: ReviewSessionId;
    readonly baseHeadSha: GitSha;
    readonly headSha: GitSha;
    readonly previousFindings: ReadonlyArray<PriorFindingEvidence>;
  }): Promise<Awaited<ReturnType<ReviewComparisonService["prepare"]>> | undefined> {
    if (this.comparisons === undefined) return undefined;
    const remote = await this.github.compareRevisions({ profile: input.profile, pr: input.pr, baseSha: input.baseHeadSha, headSha: input.headSha, baseSessionId: input.baseSessionId });
    if (remote._tag === "err" || remote.value.comparison.completeness !== "complete" || remote.value.patch === undefined) return undefined;
    return this.comparisons.persist({ profileId: input.profileId, targetSessionId: input.targetSessionId, comparison: remote.value.comparison, patch: remote.value.patch, previousFindings: input.previousFindings });
  }
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value ? (value as Record<string, unknown>)[name] : undefined;
}

function priorFindings(session: ReviewSession): ReadonlyArray<PriorFindingEvidence> {
  const result = session.visibleResult;
  if (result === undefined) return [];
  const resultHash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  const evidence: Array<PriorFindingEvidence> = [];
  for (const finding of result.findings) {
    const token = parseContentHash(
      createHash("sha256")
        .update(`${session.id}\u0000${resultHash}\u0000${finding.id}`)
        .digest("hex"),
    );
    if (token._tag === "err") continue;
    evidence.push({
      token: token.value,
      findingId: finding.id,
      severity: finding.severity,
      ...(finding.category === undefined ? {} : { category: finding.category }),
      title: finding.title,
      explanation: finding.explanation,
      ...(finding.file === undefined ? {} : { file: finding.file }),
      wasSubmitted: session.submittedReview !== undefined,
    });
  }
  return evidence;
}
