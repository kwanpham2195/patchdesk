import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  createReviewSessionId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type IsoTimestamp,
} from "../domain/ids";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { evaluateMergeReadiness, type MergeReadiness } from "../domain/merge-readiness";
import { ReviewContextService } from "./review-context-service";
import { ReviewSessionService, type StartDependencies } from "./review-session-service";
import { ReviewWorktreeService } from "./review-worktree-service";

export type ReviewWorkbenchFailure = { readonly reason: "invalid_input" | "not_found" | "github_read" | "storage" };
export type ReviewWorkbenchProjection =
  | { readonly state: "review_started"; readonly session: ReviewSession }
  | {
      readonly state: "completed";
      readonly session: ReviewSession;
      readonly result: NonNullable<ReviewSession["visibleResult"]>;
      readonly draft: NonNullable<ReviewSession["draftContent"]>;
      readonly comments: Awaited<ReturnType<GitHubReader["getPullRequestComments"]>> extends { readonly value: infer T } ? T : never;
      readonly checks: Awaited<ReturnType<GitHubReader["getPullRequestChecks"]>> extends { readonly value: infer T } ? T : never;
      readonly history: ReadonlyArray<{ readonly id: string; readonly state: ReviewSession["state"]["_tag"] }>;
      readonly mergeReadiness: MergeReadiness;
    };

/** Opens a selected PR through persisted session state; it never manufactures a completed review or draft. */
export class ReviewWorkbenchController {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly github: Pick<GitHubReader, "getPullRequest" | "getPullRequestComments" | "getPullRequestChecks" | "getPullRequestDiff">,
    private readonly paths: ConstructorParameters<typeof ReviewSessionService>[0],
    private readonly now: () => IsoTimestamp,
    private readonly startDependencies?: StartDependencies,
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
    const matchingRepo = profile.value.repos.find((candidate) => candidate.host === host.value && candidate.owner === owner.value && candidate.repo === repo.value);
    const dependencies = this.startDependencies ?? {
      github: this.github,
      worktrees: new ReviewWorktreeService(this.paths, { async run() { return err({ _tag: "GitReadFailed" }); } }),
      context: new ReviewContextService(),
    };
    const created = await new ReviewSessionService(this.paths, this.now, dependencies).startReview({ profileId: profileId.value, host: host.value, owner: owner.value, repo: repo.value, number: number.value, headSha: current.value.headSha, isDraft: current.value.isDraft, isOpen: current.value.isOpen, profile: profile.value, ...(matchingRepo?.localPath === undefined ? {} : { localPath: matchingRepo.localPath }) });
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
    const [comments, checks, current] = await Promise.all([
      this.github.getPullRequestComments({ profile, pr }),
      this.github.getPullRequestChecks({ profile, pr, headSha: session.key.headSha }),
      this.github.getPullRequest({ profile, pr }),
    ]);
    if (comments._tag === "err" || checks._tag === "err" || current._tag === "err") return err({ reason: "github_read" });
    const mergeReadiness = evaluateMergeReadiness({ isCurrentHead: current.value.headSha === session.key.headSha, isOpen: current.value.isOpen, isDraft: current.value.isDraft, mergeability: current.value.mergeability, checks: checks.value, hasGitHubReviewBlocker: current.value.reviewState === "review_pending", hasRequestChanges: current.value.reviewState === "changes_requested", hasHighSeverityFinding: session.visibleResult.findings.some((finding) => finding.severity === "P0" || finding.severity === "P1") });
    return ok({ state: "completed", session, result: session.visibleResult, draft: session.draftContent, comments: comments.value as never, checks: checks.value as never, history: [{ id: session.currentAttemptId ?? "session", state: session.state._tag }], mergeReadiness });
  }
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value ? (value as Record<string, unknown>)[name] : undefined;
}
