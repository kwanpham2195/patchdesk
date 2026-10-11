// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PatchdeskApiError } from "#src/renderer/src/api-client";
import { parseGitHubThreadId } from "#src/domain/ids";
import { usePendingReviewDrafts } from "#src/renderer/src/hooks/use-pending-review-drafts";
import {
  useReviewConversationOwner,
  useReviewConversationDraft,
} from "#src/renderer/src/hooks/use-review-conversation-owner";
import { useReviewConversationOverlays } from "#src/renderer/src/hooks/use-review-conversation-overlays";
import type {
  LocalCommentAuthoring,
  ReviewInlineAnnotation,
} from "#src/renderer/src/components/review-diff-view";
import { useUnsentReviewTextFields } from "#src/renderer/src/hooks/use-unsent-review-text";

const patch =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n first\n+second\n";
const anchor = {
  path: "src/a.ts",
  startLine: 2,
  line: 2,
  side: "new" as const,
};
const empty: ReadonlyArray<ReviewInlineAnnotation> = [];
const parsedThread = parseGitHubThreadId("PRRT_test");
if (parsedThread._tag !== "ok") throw new Error("Invalid fixture thread");
const threadId = parsedThread.value;
const receipt = { commentId: "123", commentNodeId: "PRRC_test", threadId };
const projected: ReviewInlineAnnotation = {
  id: "thread",
  path: anchor.path,
  start: 2,
  end: 2,
  side: "new",
  severity: "conversation",
  title: "Conversation",
  explanation: "",
  conversationThread: {
    target: { _tag: "thread", id: threadId },
    state: "open",
    complete: true,
    comments: [
      {
        id: receipt.commentNodeId,
        author: "You",
        body: "Original",
        createdAt: "2026-10-01T00:00:00Z",
        viewerDidAuthor: true,
      },
    ],
  },
};
afterEach(cleanup);

function renderOwner(
  annotations: ReadonlyArray<ReviewInlineAnnotation> = empty,
  reportUnsent?: (fieldId: string, text: string) => void,
) {
  return renderHook(
    ({ reviewId, sessionId, canonical }) => {
      const conversationOwner = useReviewConversationOwner(
        reviewId,
        sessionId,
        canonical,
        { reportUnsent },
      );
      const pending = usePendingReviewDrafts(reviewId, patch);
      return { ...pending, conversationOwner };
    },
    {
      initialProps: {
        reviewId: "review-a",
        sessionId: "session-a",
        canonical: annotations,
      },
    },
  );
}

function mountAppearance(
  owner: ReturnType<typeof renderOwner>,
  onSave: LocalCommentAuthoring["onSave"] = async () => receipt,
  annotations: ReadonlyArray<ReviewInlineAnnotation> = empty,
  shownPatch: string = patch,
) {
  return renderHook(() =>
    useReviewConversationOverlays({
      patch: shownPatch,
      annotations,
      viewer: { current: null },
      localCommentAuthoring: { enabled: true, onSave },
      pendingReviewDrafts: owner.result.current,
      pendingReviewComposer: {
        state: { state: "none" },
        busy: false,
        onStartReview: async () => {
          throw new PatchdeskApiError(
            "github_rejected",
            422,
            false,
            "refused",
            "Refused",
          );
        },
        onAddReviewComment: async () => undefined,
      },
      conversationActions: {
        editComment: async () => undefined,
        deleteComment: async () => undefined,
        setThreadState: async () => undefined,
      },
    }),
  );
}
function open(appearance: ReturnType<typeof mountAppearance>) {
  act(() =>
    appearance.result.current.beginAccessibleAuthoring(
      anchor.path,
      anchor.line,
      "additions",
    ),
  );
  const composer =
    appearance.result.current.localComposerAnnotation?.localComposer;
  if (composer === undefined) throw new Error("Composer unavailable");
  return composer;
}
function card(appearance: ReturnType<typeof mountAppearance>) {
  const thread = appearance.result.current.displayedAnnotations.find(
    (entry) => entry.conversationThread,
  )?.conversationThread;
  if (thread === undefined) throw new Error("Thread unavailable");
  return appearance.result.current.decorateConversationThread(thread);
}

