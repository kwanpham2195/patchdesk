// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  adjacentCommentAnchor,
  adjacentFilePath,
  adjacentHunkAnchor,
  buildCommentOrder,
  commentNavAnnouncement,
  findCommentThreadCard,
  focusCommentThreadCard,
  shouldIgnoreReviewNavKey,
  type CommentAnchor,
  type CommentOrderItem,
  type HunkAnchor,
} from "../../src/renderer/src/review-diff-keyboard-nav";

function keyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const base: Partial<KeyboardEvent> = {
    target: document.body,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 0,
    ...overrides,
  };
  // SAFETY: `shouldIgnoreReviewNavKey` only reads the fields populated
  // above; a real `KeyboardEvent` is unnecessary for these unit tests.
  return base as KeyboardEvent;
}

describe("adjacentFilePath", () => {
  it("moves to the next file", () => {
    expect(adjacentFilePath(["a", "b", "c"], "a", "next")).toBe("b");
  });

  it("moves to the previous file", () => {
    expect(adjacentFilePath(["a", "b", "c"], "b", "previous")).toBe("a");
  });

  it("stops rather than wrapping past the last file", () => {
    expect(adjacentFilePath(["a", "b", "c"], "c", "next")).toBeUndefined();
  });

  it("stops rather than wrapping past the first file", () => {
    expect(adjacentFilePath(["a", "b", "c"], "a", "previous")).toBeUndefined();
  });

  it("treats an unresolved current file as just before the first file", () => {
    expect(adjacentFilePath(["a", "b", "c"], undefined, "next")).toBe("a");
    expect(
      adjacentFilePath(["a", "b", "c"], undefined, "previous"),
    ).toBeUndefined();
  });

  it("treats a current file missing from order the same as unresolved", () => {
    expect(adjacentFilePath(["a", "b", "c"], "not-in-order", "next")).toBe("a");
  });

  it("returns undefined for an empty order", () => {
    expect(adjacentFilePath([], "a", "next")).toBeUndefined();
    expect(adjacentFilePath([], undefined, "next")).toBeUndefined();
  });
});

describe("adjacentHunkAnchor", () => {
  // Two hunks in "a", one hunk in "b" -- document order across the whole
  // diff, same as `[`/`]` builds by flattening `item.fileDiff.hunks` across
  // every file item in order.
  const first: HunkAnchor = { filePath: "a", lineNumber: 1, side: "additions" };
  const second: HunkAnchor = {
    filePath: "a",
    lineNumber: 10,
    side: "additions",
  };
  const third: HunkAnchor = { filePath: "b", lineNumber: 5, side: "additions" };
  const order = [first, second, third];

  it("moves to the next hunk within the same file", () => {
    expect(adjacentHunkAnchor(order, first, "next")).toEqual(second);
  });

  it("moves to the previous hunk within the same file", () => {
    expect(adjacentHunkAnchor(order, second, "previous")).toEqual(first);
  });

  it("crosses a file boundary moving forward off the last hunk of a file", () => {
    expect(adjacentHunkAnchor(order, second, "next")).toEqual(third);
  });

  it("crosses a file boundary moving backward off the first hunk of a file", () => {
    expect(adjacentHunkAnchor(order, third, "previous")).toEqual(second);
  });

  it("stops rather than wrapping past the last hunk", () => {
    expect(adjacentHunkAnchor(order, third, "next")).toBeUndefined();
  });

  it("stops rather than wrapping past the first hunk", () => {
    expect(adjacentHunkAnchor(order, first, "previous")).toBeUndefined();
  });

  it("treats an unresolved current hunk as just before the first hunk", () => {
    expect(adjacentHunkAnchor(order, undefined, "next")).toEqual(first);
    expect(adjacentHunkAnchor(order, undefined, "previous")).toBeUndefined();
  });

  it("treats a current hunk missing from order the same as unresolved", () => {
    const notInOrder: HunkAnchor = {
      filePath: "z",
      lineNumber: 1,
      side: "deletions",
    };
    expect(adjacentHunkAnchor(order, notInOrder, "next")).toEqual(first);
  });

  it("matches structurally, not by reference -- a rebuilt anchor with the same fields still resolves", () => {
    const rebuiltFirst: HunkAnchor = {
      filePath: "a",
      lineNumber: 1,
      side: "additions",
    };
    expect(adjacentHunkAnchor(order, rebuiltFirst, "next")).toEqual(second);
  });

  it("distinguishes anchors on the same line by side", () => {
    const additionsSide: HunkAnchor = {
      filePath: "a",
      lineNumber: 1,
      side: "additions",
    };
    const deletionsSide: HunkAnchor = {
      filePath: "a",
      lineNumber: 1,
      side: "deletions",
    };
    const mixed = [additionsSide, deletionsSide];
    expect(adjacentHunkAnchor(mixed, additionsSide, "next")).toEqual(
      deletionsSide,
    );
  });

  it("returns undefined for an empty order", () => {
    expect(adjacentHunkAnchor([], first, "next")).toBeUndefined();
    expect(adjacentHunkAnchor([], undefined, "next")).toBeUndefined();
  });
});

