// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskApiError } from "../../src/renderer/src/api-client";

import type { ConversationThreadCardData } from "../../src/renderer/src/components/conversation-thread-card";
import type {
  LocalCommentAuthoring,
  ReviewInlineAnnotation,
} from "../../src/renderer/src/components/review-diff-view";
import { useReviewConversationOverlays } from "../../src/renderer/src/hooks/use-review-conversation-overlays";

/**
 * The two id spaces one published comment lives in: the create receipt carries
 * GitHub's REST id, while every projected thread comment carries the GraphQL
 * node id.
 */
const REST_COMMENT_ID = "2145998877";
const NODE_COMMENT_ID = "PRRC_kwDOtest";
const THREAD_ID = "PRRT_kwDOtest";
const PATH = "src/a.ts";
const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "+const b = 2;",
  " const c = 3;",
  "",
].join("\n");

function projectedThread(body: string): ReviewInlineAnnotation {
  const conversationThread: ConversationThreadCardData = {
    // SAFETY: the branded thread id is only compared as a string here.
    target: { _tag: "thread", id: THREAD_ID as never },
    state: "open",
    complete: true,
    comments: [
      {
        id: NODE_COMMENT_ID,
        author: "you",
        body,
        createdAt: "2026-09-19T00:00:00.000Z",
        viewerDidAuthor: true,
      },
    ],
  };
  return {
    id: `conversation:${THREAD_ID}`,
    path: PATH,
    start: 2,
    end: 2,
    side: "new",
    severity: "conversation",
    title: "Conversation",
    explanation: "",
    conversationThread,
  };
}

function overlayEntries(
  displayed: ReadonlyArray<ReviewInlineAnnotation>,
): ReadonlyArray<ReviewInlineAnnotation> {
  return displayed.filter(
    (annotation) => annotation.id !== `conversation:${THREAD_ID}`,
  );
}

function renderOverlays(
  onSave: LocalCommentAuthoring["onSave"],
  initialAnnotations: ReadonlyArray<ReviewInlineAnnotation> = [],
) {
  return renderHook(
    ({ annotations }: { annotations: ReadonlyArray<ReviewInlineAnnotation> }) =>
      useReviewConversationOverlays({
        patch: PATCH,
        annotations,
        viewer: { current: null },
        localCommentAuthoring: { enabled: true, onSave },
        pendingReviewComposer: undefined,
        conversationActions: undefined,
      }),
    { initialProps: { annotations: initialAnnotations } },
  );
}

function renderPendingOverlays(
  onStartReview: (body: string) => Promise<void>,
  canAuthor: (line: number) => boolean = () => true,
) {
  return renderHook(() =>
    useReviewConversationOverlays({
      patch: PATCH,
      annotations: [],
      viewer: { current: null },
      localCommentAuthoring: {
        enabled: true,
        canAuthor: (location) => canAuthor(location.line),
        onSave: async () => undefined,
      },
      pendingReviewComposer: {
        state: { state: "none" },
        busy: false,
        onStartReview: async (_anchor, body) => onStartReview(body),
        onAddReviewComment: async () => undefined,
      },
      conversationActions: undefined,
    }),
  );
}

async function rejectPendingDraft(
  rendered: ReturnType<typeof renderPendingOverlays>,
  body: string,
): Promise<void> {
  act(() =>
    rendered.result.current.beginAccessibleAuthoring(PATH, 2, "additions"),
  );
  const pendingReview =
    rendered.result.current.localComposerAnnotation?.localComposer
      ?.pendingReview;
  if (pendingReview === undefined) throw new Error("expected composer");
  await act(async () => {
    await pendingReview
      .onStartReview({ path: PATH, startLine: 2, line: 2, side: "new" }, body)
      .catch(() => undefined);
  });
}

async function publishOverlay(
  rendered: ReturnType<typeof renderOverlays>,
): Promise<void> {
  act(() => {
    rendered.result.current.beginAccessibleAuthoring(PATH, 2, "additions");
  });
  const composer = rendered.result.current.localComposerAnnotation;
  if (composer?.localComposer === undefined)
    throw new Error("the composer never opened");
  const save = composer.localComposer.onSave;
  await act(async () => {
    await save("published body");
  });
}

const publishedReceipt = async () => ({
  commentId: REST_COMMENT_ID,
  commentNodeId: NODE_COMMENT_ID,
  threadId: THREAD_ID,
});

afterEach(cleanup);