it("retains an edited refused draft through a reader unmount and shares subsequent unsent edits", async () => {
  const owner = renderOwner();
  const guide = mountAppearance(owner);
  const composer = open(guide);
  await act(async () =>
    composer.pendingReview?.onStartReview(anchor, "Refused body"),
  );
  guide.rerender();
  const failed = guide.result.current.displayedAnnotations.find(
    (entry) => entry.pendingReviewWrite,
  )?.pendingReviewWrite;
  if (failed?.onEdit === undefined) throw new Error("Edit draft unavailable");
  act(() => failed.onEdit?.(failed.localId));
  expect(
    guide.result.current.localComposerAnnotation?.localComposer?.initialBody,
  ).toBe("Refused body");
  act(() =>
    guide.result.current.localComposerAnnotation?.localComposer?.onBodyChange?.(
      "Edited refused body",
    ),
  );
  guide.unmount();
  const diff = mountAppearance(owner);
  expect(open(diff).initialBody).toBe("Edited refused body");
  const repeatedGuide = mountAppearance(owner);
  expect(open(repeatedGuide).draftControl?.getBody()).toBe(
    "Edited refused body",
  );
  act(() =>
    diff.result.current.localComposerAnnotation?.localComposer?.onBodyChange?.(
      "Further edit",
    ),
  );
  expect(
    repeatedGuide.result.current.localComposerAnnotation?.localComposer?.draftControl?.getBody(),
  ).toBe("Further edit");
  expect(owner.result.current.writes).toHaveLength(0);
});

it("retains unsent inline text and its leave guard above appearance lifetimes until explicit cancel", () => {
  const guard = renderHook(() => useUnsentReviewTextFields());
  const owner = renderOwner(empty, guard.result.current.report);
  const appearance = mountAppearance(owner);
  act(() =>
    appearance.result.current.beginAccessibleAuthoring(
      anchor.path,
      2,
      "additions",
    ),
  );
  act(() =>
    appearance.result.current.localComposerAnnotation?.localComposer?.onBodyChange?.(
      "Unsent body",
    ),
  );
  expect(guard.result.current.holdsUnsentText).toBe(true);
  appearance.unmount();
  expect(guard.result.current.holdsUnsentText).toBe(true);
  const returned = mountAppearance(owner);
  expect(open(returned).initialBody).toBe("Unsent body");
  act(() =>
    returned.result.current.localComposerAnnotation?.localComposer?.onCancel(),
  );
  expect(guard.result.current.holdsUnsentText).toBe(false);
  expect(open(returned).initialBody).toBeUndefined();
  act(() => open(returned).onBodyChange?.("Draft before disposal"));
  returned.unmount();
  expect(guard.result.current.holdsUnsentText).toBe(true);
  owner.unmount();
  expect(guard.result.current.holdsUnsentText).toBe(false);
});

