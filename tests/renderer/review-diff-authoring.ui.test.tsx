// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InlineCommentComposer } from "../../src/renderer/src/components/review-diff-authoring";

function deferred<T>() {
  let reject: (reason: Error) => void = () => {
    throw new Error("deferred reject was not initialized");
  };
  const promise = new Promise<T>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

afterEach(cleanup);

const composerRows = [
  {
    name: "direct comment",
    mode: "direct" as const,
    idleCopy: "Comment",
    pendingCopy: "Commenting…",
    callback: "save" as const,
  },
  {
    name: "start review",
    mode: "none" as const,
    idleCopy: "Start a review",
    pendingCopy: "Starting…",
    callback: "start" as const,
  },
  {
    name: "add review comment",
    mode: "pending" as const,
    idleCopy: "Add review comment",
    pendingCopy: "Adding…",
    callback: "add" as const,
  },
  {
    name: "comment now",
    mode: "none" as const,
    idleCopy: "Comment now",
    pendingCopy: "Commenting…",
    callback: "save" as const,
  },
];

describe("InlineCommentComposer", () => {
  it.each(composerRows)(
    "admits one $name button request and preserves its draft after failure",
    async ({ mode, idleCopy, pendingCopy, callback }) => {
      const request = deferred<void>();
      const onSave = vi.fn(() => request.promise);
      const onStartReview = vi.fn(() => request.promise);
      const onAddReviewComment = vi.fn(() => request.promise);
      render(
        <InlineCommentComposer
          path="src/a.ts"
          startLine={3}
          line={3}
          side="new"
          onCancel={vi.fn()}
          onSave={onSave}
          {...(mode === "direct"
            ? {}
            : {
                pendingReview: {
                  state:
                    mode === "pending"
                      ? ({ state: "pending", nodeId: "PRR_1" } as const)
                      : ({ state: "none" } as const),
                  busy: false,
                  onStartReview,
                  onAddReviewComment,
                },
              })}
        />,
      );
      const user = userEvent.setup();
      const editor = screen.getByRole("textbox", { name: "Inline comment" });
      await user.type(editor, "Draft under test");
      const initiatingButton = screen.getByRole("button", { name: idleCopy });
      fireEvent.click(initiatingButton);
      fireEvent.click(initiatingButton);

      const expectedCallback =
        callback === "save"
          ? onSave
          : callback === "start"
            ? onStartReview
            : onAddReviewComment;
      expect(expectedCallback).toHaveBeenCalledOnce();
      const pendingButton = screen.getByRole("button", {
        name: new RegExp(pendingCopy),
      });
      expect(pendingButton.hasAttribute("disabled")).toBe(true);
      const spinner = within(pendingButton).getByRole("status", {
        name: "Loading",
      });
      expect(spinner.getAttribute("data-icon")).toBe("inline-start");
      expect(screen.getAllByRole("status", { name: "Loading" })).toHaveLength(
        1,
      );
      expect(editor.hasAttribute("disabled")).toBe(true);
      expect(
        screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
      ).toBe(true);
      for (const button of screen.getAllByRole("button"))
        expect(button.hasAttribute("disabled")).toBe(true);

      request.reject(new Error("write failed"));
      const error = await screen.findByRole("alert");
      expect(error.getAttribute("data-slot")).toBe("field-error");
      expect(editor.getAttribute("aria-invalid")).toBe("true");
      expect(editor.getAttribute("aria-describedby")).toBe(error.id);
      if (!(editor instanceof HTMLTextAreaElement))
        throw new Error("expected inline comment textarea");
      expect(editor.value).toBe("Draft under test");
    },
  );

  it("routes Ctrl+Enter through the same synchronous action guard", async () => {
    const request = deferred<void>();
    const onStartReview = vi.fn(() => request.promise);
    render(
      <InlineCommentComposer
        path="src/a.ts"
        startLine={3}
        line={3}
        side="new"
        onCancel={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        pendingReview={{
          state: { state: "none" },
          busy: false,
          onStartReview,
          onAddReviewComment: vi.fn(async () => undefined),
        }}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Inline comment" });
    await userEvent.setup().type(editor, "Keyboard draft");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    expect(onStartReview).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: /Starting/ }).hasAttribute("disabled"),
    ).toBe(true);
    request.reject(new Error("write failed"));
    const error = await screen.findByRole("alert");
    expect(error.getAttribute("data-slot")).toBe("field-error");
    expect(editor.getAttribute("aria-describedby")).toBe(error.id);
    if (!(editor instanceof HTMLTextAreaElement))
      throw new Error("expected inline comment textarea");
    expect(editor.value).toBe("Keyboard draft");
  });
});