describe("useReviewConversationOverlays", () => {
  it("drops a published overlay the projection represented, even after the thread goes away", async () => {
    const rendered = renderOverlays(publishedReceipt);
    await publishOverlay(rendered);
    expect(
      overlayEntries(rendered.result.current.displayedAnnotations),
    ).toHaveLength(1);

    rendered.rerender({ annotations: [projectedThread("published body")] });
    expect(rendered.result.current.displayedAnnotations).toHaveLength(1);

    rendered.rerender({ annotations: [] });
    expect(rendered.result.current.displayedAnnotations).toHaveLength(0);
  });

  it("keeps an edited body visible after the projection replaces the overlay", async () => {
    const rendered = renderOverlays(publishedReceipt);
    await publishOverlay(rendered);
    const decorated = rendered.result.current.decorateConversationThread({
      // SAFETY: the branded thread id is only compared as a string here.
      target: { _tag: "thread", id: THREAD_ID as never },
      state: "open",
      comments: [],
      onEditComment: async () => undefined,
    });
    if (decorated.onEditComment === undefined)
      throw new Error("edit was not wired");
    await act(async () => {
      await decorated.onEditComment?.(REST_COMMENT_ID, "edited body");
    });

    rendered.rerender({ annotations: [projectedThread("published body")] });

    const [displayed] = rendered.result.current.displayedAnnotations;
    expect(displayed?.conversationThread?.comments[0]?.body).toBe(
      "edited body",
    );
  });

  it("hides a deleted comment the projection still carries in the other id space", async () => {
    const rendered = renderOverlays(publishedReceipt);
    await publishOverlay(rendered);
    const decorated = rendered.result.current.decorateConversationThread({
      // SAFETY: the branded thread id is only compared as a string here.
      target: { _tag: "thread", id: THREAD_ID as never },
      state: "open",
      comments: [],
      onDeleteComment: async () => undefined,
    });
    if (decorated.onDeleteComment === undefined)
      throw new Error("delete was not wired");
    await act(async () => {
      await decorated.onDeleteComment?.(REST_COMMENT_ID);
    });

    rendered.rerender({ annotations: [projectedThread("published body")] });

    expect(rendered.result.current.displayedAnnotations).toHaveLength(0);
  });
});

describe("pending-review draft recovery", () => {
  it("restores a safely rejected draft into the canonical composer", async () => {
    const rendered = renderPendingOverlays(async () => {
      throw new PatchdeskApiError(
        "github_rejected",
        422,
        false,
        "rejected-write",
        "The pending review changed before this comment could be added.",
      );
    });
    await rejectPendingDraft(rendered, "Draft to restore");

    const failed = rendered.result.current.displayedAnnotations.find(
      (annotation) => annotation.pendingReviewWrite?.status === "failed",
    )?.pendingReviewWrite;
    if (failed?.onEdit === undefined) throw new Error("expected Edit draft");
    act(() => failed.onEdit?.(failed.localId));

    expect(
      rendered.result.current.localComposerAnnotation?.localComposer
        ?.initialBody,
    ).toBe("Draft to restore");
    expect(
      rendered.result.current.displayedAnnotations.some(
        (annotation) => annotation.pendingReviewWrite !== undefined,
      ),
    ).toBe(false);
  });

  it("keeps outcome-unknown writes locked without Edit draft", async () => {
    const rendered = renderPendingOverlays(async () => {
      throw new PatchdeskApiError(
        "timeout",
        504,
        true,
        "unknown-write",
        "The write may have completed.",
      );
    });
    await rejectPendingDraft(rendered, "Unknown draft");

    expect(rendered.result.current.displayedAnnotations).toHaveLength(0);
    expect(rendered.result.current.localComposerAnnotation).toBeUndefined();
  });

  it("preserves a draft until a valid replacement anchor is selected", async () => {
    let validAnchor = true;
    const rendered = renderPendingOverlays(
      async () => {
        throw new PatchdeskApiError(
          "revision_conflict",
          409,
          false,
          "stale-anchor",
          "The anchor is stale.",
        );
      },
      () => validAnchor,
    );
    await rejectPendingDraft(rendered, "Draft needing a new line");
    validAnchor = false;
    const failed = rendered.result.current.displayedAnnotations.find(
      (annotation) => annotation.pendingReviewWrite?.status === "failed",
    )?.pendingReviewWrite;
    if (failed?.onEdit === undefined) throw new Error("expected Edit draft");
    act(() => failed.onEdit?.(failed.localId));
    expect(rendered.result.current.localComposerAnnotation).toBeUndefined();
    expect(rendered.result.current.draftRecoveryMessage).toBe(
      "Select a new diff line to restore the saved draft.",
    );

    validAnchor = true;
    act(() =>
      rendered.result.current.beginAccessibleAuthoring(PATH, 3, "additions"),
    );
    expect(
      rendered.result.current.localComposerAnnotation?.localComposer
        ?.initialBody,
    ).toBe("Draft needing a new line");
    expect(rendered.result.current.draftRecoveryMessage).toBeUndefined();
  });
});