it("transfers retained drafts to a replacement reporter without an appearance and releases the guard on session disposal", () => {
  const first = renderHook(() => useUnsentReviewTextFields());
  const second = renderHook(() => useUnsentReviewTextFields());
  const scope = renderHook(
    ({ reportUnsent, sessionId }) =>
      useReviewConversationOwner("review-a", sessionId, empty, {
        reportUnsent,
      }),
    {
      initialProps: {
        reportUnsent: first.result.current.report,
        sessionId: "session-a",
      },
    },
  );
  const draft = renderHook(() =>
    useReviewConversationDraft(scope.result.current, "reply:thread"),
  );
  act(() => draft.result.current.setBody("Retained reply"));
  const firstIdentity = first.result.current.getDraftIdentity();
  act(() => draft.result.current.setBody("Retained reply"));
  expect(first.result.current.getDraftIdentity()).toBe(firstIdentity);
  act(() => draft.result.current.setBody("New nonempty reply"));
  expect(first.result.current.getDraftIdentity()).not.toBe(firstIdentity);
  draft.unmount();
  expect(first.result.current.holdsUnsentText).toBe(true);
  scope.rerender({
    reportUnsent: second.result.current.report,
    sessionId: "session-a",
  });
  expect(first.result.current.holdsUnsentText).toBe(false);
  expect(second.result.current.holdsUnsentText).toBe(true);
  scope.rerender({
    reportUnsent: second.result.current.report,
    sessionId: "session-b",
  });
  expect(second.result.current.holdsUnsentText).toBe(false);
  const replacementDraft = renderHook(() =>
    useReviewConversationDraft(scope.result.current, "reply:thread"),
  );
  expect(replacementDraft.result.current.body).toBeUndefined();
  act(() => replacementDraft.result.current.setBody("Replacement reply"));
  expect(second.result.current.holdsUnsentText).toBe(true);
  scope.unmount();
  expect(second.result.current.holdsUnsentText).toBe(false);
});

it("shares a confirmed create across independent appearances and remounts while canonical observation is unchanged", async () => {
  const owner = renderOwner();
  const submitted: string[] = [];
  const guide = mountAppearance(owner, async ({ body }) => {
    submitted.push(body);
    return receipt;
  });
  const diff = mountAppearance(owner);
  const composer = open(guide);
  await act(async () => composer.onSave("Confirmed body"));
  expect(card(diff).comments[0]?.body).toBe("Confirmed body");
  guide.unmount();
  expect(card(mountAppearance(owner)).comments[0]?.body).toBe("Confirmed body");
  expect(submitted).toEqual(["Confirmed body"]);
  owner.rerender({
    reviewId: "review-a",
    sessionId: "session-a",
    canonical: [projected],
  });
  diff.rerender();
  expect(diff.result.current.displayedAnnotations).toHaveLength(0);
  expect(
    card(mountAppearance(owner, async () => receipt, [projected])).comments[0]
      ?.body,
  ).toBe("Original");
});

it("keeps unsent and created bodies out of another source at the same line coordinates", async () => {
  const owner = renderOwner();
  const guide = mountAppearance(owner);
  const composer = open(guide);
  act(() => composer.onBodyChange?.("Unsent original source"));
  const otherPatch = patch.replace("+second", "+different");
  const other = mountAppearance(owner, async () => receipt, empty, otherPatch);
  expect(open(other).initialBody).toBeUndefined();
  await act(async () => composer.onSave("Confirmed original source"));
  expect(
    other.result.current.displayedAnnotations.filter(
      (entry) => entry.conversationThread,
    ),
  ).toHaveLength(0);
  expect(card(mountAppearance(owner)).comments[0]?.body).toBe(
    "Confirmed original source",
  );
});

it("retains a create that confirms after the initiating appearance unmounts without replay", async () => {
  const owner = renderOwner();
  let confirm: (value: typeof receipt) => void = () => undefined;
  const submissions: string[] = [];
  const guide = mountAppearance(owner, ({ body }) => {
    submissions.push(body);
    return new Promise((resolve) => {
      confirm = resolve;
    });
  });
  const composer = open(guide);
  let sending: Promise<void> = Promise.resolve();
  act(() => {
    sending = composer.onSave("In flight body");
  });
  guide.unmount();
  const diff = mountAppearance(owner);
  await act(async () => {
    confirm(receipt);
    await sending;
  });
  expect(card(diff).comments[0]?.body).toBe("In flight body");
  expect(submissions).toEqual(["In flight body"]);
});