describe("adjacentCommentAnchor", () => {
  // Two unresolved comments in "a" (already sorted by line, mirroring the
  // per-file sort the `{`/`}` listener performs before calling this), one
  // in "b" -- document order across the whole diff, same shape as
  // `adjacentHunkAnchor`'s fixture above.
  const first: CommentAnchor = {
    id: "conversation:1",
    filePath: "a",
    lineNumber: 1,
    side: "additions",
  };
  const second: CommentAnchor = {
    id: "conversation:2",
    filePath: "a",
    lineNumber: 10,
    side: "additions",
  };
  const third: CommentAnchor = {
    id: "conversation:3",
    filePath: "b",
    lineNumber: 5,
    side: "additions",
  };
  const order = [first, second, third];

  it("moves to the next comment within the same file", () => {
    expect(adjacentCommentAnchor(order, first, "next")).toEqual(second);
  });

  it("moves to the previous comment within the same file", () => {
    expect(adjacentCommentAnchor(order, second, "previous")).toEqual(first);
  });

  it("crosses a file boundary moving forward off the last comment of a file", () => {
    expect(adjacentCommentAnchor(order, second, "next")).toEqual(third);
  });

  it("crosses a file boundary moving backward off the first comment of a file", () => {
    expect(adjacentCommentAnchor(order, third, "previous")).toEqual(second);
  });

  it("stops rather than wrapping past the last comment", () => {
    expect(adjacentCommentAnchor(order, third, "next")).toBeUndefined();
  });

  it("stops rather than wrapping past the first comment", () => {
    expect(adjacentCommentAnchor(order, first, "previous")).toBeUndefined();
  });

  it("treats an unresolved current comment as just before the first comment", () => {
    expect(adjacentCommentAnchor(order, undefined, "next")).toEqual(first);
    expect(adjacentCommentAnchor(order, undefined, "previous")).toBeUndefined();
  });

  it("treats a current comment missing from order the same as unresolved -- e.g. it was just resolved or filtered out", () => {
    const notInOrder: CommentAnchor = {
      id: "conversation:gone",
      filePath: "z",
      lineNumber: 1,
      side: "deletions",
    };
    expect(adjacentCommentAnchor(order, notInOrder, "next")).toEqual(first);
  });

  it("matches by id, not by file+line+side -- two threads on the same line stay distinct", () => {
    const sameLineFirst: CommentAnchor = {
      id: "conversation:same-line-1",
      filePath: "a",
      lineNumber: 1,
      side: "additions",
    };
    const sameLineSecond: CommentAnchor = {
      id: "conversation:same-line-2",
      filePath: "a",
      lineNumber: 1,
      side: "additions",
    };
    const mixed = [sameLineFirst, sameLineSecond];
    expect(adjacentCommentAnchor(mixed, sameLineFirst, "next")).toEqual(
      sameLineSecond,
    );
  });

  it("returns undefined for an empty order", () => {
    expect(adjacentCommentAnchor([], first, "next")).toBeUndefined();
    expect(adjacentCommentAnchor([], undefined, "next")).toBeUndefined();
  });
});

