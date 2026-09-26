// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskApiError } from "../../src/renderer/src/api-client";

import type { ConversationThreadCardData } from "../../src/renderer/src/components/conversation-thread-card";
import type {
  LocalCommentAuthoring,
  ReviewInlineAnnotation,
} from "../../src/renderer/src/components/review-diff-view";
import {
  useReviewConversationOverlays,
  type ReviewConversationOverlays,
} from "../../src/renderer/src/hooks/use-review-conversation-overlays";
import {
  usePendingReviewDrafts,
  type PendingReviewDrafts,
} from "../../src/renderer/src/hooks/use-pending-review-drafts";

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
// Refresh moved the change down the file: line 2 is no longer in the diff, and the added line is now 6.
const REFRESHED_PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -5,2 +5,2 @@",
  " const e = 5;",
  "-const f = 6;",
  "+const f = 7;",
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
        pendingReviewDrafts: undefined,
        conversationActions: undefined,
      }),
    { initialProps: { annotations: initialAnnotations } },
  );
}

function pendingOverlaysInput(
  patch: string,
  onStartReview: (body: string) => Promise<void>,
  canAuthor: (line: number) => boolean,
  pendingReviewDrafts: PendingReviewDrafts,
): Parameters<typeof useReviewConversationOverlays>[0] {
  return {
    patch,
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
    pendingReviewDrafts,
    conversationActions: undefined,
  };
}

/** The diff and the workbench's drafts in one render, the way a mounted Diff tab sees them. */
function renderPendingOverlays(
  onStartReview: (body: string) => Promise<void>,
  canAuthor: (line: number) => boolean = () => true,
) {
  return renderHook(
    ({ patch }: { patch: string }) =>
      useReviewConversationOverlays(
        pendingOverlaysInput(
          patch,
          onStartReview,
          canAuthor,
          usePendingReviewDrafts("review-a"),
        ),
      ),
    { initialProps: { patch: PATCH } },
  );
}

/** The workbench's drafts on their own, so the diff can unmount and mount again beneath them. */
function renderWorkbenchDrafts() {
  return renderHook(
    ({ reviewId }: { reviewId: string }) => usePendingReviewDrafts(reviewId),
    { initialProps: { reviewId: "review-a" } },
  );
}

function mountDiff(
  workbench: ReturnType<typeof renderWorkbenchDrafts>,
  onStartReview: (body: string) => Promise<void> = rejectedStart,
) {
  return renderHook(() =>
    useReviewConversationOverlays(
      pendingOverlaysInput(
        PATCH,
        onStartReview,
        () => true,
        workbench.result.current,
      ),
    ),
  );
}

function failedDraftBodies(overlays: ReviewConversationOverlays) {
  return overlays.displayedAnnotations.flatMap((annotation) =>
    annotation.pendingReviewWrite?.status === "failed"
      ? [annotation.pendingReviewWrite.body]
      : [],
  );
}

async function rejectPendingDraft(
  rendered: {
    readonly result: { readonly current: ReviewConversationOverlays };
  },
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
    expect(rendered.result.current.draftRecovery?.message).toBe(
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
    expect(rendered.result.current.draftRecovery).toBeUndefined();
  });

  it("keeps a failed draft whose lines Refresh removed and restores it on a newly selected line", async () => {
    const rendered = renderPendingOverlays(rejectedStart);
    await rejectPendingDraft(rendered, "Draft whose lines went away");

    rendered.rerender({ patch: REFRESHED_PATCH });

    expect(
      rendered.result.current.displayedAnnotations.some(
        (annotation) => annotation.pendingReviewWrite !== undefined,
      ),
    ).toBe(false);
    expect(rendered.result.current.draftRecovery).toBeDefined();
    act(() =>
      rendered.result.current.beginAccessibleAuthoring(PATH, 6, "additions"),
    );
    expect(
      rendered.result.current.localComposerAnnotation?.localComposer
        ?.initialBody,
    ).toBe("Draft whose lines went away");
    expect(rendered.result.current.draftRecovery).toBeUndefined();
  });

  it("drops a failed draft whose lines Refresh removed when the maintainer dismisses it", async () => {
    const rendered = renderPendingOverlays(rejectedStart);
    await rejectPendingDraft(rendered, "Draft to drop");
    rendered.rerender({ patch: REFRESHED_PATCH });

    act(() => rendered.result.current.draftRecovery?.onDismiss());
    act(() =>
      rendered.result.current.beginAccessibleAuthoring(PATH, 6, "additions"),
    );

    expect(rendered.result.current.draftRecovery).toBeUndefined();
    expect(
      rendered.result.current.localComposerAnnotation?.localComposer
        ?.initialBody,
    ).toBeUndefined();
  });
});

describe("pending-review drafts held by the workbench", () => {
  it("shows a draft refused while the diff was unmounted once the diff mounts again", async () => {
    const workbench = renderWorkbenchDrafts();
    let refuse: () => void = () => undefined;
    const first = mountDiff(
      workbench,
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = () => reject(rejection());
        }),
    );
    act(() =>
      first.result.current.beginAccessibleAuthoring(PATH, 2, "additions"),
    );
    const start =
      first.result.current.localComposerAnnotation?.localComposer?.pendingReview
        ?.onStartReview;
    if (start === undefined) throw new Error("expected Start a review");
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = start(
        { path: PATH, startLine: 2, line: 2, side: "new" },
        "Draft sent before a tab switch",
      );
    });

    first.unmount();
    await act(async () => {
      refuse();
      await sending;
    });

    expect(failedDraftBodies(mountDiff(workbench).result.current)).toEqual([
      "Draft sent before a tab switch",
    ]);
  });

  it("drops a Review's drafts when another Review opens", async () => {
    const workbench = renderWorkbenchDrafts();
    await rejectPendingDraft(mountDiff(workbench), "Draft on Review A");

    workbench.rerender({ reviewId: "review-b" });
    expect(failedDraftBodies(mountDiff(workbench).result.current)).toEqual([]);
    workbench.rerender({ reviewId: "review-a" });
    expect(failedDraftBodies(mountDiff(workbench).result.current)).toEqual([]);
  });
});

function rejection(): PatchdeskApiError {
  return new PatchdeskApiError(
    "github_rejected",
    422,
    false,
    "rejected-write",
    "A pending review already exists.",
  );
}

async function rejectedStart(): Promise<void> {
  throw rejection();
}