it("keeps an edit's comment identities when canonical observation replaces its create card before confirmation", async () => {
  const owner = renderOwner();
  const guide = mountAppearance(owner);
  const composer = open(guide);
  await act(async () => composer.onSave("Original"));
  let confirm: () => void = () => undefined;
  const thread = guide.result.current.decorateConversationThread({
    ...card(guide),
    onEditComment: () =>
      new Promise<void>((resolve) => {
        confirm = resolve;
      }),
  });
  let editing: Promise<false | void> = Promise.resolve();
  act(() => {
    editing =
      thread.onEditComment?.(receipt.commentId, "Edited after observation") ??
      Promise.resolve();
  });
  owner.rerender({
    reviewId: "review-a",
    sessionId: "session-a",
    canonical: [projected],
  });
  const diff = mountAppearance(owner, async () => receipt, [projected]);
  await act(async () => {
    confirm();
    await editing;
  });
  expect(card(diff).comments[0]?.body).toBe("Edited after observation");
});

it("retires a receipt when canonical observation arrived before its create response", async () => {
  const owner = renderOwner();
  let confirm: (value: typeof receipt) => void = () => undefined;
  const guide = mountAppearance(
    owner,
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  const composer = open(guide);
  let sending: Promise<void> = Promise.resolve();
  act(() => {
    sending = composer.onSave("Original");
  });
  owner.rerender({
    reviewId: "review-a",
    sessionId: "session-a",
    canonical: [projected],
  });
  await act(async () => {
    confirm(receipt);
    await sending;
  });
  owner.rerender({
    reviewId: "review-a",
    sessionId: "session-a",
    canonical: empty,
  });
  expect(
    mountAppearance(owner).result.current.displayedAnnotations,
  ).toHaveLength(0);
});

it.each(["edit", "delete", "resolve"] as const)(
  "shares confirmed %s without a filtered appearance retiring the overlay",
  async (mutation) => {
    const owner = renderOwner([projected]);
    const guide = mountAppearance(owner, async () => receipt, [projected]);
    const diff = mountAppearance(owner, async () => receipt, [projected]);
    const thread = card(guide);
    await act(async () => {
      if (mutation === "edit")
        await thread.onEditComment?.(receipt.commentNodeId, "Edited");
      if (mutation === "delete")
        await thread.onDeleteComment?.(receipt.commentNodeId);
      if (mutation === "resolve")
        await thread.onSetState?.(threadId, "resolved");
    });
    guide.unmount();
    mountAppearance(owner);
    const returned = mountAppearance(owner, async () => receipt, [projected]);
    if (mutation === "delete") {
      expect(diff.result.current.displayedAnnotations).toHaveLength(0);
      expect(returned.result.current.displayedAnnotations).toHaveLength(0);
    } else if (mutation === "edit") {
      expect(card(diff).comments[0]?.body).toBe("Edited");
      expect(card(returned).comments[0]?.body).toBe("Edited");
    } else {
      expect(card(diff).state).toBe("resolved");
      expect(card(returned).state).toBe("resolved");
    }
  },
);

it.each(["review", "session"] as const)(
  "isolates unsent text and a late create receipt after a %s identity change",
  async (identity) => {
    const owner = renderOwner();
    let confirm: (value: typeof receipt) => void = () => undefined;
    const guide = mountAppearance(
      owner,
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    const composer = open(guide);
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = composer.onSave("Old scope write");
    });
    const unsent = open(guide);
    act(() => unsent.onBodyChange?.("Old scope draft"));
    owner.rerender({
      reviewId: identity === "review" ? "review-b" : "review-a",
      sessionId: identity === "session" ? "session-b" : "session-a",
      canonical: empty,
    });
    guide.rerender();
    expect(guide.result.current.localComposerAnnotation).toBeUndefined();
    await act(async () => {
      confirm(receipt);
      await sending;
    });
    expect(guide.result.current.displayedAnnotations).toHaveLength(0);
    expect(open(guide).initialBody).toBeUndefined();
  },
);