describe("commentNavAnnouncement", () => {
  const first: CommentAnchor = {
    id: "conversation:1",
    filePath: "a",
    lineNumber: 1,
    side: "additions",
  };
  const second: CommentAnchor = {
    id: "conversation:2",
    filePath: "b",
    lineNumber: 5,
    side: "additions",
  };
  const order = [first, second];

  it("announces zero unresolved comments plainly rather than staying silent", () => {
    expect(commentNavAnnouncement([], undefined, "next")).toBe(
      "No unresolved comments.",
    );
  });

  it("includes a 1-of-N position counter when a press lands on a comment", () => {
    expect(commentNavAnnouncement(order, first, "next")).toBe(
      "Comment 1 of 2 unresolved.",
    );
    expect(commentNavAnnouncement(order, second, "next")).toBe(
      "Comment 2 of 2 unresolved.",
    );
  });

  it("announces a forward boundary with the total, singular count", () => {
    expect(commentNavAnnouncement([first], undefined, "next")).toBe(
      "Already at the last unresolved comment. 1 unresolved comment total.",
    );
  });

  it("announces a backward boundary with the total, plural count", () => {
    expect(commentNavAnnouncement(order, undefined, "previous")).toBe(
      "Already at the first unresolved comment. 2 unresolved comments total.",
    );
  });
});

describe("buildCommentOrder", () => {
  it("orders unresolved threads by file (the items' own order), then by line within each file", () => {
    const items: CommentOrderItem[] = [
      {
        id: "a.ts",
        annotations: [
          // Deliberately out of line order in the source array -- the
          // per-file sort, not incidental array order, must produce line
          // order.
          {
            lineNumber: 30,
            side: "additions",
            metadata: {
              id: "conversation:a-late",
              conversationThread: { state: "open" },
            },
          },
          {
            lineNumber: 2,
            side: "additions",
            metadata: {
              id: "conversation:a-early",
              conversationThread: { state: "open" },
            },
          },
        ],
      },
      {
        id: "b.ts",
        annotations: [
          {
            lineNumber: 5,
            side: "additions",
            metadata: {
              id: "conversation:b-early",
              conversationThread: { state: "open" },
            },
          },
        ],
      },
    ];
    // Document order is trusted from `items`' own order (the caller already
    // supplies it that way, mirroring how `[`/`]` flattens
    // `item.fileDiff.hunks` across files in order) -- this function only
    // adds the per-file line sort on top.
    expect(buildCommentOrder(items).map((anchor) => anchor.id)).toEqual([
      "conversation:a-early",
      "conversation:a-late",
      "conversation:b-early",
    ]);
  });

  it("excludes a resolved thread", () => {
    const items: CommentOrderItem[] = [
      {
        id: "a.ts",
        annotations: [
          {
            lineNumber: 1,
            side: "additions",
            metadata: {
              id: "conversation:open",
              conversationThread: { state: "open" },
            },
          },
          {
            lineNumber: 2,
            side: "additions",
            metadata: {
              id: "conversation:resolved",
              conversationThread: { state: "resolved" },
            },
          },
        ],
      },
    ];
    expect(buildCommentOrder(items).map((anchor) => anchor.id)).toEqual([
      "conversation:open",
    ]);
  });

  it("excludes an annotation that isn't a comment thread at all", () => {
    const items: CommentOrderItem[] = [
      {
        id: "a.ts",
        annotations: [
          { lineNumber: 1, side: "additions", metadata: { id: "finding:1" } },
          { lineNumber: 2, side: "additions", metadata: undefined },
        ],
      },
    ];
    expect(buildCommentOrder(items)).toEqual([]);
  });

  it("returns an empty order for items with no annotations", () => {
    expect(buildCommentOrder([{ id: "a.ts" }])).toEqual([]);
    expect(buildCommentOrder([])).toEqual([]);
  });
});

describe("findCommentThreadCard", () => {
  it("finds the card whose data-review-comment-thread value matches exactly", () => {
    const first = document.createElement("article");
    first.dataset.reviewCommentThread = "conversation:1";
    const second = document.createElement("article");
    second.dataset.reviewCommentThread = "conversation:2";
    document.body.append(first, second);
    try {
      expect(findCommentThreadCard("conversation:2")).toBe(second);
    } finally {
      first.remove();
      second.remove();
    }
  });

  it("never treats the id as a CSS selector -- a value with selector-special characters still matches by comparison", () => {
    const card = document.createElement("article");
    card.dataset.reviewCommentThread = 'conversation:has"quote]and[bracket';
    document.body.append(card);
    try {
      expect(findCommentThreadCard('conversation:has"quote]and[bracket')).toBe(
        card,
      );
    } finally {
      card.remove();
    }
  });

  it("returns undefined when no card matches", () => {
    expect(findCommentThreadCard("conversation:missing")).toBeUndefined();
  });
});

