import { describe, expect, it, vi } from "vitest";

import { PublishedFeedbackService } from "../../src/services/published-feedback-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import type { ReviewWriteGate } from "../../src/services/review-write-gate";
import { ok } from "../../src/domain/result";

const profile = { ghAccount: "reviewer", githubHost: "github.com" } as never;
const session = {
  key: {
    host: "github.com",
    owner: "centraldigital",
    repo: "patchdesk",
    prNumber: 42,
    headSha: "a".repeat(40),
  },
} as never;
const gate = {
  async requireFresh() {
    return ok({ profile, review: {}, session });
  },
} as unknown as Pick<ReviewWriteGate, "requireFresh">;

describe("PublishedFeedbackService", () => {
  it("requires confirmation for deletion and rechecks the head after comment ownership", async () => {
    const calls: string[] = [];
    const service = new PublishedFeedbackService(
      gate,
      {
        async getPullRequest() {
          calls.push("head");
          return ok({ headSha: "a".repeat(40) } as never);
        },
        async getPullRequestComments() {
          return ok({ complete: true, threads: [] });
        },
        async getPullRequestPublishedFeedback() {
          calls.push("comments");
          return ok({
            reviews: [
              {
                id: "published-1",
                author: "reviewer",
                body: "",
                event: "APPROVED",
                submittedAt: "2026-08-01T00:00:00.000Z" as never,
                canDismiss: true,
              },
            ],
            comments: [
              {
                id: "comment-1",
                author: "reviewer",
                body: "old",
                createdAt: "2026-08-01T00:00:00.000Z" as never,
                canEdit: true,
                canDelete: true,
              },
            ],
            complete: true,
          });
        },
        async updateReviewComment() {
          calls.push("edit");
          return ok(undefined);
        },
        async deleteReviewComment() {
          calls.push("delete");
          return ok(undefined);
        },
        async dismissReview() {
          calls.push("dismiss");
          return ok(undefined);
        },
      },
      new ReviewOperationCoordinator(),
    );
    await expect(
      service.deleteComment({
        profileId: "cfw" as never,
        reviewId: "review" as never,
        commentId: "comment-1",
        confirmation: false,
      }),
    ).resolves.toEqual({ _tag: "err", error: "confirmation_required" });
    await expect(
      service.editComment({
        profileId: "cfw" as never,
        reviewId: "review" as never,
        commentId: "comment-1",
        body: "new",
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    expect(calls).toEqual(["comments", "head", "edit"]);
  });

  it("uses record-specific capabilities and fails closed for forged or unavailable records", async () => {
    const writer = vi.fn(async () => ok(undefined));
    const service = new PublishedFeedbackService(
      gate,
      {
        async getPullRequest() {
          return ok({ headSha: "a".repeat(40) } as never);
        },
        async getPullRequestComments() {
          return ok({ threads: [], complete: true });
        },
        async getPullRequestPublishedFeedback() {
          return ok({
            reviews: [
              {
                id: "review-1",
                author: "reviewer",
                body: "",
                event: "APPROVED",
                submittedAt: "2026-08-01T00:00:00.000Z" as never,
                canDismiss: false,
              },
            ],
            comments: [
              {
                id: "comment-1",
                author: "reviewer",
                body: "",
                createdAt: "2026-08-01T00:00:00.000Z" as never,
                canEdit: false,
                canDelete: false,
              },
            ],
            complete: true,
          });
        },
        async updateReviewComment() {
          return writer();
        },
        async deleteReviewComment() {
          return writer();
        },
        async dismissReview() {
          return writer();
        },
      },
      new ReviewOperationCoordinator(),
    );
    await expect(
      service.editComment({
        profileId: "cfw" as never,
        reviewId: "review" as never,
        commentId: "comment-1",
        body: "new",
      }),
    ).resolves.toEqual({ _tag: "err", error: "permission_denied" });
    await expect(
      service.dismissReview({
        profileId: "cfw" as never,
        reviewId: "review" as never,
        publishedReviewId: "forged",
        message: "reason",
        confirmation: true,
      }),
    ).resolves.toEqual({ _tag: "err", error: "not_found" });
    expect(writer).not.toHaveBeenCalled();
  });

  it.each(["edit", "delete", "dismiss"] as const)(
    "rejects a head race immediately before %s",
    async (action) => {
      let reads = 0;
      const staleOnRead = 1;
      const writer = vi.fn(async () => ok(undefined));
      const service = new PublishedFeedbackService(
        gate,
        {
          async getPullRequest() {
            reads += 1;
            return ok({
              headSha: reads < staleOnRead ? "a".repeat(40) : "b".repeat(40),
            } as never);
          },
          async getPullRequestComments() {
            return ok({ complete: true, threads: [] });
          },
          async getPullRequestPublishedFeedback() {
            return ok({
              reviews: [
                {
                  id: "published-1",
                  author: "reviewer",
                  body: "",
                  event: "APPROVED",
                  submittedAt: "2026-08-01T00:00:00.000Z" as never,
                  canDismiss: true,
                },
              ],
              comments: [
                {
                  id: "comment-1",
                  author: "reviewer",
                  body: "old",
                  createdAt: "2026-08-01T00:00:00.000Z" as never,
                  canEdit: true,
                  canDelete: true,
                },
              ],
              complete: true,
            });
          },
          async updateReviewComment() {
            return writer();
          },
          async deleteReviewComment() {
            return writer();
          },
          async dismissReview() {
            return writer();
          },
        },
        new ReviewOperationCoordinator(),
      );
      const result =
        action === "edit"
          ? await service.editComment({
              profileId: "cfw" as never,
              reviewId: "review" as never,
              commentId: "comment-1",
              body: "new",
            })
          : action === "delete"
            ? await service.deleteComment({
                profileId: "cfw" as never,
                reviewId: "review" as never,
                commentId: "comment-1",
                confirmation: true,
              })
            : await service.dismissReview({
                profileId: "cfw" as never,
                reviewId: "review" as never,
                publishedReviewId: "published-1",
                message: "reason",
                confirmation: true,
              });
      expect(result).toEqual({ _tag: "err", error: "not_fresh" });
      expect(writer).not.toHaveBeenCalled();
    },
  );
});
