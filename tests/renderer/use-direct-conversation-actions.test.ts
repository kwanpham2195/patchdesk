// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { RecentReviewWrite } from "../../src/domain/recent-review-write";
import type { DesktopResponse } from "../../src/main/ipc-contract";
import {
  useDirectConversationActions,
  type DirectConversationActions,
} from "../../src/renderer/src/flows/use-direct-conversation-actions";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { projection } from "./review-workbench-fixtures";

const COMMAND = "/v1/reviews/inline-conversations/command";
const PUBLISHED_EDIT = "/v1/reviews/published-comments/edit";
const PUBLISHED_DELETE = "/v1/reviews/published-comments/delete";
const PUBLISHED_DISMISS = "/v1/reviews/published-reviews/dismiss";

type ActionCase = {
  readonly name: string;
  readonly operation:
    | "CreateComment"
    | "Reply"
    | "SetThreadState"
    | "EditPublishedComment"
    | "DeletePublishedComment";
  readonly invoke: (
    actions: DirectConversationActions,
  ) => Promise<
    void | string | { readonly commentId: string; readonly threadId?: string }
  >;
  readonly receipt: RawJsonValue;
  readonly wrongReceipt: RawJsonValue;
  readonly evidence?: RecentReviewWrite;
};

const cases: ReadonlyArray<ActionCase> = [
  {
    name: "CreateComment",
    operation: "CreateComment",
    invoke: (actions) =>
      actions.saveInlineComment({
        path: "src/a.ts" as never,
        startLine: 1,
        line: 1,
        side: "new",
        body: "comment",
      }),
    receipt: {
      _tag: "CommentCreated",
      commentId: "comment-created",
      reviewId: "review-created",
      threadId: "thread-created",
    },
    wrongReceipt: { _tag: "ReplyCreated", commentId: "wrong" },
    evidence: {
      _tag: "Comment",
      commentId: "comment-created",
      reviewId: "review-created",
    },
  },
  {
    name: "Reply",
    operation: "Reply",
    invoke: (actions) => actions.replyToThread("thread-1", "reply"),
    receipt: {
      _tag: "ReplyCreated",
      commentId: "reply-created",
      reviewId: "review-reply",
    },
    wrongReceipt: { _tag: "CommentCreated", commentId: "wrong" },
    evidence: {
      _tag: "Comment",
      commentId: "reply-created",
      reviewId: "review-reply",
    },
  },
  {
    name: "SetThreadState",
    operation: "SetThreadState",
    invoke: (actions) => actions.setThreadState("thread-1", "resolved"),
    receipt: {
      _tag: "ThreadStateChanged",
      threadId: "thread-1",
      state: "resolved",
    },
    wrongReceipt: { _tag: "CommentEdited", commentId: "wrong" },
    evidence: {
      _tag: "ThreadState",
      threadId: "thread-1" as never,
      state: "resolved",
    },
  },
  {
    name: "EditComment",
    operation: "EditPublishedComment",
    invoke: (actions) => actions.editComment("comment-1", "edited"),
    receipt: {
      _tag: "PublishedCommentEdited",
      commentId: "comment-1",
      reconciliation: "complete",
    },
    wrongReceipt: {
      _tag: "PublishedCommentDeleted",
      commentId: "comment-1",
      reconciliation: "complete",
    },
  },
  {
    name: "DeleteComment",
    operation: "DeletePublishedComment",
    invoke: (actions) => actions.deleteComment("comment-1"),
    receipt: {
      _tag: "PublishedCommentDeleted",
      commentId: "comment-1",
      reconciliation: "complete",
    },
    wrongReceipt: {
      _tag: "PublishedCommentEdited",
      commentId: "comment-1",
      reconciliation: "complete",
    },
  },
];

let desktop: DesktopDouble | undefined;
afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

