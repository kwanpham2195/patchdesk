import type { GitHubReader, GitHubReviewWriter } from "../adapters/github/github-adapter";
import type { ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewWriteGate } from "./review-write-gate";
import { err, ok, type Result } from "../domain/result";

export type PublishedFeedbackFailure = "not_fresh" | "not_found" | "permission_denied" | "confirmation_required" | "github_read_failed" | "github_write_failed" | "refresh_required";

export class PublishedFeedbackService {
  constructor(
    private readonly gate: Pick<ReviewWriteGate, "requireFresh">,
    private readonly github: Pick<GitHubReader, "getPullRequest" | "getPullRequestComments"> & Pick<GitHubReviewWriter, "updateReviewComment" | "deleteReviewComment" | "dismissReview">,
    private readonly refresh?: (input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId }) => Promise<Result<unknown, unknown>>,
  ) {}

  async editComment(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly commentId: string; readonly body: string }): Promise<Result<void, PublishedFeedbackFailure>> {
    if (input.body.trim().length === 0) return err("github_write_failed");
    const fresh = await this.gate.requireFresh(input.profileId, input.reviewId);
    if (fresh._tag === "err") return err(fresh.error.reason === "not_fresh" ? "not_fresh" : "not_found");
    const head = await this.verifyHead(fresh.value.profile, fresh.value.session);
    if (head._tag === "err") return head;
    const allowed = await this.authorizedComment(fresh.value.profile, fresh.value.session, input.commentId);
    if (allowed._tag === "err") return allowed;
    const writer = this.github.updateReviewComment;
    if (writer === undefined) return err("github_write_failed");
    const changed = await writer({ profile: fresh.value.profile, pr: sessionPr(fresh.value.session), commentId: input.commentId, body: input.body.trim() });
    return this.afterWrite(changed, input);
  }

  async deleteComment(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly commentId: string; readonly confirmation: boolean }): Promise<Result<void, PublishedFeedbackFailure>> {
    if (!input.confirmation) return err("confirmation_required");
    const fresh = await this.gate.requireFresh(input.profileId, input.reviewId);
    if (fresh._tag === "err") return err(fresh.error.reason === "not_fresh" ? "not_fresh" : "not_found");
    const head = await this.verifyHead(fresh.value.profile, fresh.value.session);
    if (head._tag === "err") return head;
    const allowed = await this.authorizedComment(fresh.value.profile, fresh.value.session, input.commentId);
    if (allowed._tag === "err") return allowed;
    const writer = this.github.deleteReviewComment;
    if (writer === undefined) return err("github_write_failed");
    const deleted = await writer({ profile: fresh.value.profile, pr: sessionPr(fresh.value.session), commentId: input.commentId });
    return this.afterWrite(deleted, input);
  }

  async dismissReview(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly publishedReviewId: string; readonly message: string; readonly confirmation: boolean }): Promise<Result<void, PublishedFeedbackFailure>> {
    if (!input.confirmation || input.message.trim().length === 0) return err(input.confirmation ? "github_write_failed" : "confirmation_required");
    const fresh = await this.gate.requireFresh(input.profileId, input.reviewId);
    if (fresh._tag === "err") return err(fresh.error.reason === "not_fresh" ? "not_fresh" : "not_found");
    const writer = this.github.dismissReview;
    if (writer === undefined) return err("github_write_failed");
    const dismissed = await writer({ profile: fresh.value.profile, pr: sessionPr(fresh.value.session), reviewId: input.publishedReviewId, message: input.message.trim() });
    return this.afterWrite(dismissed, input);
  }

  private async verifyHead(profile: WorkspaceProfileConfig, session: Parameters<typeof sessionPr>[0]): Promise<Result<void, PublishedFeedbackFailure>> {
    const current = await this.github.getPullRequest({ profile, pr: sessionPr(session) });
    return current._tag === "ok" && current.value.headSha === session.key.headSha ? ok(undefined) : err(current._tag === "ok" ? "not_fresh" : "github_read_failed");
  }

  private async authorizedComment(profile: WorkspaceProfileConfig, session: Parameters<typeof sessionPr>[0], commentId: string): Promise<Result<void, PublishedFeedbackFailure>> {
    const comments = await this.github.getPullRequestComments({ profile, pr: sessionPr(session) });
    if (comments._tag === "err") return err("github_read_failed");
    const comment = comments.value.threads.flatMap((thread) => thread.comments).find((candidate) => candidate.id === commentId);
    return comment === undefined ? err("not_found") : comment.author === profile.ghAccount ? ok(undefined) : err("permission_denied");
  }

  private async afterWrite(result: Result<void, unknown>, input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId }): Promise<Result<void, PublishedFeedbackFailure>> {
    if (result._tag === "err") return err("github_write_failed");
    if (this.refresh === undefined) return ok(undefined);
    const refreshed = await this.refresh(input);
    return refreshed._tag === "ok" ? ok(undefined) : err("refresh_required");
  }
}

function sessionPr(session: { readonly key: { readonly host: PullRequestRef["host"]; readonly owner: PullRequestRef["owner"]; readonly repo: PullRequestRef["repo"]; readonly prNumber: PullRequestRef["number"]; readonly headSha?: string } }): PullRequestRef {
  return { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber };
}
