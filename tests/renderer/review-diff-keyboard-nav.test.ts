// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  adjacentFilePath,
  adjacentHunkAnchor,
  shouldIgnoreReviewNavKey,
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
    expect(
      adjacentFilePath(["a", "b", "c"], "a", "previous"),
    ).toBeUndefined();
  });

  it("treats an unresolved current file as just before the first file", () => {
    expect(adjacentFilePath(["a", "b", "c"], undefined, "next")).toBe("a");
    expect(
      adjacentFilePath(["a", "b", "c"], undefined, "previous"),
    ).toBeUndefined();
  });

  it("treats a current file missing from order the same as unresolved", () => {
    expect(adjacentFilePath(["a", "b", "c"], "not-in-order", "next")).toBe(
      "a",
    );
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
    expect(
      adjacentHunkAnchor(order, undefined, "previous"),
    ).toBeUndefined();
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

describe("shouldIgnoreReviewNavKey", () => {
  it("ignores the key when a text input is the target", () => {
    const input = document.createElement("input");
    expect(shouldIgnoreReviewNavKey(keyEvent({ target: input }))).toBe(true);
  });

  it("ignores the key when a textarea is the target", () => {
    const textarea = document.createElement("textarea");
    expect(shouldIgnoreReviewNavKey(keyEvent({ target: textarea }))).toBe(
      true,
    );
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
      expect(shouldIgnoreReviewNavKey(keyEvent({ target: button }))).toBe(
        true,
      );
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
      expect(shouldIgnoreReviewNavKey(keyEvent({ target: button }))).toBe(
        true,
      );
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
