// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { parseGitHubThreadId } from "#src/domain/ids";
import type { ReviewInlineAnnotation } from "#src/renderer/src/components/review-diff-view";
import {
  useReviewConversationOwner,
  useReviewConversationDraft,
  type ReviewConversationOwner,
} from "#src/renderer/src/hooks/use-review-conversation-owner";
import { useReviewConversationOverlays } from "#src/renderer/src/hooks/use-review-conversation-overlays";

const parsed = parseGitHubThreadId("thread-1");
if (parsed._tag !== "ok") throw new Error("Invalid fixture thread");
const threadId = parsed.value;
const opening = {
  id: "opening",
  body: "Original",
  author: "You",
  viewerDidAuthor: true,
  createdAt: "2026-10-01T00:00:00Z",
};
const reply = { ...opening, id: "reply-1", body: "Confirmed reply" };
const annotation: ReviewInlineAnnotation = {
  id: "thread",
  path: "src/a.ts",
  start: 2,
  end: 2,
  side: "new",
  severity: "conversation",
  title: "Conversation",
  explanation: "",
  conversationThread: {
    target: { _tag: "thread", id: threadId },
    state: "open",
    comments: [opening],
  },
};
const canonical: ReadonlyArray<ReviewInlineAnnotation> = [annotation];
const representedReply = [
  {
    ...annotation,
    conversationThread: {
      target: { _tag: "thread" as const, id: threadId },
      state: "open" as const,
      comments: [opening, reply],
    },
  },
];
afterEach(cleanup);

function useAppearance(
  owner: ReviewConversationOwner,
  annotations: ReadonlyArray<ReviewInlineAnnotation>,
  onReply: (threadId: string, body: string) => Promise<string | void>,
) {
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
    conversationActions: {
      replyToThread: onReply,
      editComment: async () => undefined,
      deleteComment: async () => undefined,
    },
  });
  const thread = overlays.displayedAnnotations[0]?.conversationThread;
  if (thread === undefined) throw new Error("Missing fixture thread");
  return overlays.decorateConversationThread(thread);
}

function mountScope(
  onReply: (threadId: string, body: string) => Promise<string | void>,
) {
  return renderHook(
    ({ reviewId, sessionId, annotations }) => {
      const owner = useReviewConversationOwner(
        reviewId,
        sessionId,
        annotations,
      );
      const thread = useAppearance(owner, annotations, onReply);
      const replyDraft = useReviewConversationDraft(owner, `reply:${threadId}`);
      const editDraft = useReviewConversationDraft(owner, "edit:opening");
      return { owner, thread, replyDraft, editDraft };
    },
    {
      initialProps: {
        reviewId: "review-a",
        sessionId: "session-a",
        annotations: canonical,
      },
    },
  );
}

it("shares a reply confirmed after its appearance unmounts without replay, including subsequent edit and delete", async () => {
  let confirm: (id: string) => void = () => undefined;
  const writes: string[] = [];
  const scope = mountScope(async () => undefined);
  const initiating = renderHook(() =>
    useAppearance(scope.result.current.owner, canonical, (_id, body) => {
      writes.push(body);
      return new Promise<string>((resolve) => {
        confirm = resolve;
      });
    }),
  );
  let sending: Promise<string | void> | undefined;
  act(() => {
    sending = initiating.result.current.onReply?.(threadId, "Confirmed reply");
  });
  initiating.unmount();
  await act(async () => {
    confirm("reply-1");
    await sending;
  });
  expect(
    scope.result.current.thread.comments.map((comment) => comment.body),
  ).toEqual(["Original", "Confirmed reply"]);
  const returned = renderHook(() =>
    useAppearance(scope.result.current.owner, canonical, async () => undefined),
  );
  await act(async () =>
    returned.result.current.onEditComment?.("reply-1", "Edited reply"),
  );
  expect(scope.result.current.thread.comments.at(-1)?.body).toBe(
    "Edited reply",
  );
  await act(async () => returned.result.current.onDeleteComment?.("reply-1"));
  expect(
    scope.result.current.thread.comments.map((comment) => comment.id),
  ).toEqual(["opening"]);
  scope.rerender({
    reviewId: "review-a",
    sessionId: "session-a",
    annotations: [...canonical],
  });
  expect(returned.result.current.comments.map((comment) => comment.id)).toEqual(
    ["opening"],
  );
  expect(writes).toEqual(["Confirmed reply"]);
});

it.each(["before", "after"] as const)(
  "retires a reply receipt when canonical observation arrives %s confirmation",
  async (order) => {
    let confirm: (id: string) => void = () => undefined;
    const scope = mountScope(
      () =>
        new Promise<string>((resolve) => {
          confirm = resolve;
        }),
    );
    let sending: Promise<string | void> | undefined;
    act(() => {
      sending = scope.result.current.thread.onReply?.(threadId, reply.body);
    });
    if (order === "before")
      scope.rerender({
        reviewId: "review-a",
        sessionId: "session-a",
        annotations: representedReply,
      });
    await act(async () => {
      confirm(reply.id);
      await sending;
    });
    if (order === "after")
      scope.rerender({
        reviewId: "review-a",
        sessionId: "session-a",
        annotations: representedReply,
      });
    expect(
      scope.result.current.thread.comments.filter(
        (comment) => comment.id === reply.id,
      ),
    ).toHaveLength(1);
    scope.rerender({
      reviewId: "review-a",
      sessionId: "session-a",
      annotations: canonical,
    });
    expect(
      scope.result.current.thread.comments.map((comment) => comment.id),
    ).toEqual(["opening"]);
  },
);

it.each(["review", "session"] as const)(
  "discards card drafts and late replies after a %s change",
  async (identity) => {
    let confirm: (id: string) => void = () => undefined;
    const scope = mountScope(
      () =>
        new Promise<string>((resolve) => {
          confirm = resolve;
        }),
    );
    act(() => {
      scope.result.current.replyDraft.setBody("Old reply draft");
      scope.result.current.editDraft.setBody("Old edit draft");
    });
    let sending: Promise<string | void> | undefined;
    act(() => {
      sending = scope.result.current.thread.onReply?.(threadId, "Old reply");
    });
    scope.rerender({
      reviewId: identity === "review" ? "review-b" : "review-a",
      sessionId: identity === "session" ? "session-b" : "session-a",
      annotations: canonical,
    });
    await act(async () => {
      confirm("late-reply");
      await sending;
    });
    expect(scope.result.current.replyDraft.body).toBeUndefined();
    expect(scope.result.current.editDraft.body).toBeUndefined();
    expect(
      scope.result.current.thread.comments.map((comment) => comment.id),
    ).toEqual(["opening"]);
  },
);

it("keeps newer reply text when an earlier submission confirms", async () => {
  const scope = mountScope(async () => "reply-1");
  act(() => scope.result.current.replyDraft.setBody("Submitted"));
  const draft = scope.result.current.replyDraft;
  act(() => scope.result.current.replyDraft.setBody("Newer reply"));
  act(() => draft.clearSubmitted("Submitted"));
  expect(scope.result.current.replyDraft.body).toBe("Newer reply");
});
