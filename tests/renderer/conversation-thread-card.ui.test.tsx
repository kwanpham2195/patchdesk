// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationThreadCard } from "../../src/renderer/src/components/review-diff-view";
import { parseGitHubThreadId } from "../../src/domain/ids";

afterEach(() => cleanup());

const threadId = parseGitHubThreadId("thread-1");
if (threadId._tag === "err") throw new Error("test fixture thread id must parse");

const thread = (overrides: {
  readonly onReply?: (threadId: string, body: string) => Promise<string | void>;
  readonly onEditComment?: (commentId: string, body: string) => Promise<void>;
  readonly onDeleteComment?: (commentId: string) => Promise<void>;
  readonly onSetState?: (threadId: string, state: "open" | "resolved") => Promise<void>;
  readonly comments?: readonly {
    readonly id: string;
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
    readonly viewerDidAuthor?: boolean | undefined;
  }[];
} = {}): Parameters<typeof ConversationThreadCard>[0]["thread"] => ({
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
          comments: [{ id: "c-new", author: "You", body: "Just published.", createdAt: "2026-08-01T00:01:00.000Z", viewerDidAuthor: true }],
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
    const { rerender } = render(<ConversationThreadCard thread={thread({ onReply })} />);
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
            { id: "c-1", author: "reviewer", body: "Check this line.", createdAt: "2026-08-01T00:00:00.000Z", viewerDidAuthor: true },
            { id: "c-reply-1", author: "You", body: "A reply", createdAt: "2026-08-01T00:02:00.000Z", viewerDidAuthor: true },
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
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "Second reply");
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
            { id: "c-1", author: "reviewer", body: "Check this line.", createdAt: "2026-08-01T00:00:00.000Z", viewerDidAuthor: true },
            { id: "c-reply", author: "You", body: "My reply", createdAt: "2026-08-01T00:01:00.000Z", viewerDidAuthor: true },
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

  it("edits a viewer-authored reply through its row controls", async () => {
    const user = userEvent.setup();
    const onEditComment = vi.fn(async () => undefined);
    render(
      <ConversationThreadCard
        thread={thread({
          onEditComment,
          comments: [
            { id: "c-1", author: "reviewer", body: "Check this line.", createdAt: "2026-08-01T00:00:00.000Z", viewerDidAuthor: true },
            { id: "c-reply", author: "You", body: "My reply", createdAt: "2026-08-01T00:01:00.000Z", viewerDidAuthor: true },
          ],
        })}
      />,
    );
    const replyEdit = screen.getAllByRole("button", { name: "Edit" }).at(-1);
    if (replyEdit === undefined) throw new Error("Expected a reply Edit control");
    await user.click(replyEdit);
    const editor = screen.getAllByRole("textbox", { name: "Edit comment" }).at(-1);
    if (editor === undefined) throw new Error("Expected a reply edit editor");
    await user.clear(editor);
    await user.type(editor, "Edited reply");
    await user.click(screen.getAllByRole("button", { name: "Save" }).at(-1) as HTMLElement);
    expect(onEditComment).toHaveBeenCalledWith("c-reply", "Edited reply");
  });
});
