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
import {
  ConversationThreadCard,
  type ConversationThreadTarget,
} from "../../src/renderer/src/components/conversation-thread-card";
import { parseGitHubThreadId } from "../../src/domain/ids";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error("deferred resolve was not initialized");
  };
  let reject: (reason: Error) => void = () => {
    throw new Error("deferred reject was not initialized");
  };
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function expectPendingButton(button: HTMLElement): void {
  expect(button.hasAttribute("disabled")).toBe(true);
  const spinner = within(button).getByRole("status", { name: "Loading" });
  expect(spinner.getAttribute("data-icon")).toBe("inline-start");
}

function expectTextareaValue(element: HTMLElement, value: string): void {
  if (!(element instanceof HTMLTextAreaElement))
    throw new Error("expected a textarea");
  expect(element.value).toBe(value);
}

const threadId = parseGitHubThreadId("thread-1");
if (threadId._tag === "err")
  throw new Error("test fixture thread id must parse");

const thread = (
  overrides: {
    readonly target?: ConversationThreadTarget;
    readonly state?: "open" | "resolved" | "outdated" | "unknown";
    readonly onReply?: (
      threadId: string,
      body: string,
    ) => Promise<string | void>;
    readonly onEditComment?: (commentId: string, body: string) => Promise<void>;
    readonly onDeleteComment?: (commentId: string) => Promise<void>;
    readonly onSetState?: (
      threadId: string,
      state: "open" | "resolved",
    ) => Promise<void>;
    readonly comments?: readonly {
      readonly id: string;
      readonly author: string;
      readonly authorAvatarDataUri?: string | undefined;
      readonly body: string;
      readonly createdAt: string;
      readonly viewerDidAuthor?: boolean | undefined;
    }[];
  } = {},
): Parameters<typeof ConversationThreadCard>[0]["thread"] => ({
  target: { _tag: "thread" as const, id: threadId.value },
  state: "open",
  complete: true,
  comments: [
    {
      id: "c-1",
      author: "reviewer",
      body: "Check this line.",
      createdAt: "2026-08-01T00:00:00.000Z",
      viewerDidAuthor: true,
    },
  ],
  ...overrides,
});