function renderActions(
  answer: () => DesktopResponse | Promise<DesktopResponse>,
) {
  desktop = installDesktopDouble({
    "/v1/logs": () => success(null),
    [COMMAND]: answer,
    [PUBLISHED_EDIT]: answer,
    [PUBLISHED_DELETE]: answer,
    [PUBLISHED_DISMISS]: answer,
  });
  const appendRecentWrites = vi.fn();
  const observeConfirmedReviewWrite = vi.fn(async () => {
    throw new Error("advisory observation failed");
  });
  const requireRecovery = vi.fn();
  const rendered = renderHook(() =>
    useDirectConversationActions({
      workbench: projection(),
      runDirectCommand: async (operation) => await operation(),
      appendRecentWrites,
      observeConfirmedReviewWrite,
      requireRecovery,
    }),
  );
  return {
    ...rendered,
    appendRecentWrites,
    observeConfirmedReviewWrite,
    requireRecovery,
  };
}

describe("useDirectConversationActions", () => {
  it.each(cases)(
    "$name rejects a wrong 2xx receipt and requires recovery without optimistic evidence",
    async ({ operation, invoke, wrongReceipt }) => {
      const rendered = renderActions(() => success(wrongReceipt));
      await expect(invoke(rendered.result.current)).rejects.toThrow(
        "malformed",
      );
      expect(rendered.requireRecovery).toHaveBeenCalledOnce();
      expect(rendered.requireRecovery).toHaveBeenCalledWith(operation);
      expect(rendered.appendRecentWrites).not.toHaveBeenCalled();
      expect(rendered.observeConfirmedReviewWrite).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    "$name requires recovery before rethrowing outcome_unknown",
    async ({ operation, invoke }) => {
      const rendered = renderActions(() =>
        failure({ error: "outcome_unknown" }, 409),
      );
      await expect(invoke(rendered.result.current)).rejects.toMatchObject({
        kind: "outcome_unknown",
      });
      expect(rendered.requireRecovery).toHaveBeenCalledWith(operation);
      expect(rendered.appendRecentWrites).not.toHaveBeenCalled();
      expect(rendered.observeConfirmedReviewWrite).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "timeout", status: 408 },
    { kind: "unavailable", status: 503 },
    { kind: "ambiguous_write", status: 409 },
  ])(
    "$kind transport uncertainty requires recovery without exposing safe retry evidence",
    async ({ kind, status }) => {
      const rendered = renderActions(() => failure({ error: kind }, status));
      const action = cases[0];
      if (action === undefined) throw new Error("missing CreateComment case");

      await expect(
        action.invoke(rendered.result.current),
      ).rejects.toMatchObject({ kind });
      expect(rendered.requireRecovery).toHaveBeenCalledOnce();
      expect(rendered.requireRecovery).toHaveBeenCalledWith(action.operation);
      expect(desktop?.request).toHaveBeenCalledOnce();
      expect(rendered.appendRecentWrites).not.toHaveBeenCalled();
      expect(rendered.observeConfirmedReviewWrite).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    "$name journals only valid evidence and schedules one exact observation",
    async ({ operation, invoke, receipt, evidence }) => {
      const rendered = renderActions(() => success(receipt));
      await expect(invoke(rendered.result.current)).resolves.not.toThrow();
      expect(rendered.requireRecovery).not.toHaveBeenCalled();
      if (evidence === undefined) {
        expect(rendered.appendRecentWrites).not.toHaveBeenCalled();
        if (
          operation === "EditPublishedComment" ||
          operation === "DeletePublishedComment"
        )
          expect(rendered.observeConfirmedReviewWrite).not.toHaveBeenCalled();
        else {
          expect(rendered.observeConfirmedReviewWrite).toHaveBeenCalledOnce();
          expect(rendered.observeConfirmedReviewWrite).toHaveBeenCalledWith();
        }
      } else {
        expect(rendered.appendRecentWrites).toHaveBeenCalledOnce();
        expect(rendered.appendRecentWrites).toHaveBeenCalledWith(evidence);
        expect(rendered.observeConfirmedReviewWrite).toHaveBeenCalledOnce();
        expect(rendered.observeConfirmedReviewWrite).toHaveBeenCalledWith([
          evidence,
        ]);
      }
    },
  );

  it("uses published routes and locks confirmed reconciliation-required actions", async () => {
    const rendered = renderActions(() =>
      success({
        _tag: "PublishedCommentDeleted",
        commentId: "comment-1",
        reconciliation: "required",
      }),
    );
    await expect(
      rendered.result.current.deleteComment("comment-1"),
    ).resolves.toBeUndefined();
    expect(desktop?.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: PUBLISHED_DELETE,
        method: "POST",
        body: expect.objectContaining({
          commentId: "comment-1",
          confirmation: true,
        }),
      }),
    );
    expect(rendered.requireRecovery).toHaveBeenCalledExactlyOnceWith(
      "DeletePublishedComment",
    );
    expect(rendered.observeConfirmedReviewWrite).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing reconciliation",
      {
        _tag: "PublishedCommentEdited",
        commentId: "comment-1",
      },
    ],
    [
      "invalid reconciliation",
      {
        _tag: "PublishedCommentEdited",
        commentId: "comment-1",
        reconciliation: "retryable",
      },
    ],
    [
      "extra response field",
      {
        _tag: "PublishedCommentEdited",
        commentId: "comment-1",
        reconciliation: "complete",
        rawProviderResponse: "not renderer-safe",
      },
    ],
  ] as const)(
    "locks an edit after a 2xx receipt with %s",
    async (_name, receipt) => {
      const rendered = renderActions(() => success(receipt));
      await expect(
        rendered.result.current.editComment("comment-1", "edited"),
      ).rejects.toThrow("malformed");
      expect(rendered.requireRecovery).toHaveBeenCalledExactlyOnceWith(
        "EditPublishedComment",
      );
      expect(rendered.appendRecentWrites).not.toHaveBeenCalled();
      expect(rendered.observeConfirmedReviewWrite).not.toHaveBeenCalled();
    },
  );

  it("sends exact dismissal intent and locks confirmed reconciliation-required dismissal", async () => {
    const rendered = renderActions(() =>
      success({
        _tag: "PublishedReviewDismissed",
        publishedReviewId: "101",
        reconciliation: "required",
      }),
    );
    await expect(
      rendered.result.current.dismissReview("101", "obsolete"),
    ).resolves.toBeUndefined();
    expect(desktop?.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: PUBLISHED_DISMISS,
        method: "POST",
        body: expect.objectContaining({
          publishedReviewId: "101",
          message: "obsolete",
          confirmation: true,
        }),
      }),
    );
    expect(rendered.requireRecovery).toHaveBeenCalledExactlyOnceWith(
      "DismissPublishedReview",
    );
  });

  it("requires exact dismissal evidence", async () => {
    const rendered = renderActions(() =>
      success({
        _tag: "PublishedReviewDismissed",
        publishedReviewId: "other",
        reconciliation: "complete",
      }),
    );
    await expect(
      rendered.result.current.dismissReview("101", "reason"),
    ).rejects.toThrow("malformed");
    expect(rendered.requireRecovery).toHaveBeenCalledExactlyOnceWith(
      "DismissPublishedReview",
    );
  });

  it("preserves the created comment's optional threadId", async () => {
    const rendered = renderActions(() => success(cases[0]?.receipt ?? null));
    await expect(cases[0]?.invoke(rendered.result.current)).resolves.toEqual({
      commentId: "comment-created",
      threadId: "thread-created",
    });
  });

  it("admits only one direct request under rapid invocation", async () => {
    let release!: (response: DesktopResponse) => void;
    const pending = new Promise<DesktopResponse>((resolve) => {
      release = resolve;
    });
    const rendered = renderActions(() => pending);
    const action = cases[0];
    if (action === undefined) throw new Error("missing CreateComment case");

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = action.invoke(rendered.result.current);
      second = action.invoke(rendered.result.current);
    });
    expect(desktop?.request).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBeUndefined();
    await act(async () => release(success(action.receipt)));
    await expect(first).resolves.toMatchObject({
      commentId: "comment-created",
    });
  });
});
