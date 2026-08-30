import { describe, expect, it, vi } from "vitest";

import { parseIsoTimestamp } from "../../src/domain/ids";
import {
  parseReviewWriteOperation,
  type ReviewWriteOperation,
} from "../../src/domain/review-write-operation";
import { ok } from "../../src/domain/result";
import {
  classifyPublishedFeedbackIntent,
  ReviewWriteRecoveryService,
} from "../../src/services/review-write-recovery-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

type ConversationIntentTag =
  | "CreateComment"
  | "Reply"
  | "SetThreadState"
  | "EditComment"
  | "DeleteComment";

type ConversationOperation = ReviewWriteOperation & {
  readonly intent: Extract<
    ReviewWriteOperation["intent"],
    { readonly expected: unknown }
  >;
};

function operation(
  tag: ConversationIntentTag = "Reply",
): ConversationOperation {
  const expected = {
    sessionId:
      "github.com__centraldigital__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456",
    headSha: "1".repeat(40),
    patchHash: "a".repeat(64),
  };
  const parsed = parseReviewWriteOperation({
    schemaVersion: 1,
    profileId: "cfw",
    reviewId: "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456",
    sessionId: expected.sessionId,
    intent:
      tag === "CreateComment"
        ? {
            _tag: "CreateComment",
            expected,
            actor: "reviewer",
            anchor: {
              path: "src/a.ts",
              startLine: 4,
              line: 6,
              side: "new",
            },
            body: "same body",
          }
        : tag === "Reply"
          ? {
              _tag: "Reply",
              expected,
              actor: "reviewer",
              threadId: "PRRT_thread",
              body: "same body",
            }
          : tag === "SetThreadState"
            ? {
                _tag: "SetThreadState",
                expected,
                threadId: "PRRT_thread",
                state: "resolved",
              }
            : tag === "EditComment"
              ? {
                  _tag: "EditComment",
                  expected,
                  commentId: "PRRC_edited",
                  body: "edited body",
                }
              : {
                  _tag: "DeleteComment",
                  expected,
                  commentId: "PRRC_deleted",
                },
    state: { _tag: "OutcomeUnknown", resolution: "check_required" },
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  if (parsed._tag === "err") throw new Error("invalid fixture");
  if (!("expected" in parsed.value.intent)) throw new Error("invalid fixture");
  return parsed.value as ConversationOperation;
}

const createdAt = (() => {
  const parsed = parseIsoTimestamp("2026-01-01T00:00:01.000Z");
  if (parsed._tag === "err") throw new Error("invalid fixture timestamp");
  return parsed.value;
})();
describe("published-feedback recovery evidence", () => {
  type PublishedOperation = ReviewWriteOperation & {
    readonly intent: Extract<
      ReviewWriteOperation["intent"],
      {
        readonly _tag:
          | "EditPublishedComment"
          | "DeletePublishedComment"
          | "DismissPublishedReview";
      }
    >;
  };

  function publishedOperation(
    intent:
      | {
          readonly _tag: "EditPublishedComment";
          readonly commentId: string;
          readonly body: string;
        }
      | {
          readonly _tag: "DeletePublishedComment";
          readonly commentId: string;
        }
      | {
          readonly _tag: "DismissPublishedReview";
          readonly publishedReviewId: string;
          readonly message: string;
        },
  ): PublishedOperation {
    const base = operation();
    const parsed = parseReviewWriteOperation({
      ...base,
      intent: { ...intent, expected: base.intent.expected },
    });
    if (parsed._tag === "err") throw new Error("invalid published fixture");
    if (
      parsed.value.intent._tag !== "EditPublishedComment" &&
      parsed.value.intent._tag !== "DeletePublishedComment" &&
      parsed.value.intent._tag !== "DismissPublishedReview"
    )
      throw new Error("invalid published fixture");
    return { ...parsed.value, intent: parsed.value.intent };
  }

  const publishedFeedback = {
    comments: [
      {
        id: "201",
        author: "reviewer",
        body: "edited\r\nbody",
        createdAt,
        canEdit: true,
        canDelete: true,
      },
    ],
    reviews: [
      {
        id: "101",
        author: "reviewer",
        body: "",
        event: "DISMISSED" as const,
        submittedAt: createdAt,
        canDismiss: false,
      },
    ],
    complete: true,
  };

  it.each([
    [
      publishedOperation({
        _tag: "EditPublishedComment",
        commentId: "201",
        body: "edited\nbody",
      }),
      {
        _tag: "Confirmed",
        receipt: { _tag: "Comment", commentId: "201" },
      },
    ],
    [
      publishedOperation({
        _tag: "DeletePublishedComment",
        commentId: "absent",
      }),
      { _tag: "Confirmed" },
    ],
    [
      publishedOperation({
        _tag: "DismissPublishedReview",
        publishedReviewId: "101",
        message: "stale",
      }),
      { _tag: "Confirmed" },
    ],
  ] as const)(
    "confirms exact complete published evidence",
    (value, expectedResult) => {
      expect(classifyPublishedFeedbackIntent(value, publishedFeedback)).toEqual(
        expectedResult,
      );
    },
  );

  it.each([
    publishedOperation({
      _tag: "EditPublishedComment",
      commentId: "201",
      body: "wrong body",
    }),
    publishedOperation({
      _tag: "DeletePublishedComment",
      commentId: "201",
    }),
    publishedOperation({
      _tag: "DismissPublishedReview",
      publishedReviewId: "999",
      message: "stale",
    }),
  ])("retains wrong or absent published evidence", (value) => {
    expect(classifyPublishedFeedbackIntent(value, publishedFeedback)).toEqual({
      _tag: "CheckRequired",
    });
  });

  it("dispatches dismissal recovery through complete published feedback without journaling existence", async () => {
    const value = publishedOperation({
      _tag: "DismissPublishedReview",
      publishedReviewId: "101",
      message: "stale",
    });
    const trace: string[] = [];
    const getPullRequestComments = vi.fn();
    const append = vi.fn(async () => ok(undefined));
    const service = new ReviewWriteRecoveryService(
      {
        requireCurrentSession: vi.fn(),
        requireFresh: vi.fn(async () =>
          ok({
            profile: {},
            session: {
              key: {
                host: "github.com",
                owner: "centraldigital",
                repo: "patchdesk",
                prNumber: 42,
                headSha: value.intent.expected.headSha,
              },
            },
          } as never),
        ),
      },
      {
        getPullRequest: vi.fn(async () =>
          ok({ headSha: value.intent.expected.headSha } as never),
        ),
        getPullRequestComments,
        getPullRequestPublishedFeedback: vi.fn(async () =>
          ok(publishedFeedback),
        ),
      },
      {
        load: vi.fn(async () => ok(value)),
        markOutcomeUnknown: vi.fn(async () => ok(undefined)),
        confirm: vi.fn(async () => {
          trace.push("confirm");
          return ok(undefined);
        }),
        remove: vi.fn(async () => {
          trace.push("remove");
          return ok(undefined);
        }),
      },
      { append },
      new ReviewOperationCoordinator(),
      () => createdAt,
    );
    await expect(
      service.recover({ profileId: value.profileId, reviewId: value.reviewId }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "Confirmed" },
    });
    expect(getPullRequestComments).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(trace).toEqual(["confirm", "remove"]);
  });

  it("retains incomplete published feedback without confirmation or removal", async () => {
    const value = publishedOperation({
      _tag: "DeletePublishedComment",
      commentId: "201",
    });
    const confirm = vi.fn(async () => ok(undefined));
    const remove = vi.fn(async () => ok(undefined));
    const markOutcomeUnknown = vi.fn(async () => ok(undefined));
    const service = new ReviewWriteRecoveryService(
      {
        requireCurrentSession: vi.fn(),
        requireFresh: vi.fn(async () =>
          ok({
            profile: {},
            session: {
              key: {
                host: "github.com",
                owner: "centraldigital",
                repo: "patchdesk",
                prNumber: 42,
                headSha: value.intent.expected.headSha,
              },
            },
          } as never),
        ),
      },
      {
        getPullRequest: vi.fn(async () =>
          ok({ headSha: value.intent.expected.headSha } as never),
        ),
        getPullRequestComments: vi.fn(),
        getPullRequestPublishedFeedback: vi.fn(async () =>
          ok({ ...publishedFeedback, complete: false }),
        ),
      },
      {
        load: vi.fn(async () => ok(value)),
        markOutcomeUnknown,
        confirm,
        remove,
      },
      { append: vi.fn(async () => ok(undefined)) },
      new ReviewOperationCoordinator(),
      () => createdAt,
    );
    await expect(
      service.recover({ profileId: value.profileId, reviewId: value.reviewId }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "CheckRequired" },
    });
    expect(markOutcomeUnknown).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
