import { pullRequestWritePermission } from "../adapters/github/github-adapter";
import type {
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import {
  resolveAvatarDataUris,
  withAvatarDataUri,
} from "../adapters/storage/avatar-cache-store";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
import type {
  AssignableUser,
  PullRequestAssigneePermission,
  SuggestedPullRequestReviewer,
} from "../domain/github-context";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import { definedProps } from "../domain/defined-props";
import type { PullRequestRef } from "../domain/pull-request";
import {
  deriveReviewVerdicts,
  type ReviewerVerdictRow,
} from "../domain/review-verdicts";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { AvatarRailDependencies } from "./avatar-sync-service";
import type { ReviewWriteGate } from "./review-write-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { RecentReviewWrite } from "../domain/recent-review-write";
import {
  mapGitHubReadFailure,
  mapGitHubWriteFailure,
  mapMetadataGateFailure,
  pullRequestRefForSession,
  resolvePullRequestWritePermission,
  runGuardedMetadataWrite,
  type PreparedMetadataWrite,
  type PullRequestMetadataListFailure,
  type PullRequestMetadataReadFailure,
  type PullRequestMetadataWriteFailure,
} from "./pull-request-metadata-write";

/** One reviewer to request or un-request; `login` travels alongside `id` for the same reason `AssigneeRef.login` does in `assignee-service.ts` — a confirmed write can journal a human-legible own-write fingerprint without a second lookup, and the subtractive REST un-request identifies people by login regardless of `id`. */
type ReviewerRef = {
  readonly id: string;
  readonly login: string;
};

export type ReviewerCommand =
  | {
      readonly _tag: "RequestReviewers";
      readonly reviewers: ReadonlyArray<ReviewerRef>;
    }
  | {
      readonly _tag: "RemoveReviewers";
      readonly reviewers: ReadonlyArray<ReviewerRef>;
    };

export type ReviewerReceipt =
  | {
      readonly _tag: "ReviewersRequested";
      readonly requested: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "ReviewersRemoved";
      readonly removed: ReadonlyArray<string>;
    };

/** Review requests add no reason of their own to the shared metadata-write vocabulary. */
export type ReviewerWriteFailure = PullRequestMetadataWriteFailure;

/**
 * Outcome of listing one current Review's reviewer state: every reviewer's
 * Revision-bound review verdict, GitHub's own suggested reviewers, and
 * candidate reviewers for a picker. Mirrors `AssigneeListOutcome`'s
 * read-failure vocabulary so a GitHub read failure is data on the success
 * path, not an HTTP error. No reviewer cap is reported — see
 * `ReviewerService.execute`'s comment on why none is enforced either.
 */
export type ReviewerListOutcome =
  | {
      readonly _tag: "ready";
      readonly reviewers: ReadonlyArray<ReviewerVerdictRow>;
      readonly suggested: ReadonlyArray<SuggestedPullRequestReviewer>;
      readonly candidates: ReadonlyArray<AssignableUser>;
      /** GitHub's exact candidate total; compare against `candidates.length` to detect truncation, mirroring `AssigneeListOutcome.totalCount`. */
      readonly candidatesTotalCount: number;
      /**
       * Whether this account can request/remove reviewers on this pull
       * request, computed the same way `execute`'s write gate computes it
       * (`getRepositoryPermission` evidence through
       * `pullRequestWritePermission`). Carried on the read path so the
       * picker can gate its controls on real evidence instead of inferring
       * permission from a rejected write.
       */
      readonly permission: PullRequestAssigneePermission;
    }
  | PullRequestMetadataReadFailure;

/** Only the review-resolution half can fail the request outright; a GitHub read failure is conveyed as a `ReviewerListOutcome` instead. */
export type ReviewerListFailure = PullRequestMetadataListFailure;

type Gateway = Pick<
  GitHubReader,
  | "getPullRequest"
  | "resolveAuthenticatedAccount"
  | "getRepositoryPermission"
  | "listAssignableUsers"
  | "getPullRequestReviewers"
> &
  Pick<GitHubReviewWriter, "requestReviews" | "removeRequestedReviewers">;

/**
 * Owns direct, GitHub-published reviewer reads and reviewer-request writes
 * for one current Review. A review request is pull-request-level metadata,
 * not diff-anchored, so both `execute` and `list` gate on
 * `requireCurrentSession` (proves the Review is not stale/terminal) rather
 * than `requireFresh` — see ADR "Gate label writes on the current session"
 * and ADR "The conversation rail owns pull request metadata writes": a new
 * commit does not invalidate a reviewer request any more than it
 * invalidates a label or an assignee.
 */
export class ReviewerService {
  constructor(
    private readonly gate: Pick<ReviewWriteGate, "requireCurrentSession">,
    private readonly github: Gateway,
    private readonly writeCoordinator: ReviewOperationCoordinator,
    private readonly now: () => IsoTimestamp,
    private readonly recentWrites: Pick<RecentWriteJournalStore, "append">,
    private readonly operations: Pick<
      ReviewWriteOperationStore,
      "load" | "begin" | "markOutcomeUnknown" | "confirm" | "reject" | "remove"
    >,
    /** Best-effort; see `AvatarRailDependencies`. Absent in tests/paths that never exercise avatar behaviour, in which case `list` returns every row with no `avatarDataUri`. */
    private readonly avatars?: AvatarRailDependencies,
  ) {}

  async execute(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: ReviewerCommand;
  }): Promise<Result<ReviewerReceipt, ReviewerWriteFailure>> {
    return await runGuardedMetadataWrite<ReviewerReceipt, ReviewerWriteFailure>(
      {
        profileId: input.profileId,
        reviewId: input.reviewId,
        coordinator: this.writeCoordinator,
        operations: this.operations,
        recentWrites: this.recentWrites,
        now: this.now,
        validate: () => validateLocalCommand(input.command),
        prepare: () => this.prepareWrite(input),
        journalEntry: journalEntryFor,
      },
    );
  }

  /**
   * Read-only counterpart to `execute`: the represented pull request's
   * reviewer verdicts, GitHub's own suggested reviewers, and candidate
   * reviewers for a reviewer picker, resolved in parallel. `query` filters
   * the candidate list server-side, reusing the exact `listAssignableUsers`
   * read `AssigneeService.list` uses — GitHub has no separate "who can be
   * requested to review" read; a review can be requested from anyone
   * assignable to the pull request.
   */
  async list(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly query?: string;
  }): Promise<Result<ReviewerListOutcome, ReviewerListFailure>> {
    const current = await this.gate.requireCurrentSession(
      input.profileId,
      input.reviewId,
    );
    if (current._tag === "err")
      return err(mapMetadataGateFailure(current.error));
    const pr = pullRequestRefForSession(current.value.session.key);
    // The represented revision's own head — not a fresh GitHub read of the
    // pull request's current head — is what a Revision-bound review verdict
    // is judged against; see `deriveReviewVerdicts`.
    const representedHeadSha = current.value.session.key.headSha;
    const candidatesInput = {
      profile: current.value.profile,
      repo: pr,
      ...definedProps({ query: input.query }),
    };
    const [reviewers, candidates, permission] = await Promise.all([
      this.github.getPullRequestReviewers({
        profile: current.value.profile,
        pr,
      }),
      this.github.listAssignableUsers(candidatesInput),
      this.resolvePermission(current.value.profile, pr),
    ]);
    // The reviewer read is the data this list exists to surface; a
    // candidate-list failure is real but secondary, so the reviewer read's
    // failure takes priority when both fail.
    if (reviewers._tag === "err")
      return ok(mapGitHubReadFailure(reviewers.error));
    if (candidates._tag === "err")
      return ok(mapGitHubReadFailure(candidates.error));
    const verdictRows = deriveReviewVerdicts(
      reviewers.value,
      representedHeadSha,
    );
    const resolved = await this.withResolvedAvatars(
      input.profileId,
      verdictRows,
      reviewers.value.suggested,
      candidates.value.users,
    );
    return ok({
      _tag: "ready",
      reviewers: resolved.reviewers,
      suggested: resolved.suggested,
      candidates: resolved.candidates,
      candidatesTotalCount: candidates.value.totalCount,
      permission,
    });
  }

  /**
   * Attaches each reviewer row, suggested reviewer, and candidate's cached
   * `avatarDataUri`, warming the cache for them first — mirrors
   * `AssigneeService.withResolvedAvatars`, the honest, main-process
   * equivalent of the workbench projection's `resolveAvatars` for a route
   * that has no projection of its own. A missing `this.avatars` (no live
   * `AvatarSyncService`/`PatchdeskPaths` wired) is the only early-return:
   * every other failure is already absorbed by `AvatarSyncService
   * .warmAvatarUrls` or `resolveAvatarDataUris`'s own per-URL fallback.
   *
   * `reviewers` (the rail's own verdict rows — who is requested, who has
   * already weighed in) are warmed ahead of `candidates` (the picker's
   * roster of everyone else assignable), so a cap-bounded warm never starves
   * the rail's own Reviewers section for the sake of someone who only
   * appears in the picker. `suggested` carries no avatar URL of its own
   * (`SuggestedPullRequestReviewer.reviewer` is a `RequestedReviewer`, the
   * same shape `candidates` rows use) and is resolved from the same
   * `candidates`-tier warm, since GitHub's suggestions are themselves drawn
   * from the candidate roster.
   *
   * The whole body below (past the early-return) is wrapped in a try/catch:
   * an avatar is decorative, so nothing here may fail this read. Mirrors
   * `AssigneeService.withResolvedAvatars`'s identical guard.
   */
  private async withResolvedAvatars(
    profileId: WorkspaceProfileId,
    reviewers: ReadonlyArray<ReviewerVerdictRow>,
    suggested: ReadonlyArray<SuggestedPullRequestReviewer>,
    candidates: ReadonlyArray<AssignableUser>,
  ): Promise<{
    readonly reviewers: ReadonlyArray<ReviewerVerdictRow>;
    readonly suggested: ReadonlyArray<SuggestedPullRequestReviewer>;
    readonly candidates: ReadonlyArray<AssignableUser>;
  }> {
    const avatars = this.avatars;
    if (avatars === undefined) return { reviewers, suggested, candidates };
    try {
      const displayedUrls = reviewers.flatMap((row) =>
        row.avatarUrl === undefined ? [] : [row.avatarUrl],
      );
      const candidateUrls = candidates.flatMap((user) =>
        user.avatarUrl === undefined ? [] : [user.avatarUrl],
      );
      const avatarUrls = [...displayedUrls, ...candidateUrls];
      await avatars.sync.warmAvatarUrls({ profileId, avatarUrls });
      const resolved = await resolveAvatarDataUris(
        avatars.paths,
        profileId,
        avatarUrls,
      );
      return {
        reviewers: reviewers.map((row) => withAvatarDataUri(row, resolved)),
        suggested: suggested.map((entry) => ({
          ...entry,
          reviewer: withAvatarDataUri(entry.reviewer, resolved),
        })),
        candidates: candidates.map((user) => withAvatarDataUri(user, resolved)),
      };
    } catch {
      return { reviewers, suggested, candidates };
    }
  }

  /**
   * Resolves the real three-state reviewer-write permission for one
   * profile's pull request, shared by `execute`'s write gate and `list`'s
   * read projection — identical in shape to
   * `AssigneeService.resolvePermission`, sharing the same underlying
   * `pullRequestWritePermission` projection since both writes need the same
   * pull-request-write capability.
   */
  private async resolvePermission(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
  ): Promise<PullRequestAssigneePermission> {
    return await resolvePullRequestWritePermission({
      github: this.github,
      profile,
      pr,
      project: pullRequestWritePermission,
    });
  }

  private async prepareWrite(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: ReviewerCommand;
  }): Promise<
    Result<
      PreparedMetadataWrite<ReviewerReceipt, ReviewerWriteFailure>,
      ReviewerWriteFailure
    >
  > {
    const current = await this.gate.requireCurrentSession(
      input.profileId,
      input.reviewId,
    );
    if (current._tag === "err")
      return err(mapMetadataGateFailure(current.error));
    const pr = pullRequestRefForSession(current.value.session.key);

    // A write attempted without `permitted` is refused here, not only in
    // the UI. `unknown` (missing/failed evidence) must never be treated as
    // permitted — only an explicit `permitted` proceeds.
    const permission = await this.resolvePermission(current.value.profile, pr);
    if (permission !== "permitted") return err("permission_denied");

    const pullRequest = await this.github.getPullRequest({
      profile: current.value.profile,
      pr,
    });
    if (pullRequest._tag === "err") return err("github_read_failed");
    const pullRequestId = pullRequest.value.nodeId;
    if (pullRequestId === undefined) return err("github_read_failed");

    const reviewerIds = input.command.reviewers.map((reviewer) => reviewer.id);
    const reviewerLogins = input.command.reviewers.map(
      (reviewer) => reviewer.login,
    );

    if (input.command._tag === "RequestReviewers") {
      // Deliberately no reviewer cap: GitHub's published documentation does
      // not confirm one exists for `requestReviews`, unlike the ten-assignee
      // cap `AssigneeService` enforces, so none is invented here.
      if (this.github.requestReviews === undefined)
        return err("github_write_failed");
      const writer = this.github.requestReviews;
      return ok({
        sessionId: current.value.session.id,
        intent: { _tag: "RequestReviewers" as const, logins: reviewerLogins },
        write: async (): Promise<
          Result<ReviewerReceipt, ReviewerWriteFailure>
        > => {
          const written = await writer({
            profile: current.value.profile,
            pullRequestId,
            userIds: reviewerIds,
          });
          return written._tag === "err"
            ? err(mapGitHubWriteFailure(written.error))
            : ok({ _tag: "ReviewersRequested", requested: reviewerLogins });
        },
      });
    }
    if (this.github.removeRequestedReviewers === undefined)
      return err("github_write_failed");
    const writer = this.github.removeRequestedReviewers;
    return ok({
      sessionId: current.value.session.id,
      intent: { _tag: "RemoveReviewers" as const, logins: reviewerLogins },
      write: async (): Promise<
        Result<ReviewerReceipt, ReviewerWriteFailure>
      > => {
        const written = await writer({
          profile: current.value.profile,
          pr,
          logins: reviewerLogins,
        });
        return written._tag === "err"
          ? err(mapGitHubWriteFailure(written.error))
          : ok({ _tag: "ReviewersRemoved", removed: reviewerLogins });
      },
    });
  }
}

function journalEntryFor(receipt: ReviewerReceipt): RecentReviewWrite {
  return receipt._tag === "ReviewersRequested"
    ? { _tag: "ReviewerChange", requested: receipt.requested, removed: [] }
    : { _tag: "ReviewerChange", requested: [], removed: receipt.removed };
}

function validateLocalCommand(
  command: ReviewerCommand,
): Result<void, ReviewerWriteFailure> {
  if (command.reviewers.length === 0) return err("invalid_input");
  if (
    command.reviewers.some(
      (reviewer) =>
        reviewer.id.trim().length === 0 || reviewer.login.trim().length === 0,
    )
  )
    return err("invalid_input");
  return ok(undefined);
}