describe("focusCommentThreadCard", () => {
  it("focuses the card immediately when it already exists", () => {
    const card = document.createElement("article");
    card.tabIndex = -1;
    card.dataset.reviewCommentThread = "conversation:1";
    document.body.append(card);
    try {
      focusCommentThreadCard("conversation:1", () => false);
      expect(document.activeElement).toBe(card);
    } finally {
      card.remove();
    }
  });

  it("does nothing when isStale is already true", () => {
    const card = document.createElement("article");
    card.tabIndex = -1;
    card.dataset.reviewCommentThread = "conversation:1";
    document.body.append(card);
    document.body.focus();
    try {
      focusCommentThreadCard("conversation:1", () => true);
      expect(document.activeElement).not.toBe(card);
    } finally {
      card.remove();
    }
  });

  it("polls across animation frames until the card mounts, then focuses it", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    // The card doesn't exist yet -- simulates CodeView mounting the
    // annotation portal a few frames after the scroll that materializes it.
    window.setTimeout(() => {
      const card = document.createElement("article");
      card.tabIndex = -1;
      card.dataset.reviewCommentThread = "conversation:late";
      container.append(card);
    }, 30);
    try {
      focusCommentThreadCard("conversation:late", () => false);
      await expect
        .poll(() =>
          document.activeElement?.getAttribute("data-review-comment-thread"),
        )
        .toBe("conversation:late");
    } finally {
      container.remove();
    }
  });
});

describe("shouldIgnoreReviewNavKey", () => {
  it("ignores the key when a text input is the target", () => {
    const input = document.createElement("input");
    expect(shouldIgnoreReviewNavKey(keyEvent({ target: input }))).toBe(true);
  });

  it("ignores the key when a textarea is the target", () => {
    const textarea = document.createElement("textarea");
    expect(shouldIgnoreReviewNavKey(keyEvent({ target: textarea }))).toBe(true);
  });

  // jsdom does not implement `HTMLElement.isContentEditable` (it stays
  // `undefined` even after setting the `contenteditable` attribute), so the
  // contenteditable branch of `isTypingTarget` can't be exercised here. Real
  // Chromium (tests/browser/review-diff-keyboard-nav.spec.ts) verifies the
  // adjacent `<textarea>` branch of the same guard end to end instead.

  it("ignores the key when any modifier is held", () => {
    expect(shouldIgnoreReviewNavKey(keyEvent({ metaKey: true }))).toBe(true);
    expect(shouldIgnoreReviewNavKey(keyEvent({ ctrlKey: true }))).toBe(true);
    expect(shouldIgnoreReviewNavKey(keyEvent({ altKey: true }))).toBe(true);
  });

  it("ignores the key during IME composition", () => {
    expect(shouldIgnoreReviewNavKey(keyEvent({ isComposing: true }))).toBe(
      true,
    );
    expect(shouldIgnoreReviewNavKey(keyEvent({ keyCode: 229 }))).toBe(true);
  });

  it("ignores the key when focus sits inside an open dialog", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();
    try {
      expect(shouldIgnoreReviewNavKey(keyEvent({ target: button }))).toBe(true);
    } finally {
      dialog.remove();
    }
  });

  it("ignores the key when focus sits inside an open alertdialog", () => {
    const alertDialog = document.createElement("div");
    alertDialog.setAttribute("role", "alertdialog");
    const button = document.createElement("button");
    alertDialog.appendChild(button);
    document.body.appendChild(alertDialog);
    button.focus();
    try {
      expect(shouldIgnoreReviewNavKey(keyEvent({ target: button }))).toBe(true);
    } finally {
      alertDialog.remove();
    }
  });

  it("allows the key on a plain, unmodified, non-editable target", () => {
    expect(shouldIgnoreReviewNavKey(keyEvent({ target: document.body }))).toBe(
      false,
    );
  });
});
