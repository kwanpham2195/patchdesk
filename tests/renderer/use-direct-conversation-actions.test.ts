// @vitest-environment jsdom
import {
  act,
  cleanup,
  renderHook,
  render,
  fireEvent,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { parseGitHubThreadId } from "#src/domain/ids";
import { ConversationThreadCard } from "#src/renderer/src/components/conversation-thread-card";
import type { ReviewInlineAnnotation } from "#src/renderer/src/components/review-diff-view";
import { useReviewConversationOwner } from "#src/renderer/src/hooks/use-review-conversation-owner";
import { useReviewConversationOverlays } from "#src/renderer/src/hooks/use-review-conversation-overlays";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "#src/domain/json";
import type { RecentReviewWrite } from "#src/domain/recent-review-write";
import type { DesktopResponse } from "#src/main/ipc-contract";
import {
  PatchdeskApiError,
  ReviewPreconditionError,
} from "#src/renderer/src/api-client";
import {
  useDirectConversationActions,
  type DirectConversationActions,
} from "#src/renderer/src/flows/use-direct-conversation-actions";
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
    | false
    | void
    | string
    | { readonly commentId: string; readonly threadId?: string }
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
        // SAFETY: this fixture path is consumed only by the direct-command request shape.
        path: "src/a.ts" as never,
        startLine: 1,
        line: 1,
        side: "new",
        body: "comment",
      }),
    receipt: {
      _tag: "CommentCreated",
      commentId: "comment-created",
      commentNodeId: "PRRC_comment-created",
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
      // SAFETY: this fixture thread id is consumed only as journal evidence.
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
    evidence: { _tag: "DeletedComment", commentId: "comment-1" },
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
  workbench = projection(),
) {
  desktop = installDesktopDouble({
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
      workbench,
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
  it("propagates a forbidden API error unchanged for a safe thread-state retry", async () => {
    const rendered = renderActions(() => failure({ error: "forbidden" }, 403));
    let failureCause: unknown;

    try {
      await rendered.result.current.setThreadState("thread-1", "resolved");
    } catch (cause) {
      failureCause = cause;
    }

    if (!(failureCause instanceof PatchdeskApiError))
      throw new Error("Expected a PatchdeskApiError");
    expect(failureCause.kind).toBe("forbidden");
    expect(failureCause.status).toBe(403);
    expect(failureCause.correlationId).toBe("test");
    expect(rendered.requireRecovery).not.toHaveBeenCalled();
    expect(rendered.appendRecentWrites).not.toHaveBeenCalled();
  });

  it.each(cases)(
    "$name rejects a wrong 2xx receipt and requires recovery without optimistic evidence",
    async ({ operation, invoke, wrongReceipt }) => {
      const rendered = renderActions(() => success(wrongReceipt));
      const request = invoke(rendered.result.current);
      await expect(request).rejects.toBeInstanceOf(PatchdeskApiError);
      await expect(request).rejects.toMatchObject({
        kind: "outcome_unknown",
        correlationId: "invalid-direct-conversation-receipt",
      });
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

  it.each(cases)(
    "$name reports a refusal GitHub gave without arming recovery",
    async ({ invoke }) => {
      const rendered = renderActions(() =>
        failure({ error: "github_refused", cause: "unprocessable" }, 409),
      );
      await expect(invoke(rendered.result.current)).rejects.toMatchObject({
        kind: "github_refused",
        status: 409,
      });
      expect(rendered.requireRecovery).not.toHaveBeenCalled();
      expect(rendered.appendRecentWrites).not.toHaveBeenCalled();
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

  it("reports a refused dismissal without arming recovery", async () => {
    const rendered = renderActions(() =>
      failure({ error: "github_refused", cause: "unprocessable" }, 409),
    );
    await expect(
      rendered.result.current.dismissReview("101", "stale"),
    ).rejects.toMatchObject({ kind: "github_refused", status: 409 });
    expect(rendered.requireRecovery).not.toHaveBeenCalled();
  });

  it.each(cases)(
    "$name journals only valid evidence and schedules one exact observation",
    async ({ invoke, receipt, evidence }) => {
      const rendered = renderActions(() => success(receipt));
      await expect(invoke(rendered.result.current)).resolves.not.toThrow();
      expect(rendered.requireRecovery).not.toHaveBeenCalled();
      if (evidence === undefined) {
        expect(rendered.appendRecentWrites).not.toHaveBeenCalled();
        expect(rendered.observeConfirmedReviewWrite).toHaveBeenCalledOnce();
        expect(rendered.observeConfirmedReviewWrite).toHaveBeenCalledWith();
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
      const request = rendered.result.current.editComment(
        "comment-1",
        "edited",
      );
      await expect(request).rejects.toBeInstanceOf(PatchdeskApiError);
      await expect(request).rejects.toMatchObject({
        kind: "outcome_unknown",
        correlationId: "invalid-direct-conversation-receipt",
      });
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
    const request = rendered.result.current.dismissReview("101", "reason");
    await expect(request).rejects.toBeInstanceOf(PatchdeskApiError);
    await expect(request).rejects.toMatchObject({
      kind: "outcome_unknown",
      correlationId: "invalid-direct-conversation-receipt",
    });
    expect(rendered.requireRecovery).toHaveBeenCalledExactlyOnceWith(
      "DismissPublishedReview",
    );
  });

  it.each([
    [
      "Reply",
      (actions: DirectConversationActions) =>
        actions.replyToThread("thread-1", "reply"),
    ],
    [
      "EditComment",
      (actions: DirectConversationActions) =>
        actions.editComment("comment-1", "edited"),
    ],
    [
      "DeleteComment",
      (actions: DirectConversationActions) =>
        actions.deleteComment("comment-1"),
    ],
  ] as const)(
    "%s refuses without a readable diff and sends nothing",
    async (_name, invoke) => {
      const current = projection();
      const rendered = renderActions(() => success(null), {
        ...current,
        revision: { ...current.revision, patchHash: undefined },
      });
      const request = invoke(rendered.result.current);
      await expect(request).rejects.toBeInstanceOf(ReviewPreconditionError);
      await expect(request).rejects.toMatchObject({
        reason: "diff_unreadable",
      });
      expect(desktop?.request).not.toHaveBeenCalled();
      expect(rendered.requireRecovery).not.toHaveBeenCalled();
    },
  );

  it("preserves the created comment's optional threadId", async () => {
    const rendered = renderActions(() => success(cases[0]?.receipt ?? null));
    await expect(cases[0]?.invoke(rendered.result.current)).resolves.toEqual({
      commentId: "comment-created",
      commentNodeId: "PRRC_comment-created",
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

const parsedThread = parseGitHubThreadId("thread-1");
if (parsedThread._tag !== "ok") throw new Error("Invalid fixture thread");
const consumerThreadId = parsedThread.value;
const consumerComment = {
  id: "comment-1",
  body: "Original",
  author: "You",
  viewerDidAuthor: true,
  createdAt: "2026-10-01T00:00:00Z",
};
function consumerProjection(
  body = "Original",
  state: "open" | "resolved" = "open",
): ReadonlyArray<ReviewInlineAnnotation> {
  return [
    {
      id: "thread",
      path: "src/a.ts",
      start: 1,
      end: 1,
      side: "new",
      severity: "conversation",
      title: "Conversation",
      explanation: "",
      conversationThread: {
        target: { _tag: "thread", id: consumerThreadId },
        state,
        comments: [{ ...consumerComment, body }],
      },
    },
  ];
}
function renderConsumer(
  answer: () => DesktopResponse | Promise<DesktopResponse>,
) {
  desktop = installDesktopDouble({
    [COMMAND]: answer,
    [PUBLISHED_EDIT]: answer,
    [PUBLISHED_DELETE]: answer,
  });
  return renderHook(
    ({ annotations }) => {
      const actions = useDirectConversationActions({
        workbench: projection(),
        runDirectCommand: async (request) => request(),
        appendRecentWrites: () => undefined,
        observeConfirmedReviewWrite: async () => {
          throw new Error("Advisory read failed");
        },
        requireRecovery: () => undefined,
      });
      const owner = useReviewConversationOwner(
        "review",
        "session",
        annotations,
      );
      const overlays = useReviewConversationOverlays({
        patch: "",
        annotations,
        viewer: { current: null },
        localCommentAuthoring: undefined,
        pendingReviewComposer: undefined,
        pendingReviewDrafts: {
          conversationOwner: owner,
          fullPatch: "",
          writes: [],
          updateWrites: () => undefined,
          orphanedBody: undefined,
          setOrphanedBody: () => undefined,
        },
        conversationActions: actions,
      });
      const thread = overlays.displayedAnnotations[0]?.conversationThread;
      return {
        thread:
          thread === undefined
            ? undefined
            : overlays.decorateConversationThread(thread),
      };
    },
    { initialProps: { annotations: consumerProjection() } },
  );
}
it("preserves the shared reply when a second appearance skips and the admitted request is refused", async () => {
  let refuse: (response: DesktopResponse) => void = () => undefined;
  const consumer = renderConsumer(
    () =>
      new Promise((resolve) => {
        refuse = resolve;
      }),
  );
  const thread = consumer.result.current.thread;
  if (thread === undefined) throw new Error("Missing thread");
  const cards = render(
    createElement(
      "div",
      null,
      createElement(ConversationThreadCard, { thread }),
      createElement(ConversationThreadCard, { thread }),
    ),
  );
  const appearances = cards.getAllByRole("article");
  const first = appearances[0];
  const second = appearances[1];
  if (first === undefined || second === undefined)
    throw new Error("Missing appearances");
  fireEvent.change(within(first).getByRole("textbox", { name: "Reply" }), {
    target: { value: "Keep my reply" },
  });
  fireEvent.click(within(first).getByRole("button", { name: "Reply" }));
  fireEvent.click(within(second).getByRole("button", { name: "Reply" }));
  await act(async () => undefined);
  expect(within(second).getByRole("textbox", { name: "Reply" })).toMatchObject({
    value: "Keep my reply",
  });
  await act(async () =>
    refuse(failure({ error: "github_refused", cause: "unprocessable" }, 409)),
  );
  expect(within(first).getByRole("textbox", { name: "Reply" })).toMatchObject({
    value: "Keep my reply",
  });
  expect(desktop?.request).toHaveBeenCalledTimes(1);
});
it.each(["edit", "delete", "resolve"] as const)(
  "does not show a skipped %s while another native write is held",
  async (mutation) => {
    let refuse: (response: DesktopResponse) => void = () => undefined;
    const consumer = renderConsumer(
      () =>
        new Promise((resolve) => {
          refuse = resolve;
        }),
    );
    const thread = consumer.result.current.thread;
    if (thread === undefined) throw new Error("Missing thread");
    const held = thread.onReply?.(consumerThreadId, "Held reply");
    const refused = expect(held).rejects.toMatchObject({
      kind: "github_refused",
    });
    await act(async () => {
      if (mutation === "edit")
        await thread.onEditComment?.("comment-1", "Skipped edit");
      if (mutation === "delete") await thread.onDeleteComment?.("comment-1");
      if (mutation === "resolve")
        await thread.onSetState?.(consumerThreadId, "resolved");
    });
    await act(async () => {
      refuse(failure({ error: "github_refused", cause: "unprocessable" }, 409));
      await refused;
    });
    expect(consumer.result.current.thread?.comments[0]?.body).toBe("Original");
    expect(consumer.result.current.thread?.state).toBe("open");
    expect(desktop?.request).toHaveBeenCalledTimes(1);
  },
);
it.each(["edit", "resolve"] as const)(
  "retires a late %s receipt already acknowledged before callback completion",
  async (mutation) => {
    let confirm: (response: DesktopResponse) => void = () => undefined;
    const consumer = renderConsumer(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    const thread = consumer.result.current.thread;
    if (thread === undefined) throw new Error("Missing thread");
    const sending =
      mutation === "edit"
        ? thread.onEditComment?.("comment-1", "A")
        : thread.onSetState?.(consumerThreadId, "resolved");
    consumer.rerender({
      annotations: consumerProjection(
        mutation === "edit" ? "A" : "Original",
        mutation === "resolve" ? "resolved" : "open",
      ),
    });
    await act(async () => {
      confirm(
        success(
          mutation === "edit"
            ? {
                _tag: "PublishedCommentEdited",
                commentId: "comment-1",
                reconciliation: "complete",
              }
            : {
                _tag: "ThreadStateChanged",
                threadId: consumerThreadId,
                state: "resolved",
              },
        ),
      );
      await sending;
    });
    consumer.rerender({ annotations: consumerProjection("B", "open") });
    expect(consumer.result.current.thread?.comments[0]?.body).toBe("B");
    expect(consumer.result.current.thread?.state).toBe("open");
    expect(desktop?.request).toHaveBeenCalledTimes(1);
  },
);
it("retires a whitespace edit after canonical acknowledgment so a later edit wins", async () => {
  const consumer = renderConsumer(() =>
    success({
      _tag: "PublishedCommentEdited",
      commentId: "comment-1",
      reconciliation: "complete",
    }),
  );
  await act(async () =>
    consumer.result.current.thread?.onEditComment?.("comment-1", " Revised "),
  );
  consumer.rerender({ annotations: consumerProjection("Revised") });
  consumer.rerender({ annotations: consumerProjection("Later") });
  expect(consumer.result.current.thread?.comments[0]?.body).toBe("Later");
  expect(desktop?.request).toHaveBeenCalledTimes(1);
});
