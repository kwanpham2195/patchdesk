import { describe, expect, it, vi } from "vitest";

import type { GitHubComments } from "../../src/domain/github-context";
import {
  parseGitHubThreadId,
  parseIsoTimestamp,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import {
  parseReviewWriteOperation,
  type ReviewWriteOperation,
} from "../../src/domain/review-write-operation";
import { ok } from "../../src/domain/result";
import {
  classifyConversationIntent,
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

function fixtureThreadId(value = "PRRT_thread") {
  const parsed = parseGitHubThreadId(value);
  if (parsed._tag === "err") throw new Error("invalid fixture thread id");
  return parsed.value;
}

const createdAt = (() => {
  const parsed = parseIsoTimestamp("2026-01-01T00:00:01.000Z");
  if (parsed._tag === "err") throw new Error("invalid fixture timestamp");
  return parsed.value;
})();
const beforeStartedAt = (() => {
  const parsed = parseIsoTimestamp("2025-12-31T23:59:59.000Z");
  if (parsed._tag === "err") throw new Error("invalid fixture timestamp");
  return parsed.value;
})();
const sourcePath = (() => {
  const parsed = parseRepoRelativePath("src/a.ts");
  if (parsed._tag === "err") throw new Error("invalid fixture path");
  return parsed.value;
})();

type CommentEvidence = {
  readonly id: string;
  readonly author?: string;
  readonly body?: string;
  readonly createdAt?: typeof createdAt;
  readonly viewerDidAuthor?: boolean;
  readonly location?: {
    readonly startLine: number;
    readonly line: number;
    readonly side: "new" | "old";
  };
};

function completeComments({
  thread = "PRRT_thread",
  state = "open",
  comments = [],
}: {
  readonly thread?: string;
  readonly state?: "open" | "resolved";
  readonly comments?: ReadonlyArray<CommentEvidence>;
} = {}): GitHubComments {
  return {
    threads: [
      {
        id: fixtureThreadId(thread),
        state,
        complete: true,
        comments: comments.map((comment) => {
          const base = {
            id: comment.id,
            author: comment.author ?? "reviewer",
            body: comment.body ?? "same body",
            createdAt: comment.createdAt ?? createdAt,
            viewerDidAuthor: comment.viewerDidAuthor ?? true,
          };
          return comment.location === undefined
            ? base
            : {
                ...base,
                location: {
                  path: sourcePath,
                  line: comment.location.startLine,
                  lineEnd: comment.location.line,
                  diffSide: comment.location.side,
                },
              };
        }),
      },
    ],
    complete: true,
  };
}

describe("ReviewWriteRecoveryService", () => {
  const classificationRows = [
    {
      name: "CreateComment exact anchor, actor, and time",
      operation: operation("CreateComment"),
      comments: completeComments({
        comments: [
          {
            id: "PRRC_created",
            location: { startLine: 4, line: 6, side: "new" },
          },
        ],
      }),
      expected: {
        _tag: "Confirmed",
        receipt: { _tag: "Comment", commentId: "PRRC_created" },
      },
    },
    {
      name: "CreateComment absent because the anchor differs",
      operation: operation("CreateComment"),
      comments: completeComments({
        comments: [
          {
            id: "PRRC_wrong_anchor",
            location: { startLine: 5, line: 6, side: "new" },
          },
        ],
      }),
      expected: { _tag: "CheckRequired" },
    },
    {
      name: "CreateComment absent because the actor differs",
      operation: operation("CreateComment"),
      comments: completeComments({
        comments: [
          {
            id: "PRRC_wrong_actor",
            author: "someone-else",
            location: { startLine: 4, line: 6, side: "new" },
          },
        ],
      }),
      expected: { _tag: "CheckRequired" },
    },
    {
      name: "CreateComment absent because it predates the intent",
      operation: operation("CreateComment"),
      comments: completeComments({
        comments: [
          {
            id: "PRRC_old",
            createdAt: beforeStartedAt,
            location: { startLine: 4, line: 6, side: "new" },
          },
        ],
      }),
      expected: { _tag: "CheckRequired" },
    },
    {
      name: "CreateComment ambiguous exact matches",
      operation: operation("CreateComment"),
      comments: completeComments({
        comments: [
          {
            id: "PRRC_created_one",
            location: { startLine: 4, line: 6, side: "new" },
          },
          {
            id: "PRRC_created_two",
            location: { startLine: 4, line: 6, side: "new" },
          },
        ],
      }),
      expected: { _tag: "ManualResolutionRequired" },
    },
    {
      name: "Reply exact thread, actor, body, and time",
      operation: operation("Reply"),
      comments: completeComments({ comments: [{ id: "PRRC_reply" }] }),
      expected: {
        _tag: "Confirmed",
        receipt: { _tag: "Comment", commentId: "PRRC_reply" },
      },
    },
    {
      name: "Reply absent from its target thread",
      operation: operation("Reply"),
      comments: completeComments({
        thread: "PRRT_other",
        comments: [{ id: "PRRC_other_thread" }],
      }),
      expected: { _tag: "CheckRequired" },
    },

    {
      name: "Reply ambiguous exact matches",
      operation: operation("Reply"),
      comments: completeComments({
        comments: [{ id: "PRRC_reply_one" }, { id: "PRRC_reply_two" }],
      }),
      expected: { _tag: "ManualResolutionRequired" },
    },
    {
      name: "SetThreadState exact state",
      operation: operation("SetThreadState"),
      comments: completeComments({ state: "resolved" }),
      expected: {
        _tag: "Confirmed",
        receipt: {
          _tag: "ThreadState",
          threadId: fixtureThreadId(),
          state: "resolved",
        },
      },
    },
    {
      name: "SetThreadState still has the prior state",
      operation: operation("SetThreadState"),
      comments: completeComments({ state: "open" }),
      expected: { _tag: "CheckRequired" },
    },

    {
      name: "EditComment exact body",
      operation: operation("EditComment"),
      comments: completeComments({
        comments: [{ id: "PRRC_edited", body: "edited body" }],
      }),
      expected: {
        _tag: "Confirmed",
        receipt: { _tag: "Comment", commentId: "PRRC_edited" },
      },
    },
    {
      name: "EditComment still has the prior body",
      operation: operation("EditComment"),
      comments: completeComments({
        comments: [{ id: "PRRC_edited", body: "prior body" }],
      }),
      expected: { _tag: "CheckRequired" },
    },

    {
      name: "DeleteComment absent from complete evidence",
      operation: operation("DeleteComment"),
      comments: completeComments(),
      expected: { _tag: "Confirmed" },
    },
    {
      name: "DeleteComment still present",
      operation: operation("DeleteComment"),
      comments: completeComments({ comments: [{ id: "PRRC_deleted" }] }),
      expected: { _tag: "CheckRequired" },
    },
  ] as const;

  it.each(classificationRows)("classifies $name", (row) => {
    expect(classifyConversationIntent(row.operation, row.comments)).toEqual(
      row.expected,
    );
    expect(row.comments.complete).toBe(true);
  });

  it("recovers a confirmed delete without journaling comment existence", async () => {
    const value = operation("DeleteComment");
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
        getPullRequestComments: vi.fn(async () =>
          ok({ threads: [], complete: true }),
        ),
      },
      {
        load: vi.fn(async () => ok(value)),
        markOutcomeUnknown: vi.fn(async () => ok(undefined)),
        confirm: vi.fn(async () => ok(undefined)),
        remove: vi.fn(async () => ok(undefined)),
      },
      { append },
      new ReviewOperationCoordinator(),
      () => createdAt,
    );
    await expect(
      service.recover({ profileId: value.profileId, reviewId: value.reviewId }),
    ).resolves.toEqual({ _tag: "ok", value: { _tag: "Confirmed" } });
    expect(append).not.toHaveBeenCalled();
  });

  it("retains the durable lock when GitHub evidence is incomplete", async () => {
    const value = operation();
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
        getPullRequestComments: vi.fn(async () =>
          ok({ threads: [], complete: false }),
        ),
      },
      {
        load: vi.fn(async () => ok(value)),
        markOutcomeUnknown,
        confirm: vi.fn(async () => ok(undefined)),
        remove: vi.fn(async () => ok(undefined)),
      },
      { append: vi.fn(async () => ok(undefined)) },
      new ReviewOperationCoordinator(),
      () => createdAt,
    );
    await expect(
      service.recover({ profileId: value.profileId, reviewId: value.reviewId }),
    ).resolves.toEqual({ _tag: "ok", value: { _tag: "CheckRequired" } });
    expect(markOutcomeUnknown).toHaveBeenCalledWith(value);
  });
});