describe("ConversationThreadCard", () => {
  it("treats a freshly published card as authoritative: no pending marker, full actions", () => {
    render(
      <ConversationThreadCard
        thread={thread({
          onEditComment: vi.fn(),
          onDeleteComment: vi.fn(),
          onSetState: vi.fn(),
          onReply: vi.fn(),
          comments: [
            {
              id: "c-new",
              author: "You",
              body: "Just published.",
              createdAt: "2026-08-01T00:01:00.000Z",
              viewerDidAuthor: true,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Just published.")).toBeTruthy();
    expect(screen.queryByText("Updating…")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Reply" })).toBeTruthy();
  });

  it("shows a published reply immediately and reconciles it with the authoritative thread", async () => {
    const user = userEvent.setup();
    const onReply = vi.fn(async () => "c-reply-1");
    const { rerender } = render(
      <ConversationThreadCard thread={thread({ onReply })} />,
    );
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "A reply");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(onReply).toHaveBeenCalledWith("thread-1", "A reply");
    expect(await screen.findByText("A reply")).toBeTruthy();
    expect(screen.queryByText("Updating…")).toBeNull();

    // An explicit refresh replaced the projection; the card now owns the
    // authoritative comment and must drop its local copy.
    rerender(
      <ConversationThreadCard
        thread={thread({
          onReply,
          comments: [
            {
              id: "c-1",
              author: "reviewer",
              body: "Check this line.",
              createdAt: "2026-08-01T00:00:00.000Z",
              viewerDidAuthor: true,
            },
            {
              id: "c-reply-1",
              author: "You",
              body: "A reply",
              createdAt: "2026-08-01T00:02:00.000Z",
              viewerDidAuthor: true,
            },
          ],
        })}
      />,
    );
    expect(screen.getAllByText("A reply")).toHaveLength(1);
  });

  it("keeps the reply composer editable after a reply is published", async () => {
    const user = userEvent.setup();
    const onReply = vi.fn(async () => "c-reply-2");
    render(<ConversationThreadCard thread={thread({ onReply })} />);
    await user.type(
      screen.getByRole("textbox", { name: "Reply" }),
      "Second reply",
    );
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(await screen.findByText("Second reply")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Reply" })).toBeTruthy();
  });

  it("renders Edit and Delete controls for a viewer-authored reply", () => {
    render(
      <ConversationThreadCard
        thread={thread({
          onEditComment: vi.fn(),
          onDeleteComment: vi.fn(),
          comments: [
            {
              id: "c-1",
              author: "reviewer",
              body: "Check this line.",
              createdAt: "2026-08-01T00:00:00.000Z",
              viewerDidAuthor: true,
            },
            {
              id: "c-reply",
              author: "You",
              body: "My reply",
              createdAt: "2026-08-01T00:01:00.000Z",
              viewerDidAuthor: true,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("My reply")).toBeTruthy();
    // The viewer-authored reply must expose the same Edit/Delete controls as
    // the opening comment instead of rendering as inert text.
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    expect(editButtons.length).toBeGreaterThanOrEqual(2);
    expect(deleteButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("shows only the comment actions whose callbacks are supplied", () => {
    const { rerender } = render(
      <ConversationThreadCard thread={thread({ onEditComment: vi.fn() })} />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    rerender(
      <ConversationThreadCard thread={thread({ onDeleteComment: vi.fn() })} />,
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();

    rerender(<ConversationThreadCard thread={thread()} />);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("admits one edit synchronously and preserves its draft after failure", async () => {
    const user = userEvent.setup();
    const edit = deferred<void>();
    const onEditComment = vi.fn(() => edit.promise);
    render(<ConversationThreadCard thread={thread({ onEditComment })} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit comment" });
    await user.clear(editor);
    await user.type(editor, "Edited while waiting");
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    fireEvent.click(save);

    expect(onEditComment).toHaveBeenCalledWith("c-1", "Edited while waiting");
    expect(onEditComment).toHaveBeenCalledOnce();
    expectPendingButton(screen.getByRole("button", { name: /Saving/ }));
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(editor.hasAttribute("disabled")).toBe(true);

    edit.reject(new Error("edit failed"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expectTextareaValue(editor, "Edited while waiting");
  });

  it("associates edit errors with the editor control", async () => {
    const user = userEvent.setup();
    const onEditComment = vi.fn(async () => {
      throw new Error("edit failed");
    });
    render(<ConversationThreadCard thread={thread({ onEditComment })} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit comment" });
    await user.clear(editor);
    await user.type(editor, "Edited comment");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const error = await screen.findByRole("alert");
    const describedBy = editor.getAttribute("aria-describedby");
    if (describedBy === null)
      throw new Error("Expected the editor to describe its error");
    expect(editor.getAttribute("aria-invalid")).toBe("true");
    expect(error.id).toBe(describedBy);
    expect(
      editor.closest('[data-slot="field"]')?.getAttribute("data-invalid"),
    ).toBe("true");
  });

  it.each([
    { state: "open" as const, idle: "Resolve", pending: "Resolving…" },
    {
      state: "resolved" as const,
      idle: "Unresolve",
      pending: "Unresolving…",
    },
  ])(
    "admits one $idle request and blocks the reply controls until settlement",
    async ({ state, idle, pending: pendingCopy }) => {
      const threadState = deferred<void>();
      const onSetState = vi.fn(() => threadState.promise);
      const onReply = vi.fn(async () => undefined);
      render(
        <ConversationThreadCard
          thread={thread({ state, onSetState, onReply })}
        />,
      );
      const reply = screen.getByRole("textbox", { name: "Reply" });
      await userEvent.setup().type(reply, "Preserved reply draft");
      const stateButton = screen.getByRole("button", { name: idle });
      fireEvent.click(stateButton);
      fireEvent.click(stateButton);

      expect(onSetState).toHaveBeenCalledOnce();
      expectPendingButton(
        screen.getByRole("button", { name: new RegExp(pendingCopy) }),
      );
      expect(reply.hasAttribute("disabled")).toBe(true);
      expectTextareaValue(reply, "Preserved reply draft");
      expect(
        screen.getByRole("button", { name: "Reply" }).hasAttribute("disabled"),
      ).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      expect(onReply).not.toHaveBeenCalled();

      threadState.resolve(undefined);
      await screen.findByRole("button", { name: idle });
    },
  );

  it("admits one reply synchronously and preserves its draft after failure", async () => {
    const user = userEvent.setup();
    const replyRequest = deferred<string | void>();
    const onReply = vi.fn(() => replyRequest.promise);
    const onSetState = vi.fn(async () => undefined);
    render(<ConversationThreadCard thread={thread({ onReply, onSetState })} />);

    const reply = screen.getByRole("textbox", { name: "Reply" });
    await user.type(reply, "Reply while waiting");
    const replyButton = screen.getByRole("button", { name: "Reply" });
    fireEvent.click(replyButton);
    fireEvent.click(replyButton);

    expect(onReply).toHaveBeenCalledWith("thread-1", "Reply while waiting");
    expect(onReply).toHaveBeenCalledOnce();
    expectPendingButton(screen.getByRole("button", { name: /Replying/ }));
    expect(reply.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Resolve" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onSetState).not.toHaveBeenCalled();

    replyRequest.reject(new Error("reply failed"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expectTextareaValue(reply, "Reply while waiting");
  });

  it("owns deletion per comment row and keeps the comment after failure", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const deletion = deferred<void>();
    const onDeleteComment = vi.fn(() => deletion.promise);
    render(
      <ConversationThreadCard
        thread={thread({
          onEditComment: vi.fn(async () => undefined),
          onDeleteComment,
          comments: [
            {
              id: "c-1",
              author: "reviewer",
              body: "First comment",
              createdAt: "2026-08-01T00:00:00.000Z",
              viewerDidAuthor: true,
            },
            {
              id: "c-2",
              author: "reviewer",
              body: "Second comment",
              createdAt: "2026-08-01T00:01:00.000Z",
              viewerDidAuthor: true,
            },
          ],
        })}
      />,
    );
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    const firstDelete = deleteButtons[0];
    if (firstDelete === undefined) throw new Error("missing first Delete");
    fireEvent.click(firstDelete);
    fireEvent.click(firstDelete);

    expect(onDeleteComment).toHaveBeenCalledWith("c-1");
    expect(onDeleteComment).toHaveBeenCalledOnce();
    expectPendingButton(screen.getByRole("button", { name: /Deleting/ }));
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    expect(editButtons[0]?.hasAttribute("disabled")).toBe(true);
    expect(editButtons[1]?.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.getByText("First comment")).toBeTruthy();

    deletion.reject(new Error("delete failed"));
    expect((await screen.findByRole("alert")).getAttribute("data-slot")).toBe(
      "inline-error",
    );
    expect(screen.getByText("First comment")).toBeTruthy();
    expect(screen.getByText("Second comment")).toBeTruthy();
  });

  it("edits a viewer-authored reply through its row controls", async () => {
    const user = userEvent.setup();
    const onEditComment = vi.fn(async () => undefined);
    render(
      <ConversationThreadCard
        thread={thread({
          onEditComment,
          comments: [
            {
              id: "c-1",
              author: "reviewer",
              body: "Check this line.",
              createdAt: "2026-08-01T00:00:00.000Z",
              viewerDidAuthor: true,
            },
            {
              id: "c-reply",
              author: "You",
              body: "My reply",
              createdAt: "2026-08-01T00:01:00.000Z",
              viewerDidAuthor: true,
            },
          ],
        })}
      />,
    );
    const replyEdit = screen.getAllByRole("button", { name: "Edit" }).at(-1);
    if (replyEdit === undefined)
      throw new Error("Expected a reply Edit control");
    await user.click(replyEdit);
    const editor = screen
      .getAllByRole("textbox", { name: "Edit comment" })
      .at(-1);
    if (editor === undefined) throw new Error("Expected a reply edit editor");
    await user.clear(editor);
    await user.type(editor, "Edited reply");
    // SAFETY: the reply row's edit mode above already asserted a "Save"
    // button renders, so this list is non-empty and `.at(-1)` is defined.
    await user.click(
      screen.getAllByRole("button", { name: "Save" }).at(-1) as HTMLElement,
    );
    expect(onEditComment).toHaveBeenCalledWith("c-reply", "Edited reply");
  });

  it("explains why Reply and Resolve are unavailable on a comment-only card", () => {
    render(
      <ConversationThreadCard
        thread={thread({
          target: { _tag: "comment_only", commentId: "c-new" },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(
      screen.getByText(/Reply and Resolve aren.t available/i),
    ).toBeTruthy();
  });

  it("never shows the comment-only fallback copy on a confirmed thread card", () => {
    render(<ConversationThreadCard thread={thread()} />);
    expect(
      screen.queryByText(/Reply and Resolve aren.t available/i),
    ).toBeNull();
  });

  it("renders a cached avatar image when authorAvatarDataUri is present, and initials when it is absent", () => {
    const dataUri = "data:image/png;base64,AAAA";
    const { container } = render(
      <ConversationThreadCard
        thread={thread({
          comments: [
            {
              id: "c-1",
              author: "reviewer",
              authorAvatarDataUri: dataUri,
              body: "Check this line.",
              createdAt: "2026-08-01T00:00:00.000Z",
            },
            {
              id: "c-2",
              author: "nobody",
              body: "No avatar synced yet.",
              createdAt: "2026-08-01T00:01:00.000Z",
            },
          ],
        })}
      />,
    );
    const avatars = container.querySelectorAll('[data-slot="avatar"]');
    expect(avatars).toHaveLength(2);
    const [withAvatar, withoutAvatar] = avatars;
    expect(withAvatar?.tagName).toBe("IMG");
    expect(withAvatar?.getAttribute("src")).toBe(dataUri);
    expect(withAvatar?.getAttribute("aria-hidden")).toBe("true");
    expect(withoutAvatar?.tagName).toBe("SPAN");
    expect(withoutAvatar?.textContent).toBe("N");
    expect(withoutAvatar?.getAttribute("aria-hidden")).toBe("true");
  });

  it("falls back to initials for a failed cached image and retries after the data URI changes", () => {
    const dataUri = "data:image/png;base64,AAAA";
    const baseComment = {
      id: "c-1",
      author: "reviewer",
      body: "Check this line.",
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const avatarComment = { ...baseComment, authorAvatarDataUri: dataUri };
    const renderCard = (comment: typeof baseComment | typeof avatarComment) => (
      <ConversationThreadCard thread={thread({ comments: [comment] })} />
    );
    const { container, rerender } = render(renderCard(avatarComment));
    const image = container.querySelector('img[data-slot="avatar"]');
    if (image === null) throw new Error("Expected a cached avatar image");

    fireEvent.error(image);

    const fallback = container.querySelector('[data-slot="avatar"]');
    expect(fallback?.tagName).toBe("SPAN");
    expect(fallback?.textContent).toBe("R");
    expect(fallback?.getAttribute("aria-hidden")).toBe("true");

    rerender(renderCard(avatarComment));
    expect(container.querySelector('img[data-slot="avatar"]')).toBeNull();

    rerender(renderCard(baseComment));
    rerender(renderCard(avatarComment));
    const retriedImage = container.querySelector('img[data-slot="avatar"]');
    expect(retriedImage?.getAttribute("src")).toBe(dataUri);
  });
});
