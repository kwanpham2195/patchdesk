// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationThreadCard } from "../../src/renderer/src/components/review-diff-view";

afterEach(() => cleanup());

const thread = (overrides: {
  readonly updating?: boolean;
  readonly onReply?: (threadId: string, body: string) => Promise<string | void>;
  readonly onEditComment?: (commentId: string, body: string) => Promise<void>;
  readonly onDeleteComment?: (commentId: string) => Promise<void>;
  readonly comments?: readonly {
    readonly id: string;
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
    readonly viewerDidAuthor?: boolean | undefined;
  }[];
} = {}): Parameters<typeof ConversationThreadCard>[0]["thread"] => ({
  id: "thread-1",
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
  it("shows an optimistic updating card without actions until the refresh reconciles it", () => {
    render(<ConversationThreadCard thread={thread({ updating: true, comments: [{ id: "c-new", author: "You", body: "Just published.", createdAt: "2026-08-01T00:01:00.000Z", viewerDidAuthor: true }] })} />);
    expect(screen.getByRole("status").textContent).toBe("Updating…");
    expect(screen.getByText("Just published.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
  });

  it("shows a published reply optimistically and reconciles it with the authoritative thread", async () => {
    const user = userEvent.setup();
    const onReply = vi.fn(async () => "c-reply-1");
    const { rerender } = render(<ConversationThreadCard thread={thread({ onReply })} />);
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "A reply");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(onReply).toHaveBeenCalledWith("thread-1", "A reply");
    expect(await screen.findByText("A reply")).toBeTruthy();
    expect(screen.getAllByText("Updating…").length).toBeGreaterThan(0);

    // The background refresh replaced the projection; the card now owns the
    // authoritative comment and must drop its optimistic copy.
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
    expect(screen.queryByText("Updating…")).toBeNull();
  });

  it("keeps the reply composer editable while the optimistic reply is pending", async () => {
    const user = userEvent.setup();
    const onReply = vi.fn(async () => "c-reply-2");
    render(<ConversationThreadCard thread={thread({ onReply })} />);
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "Second reply");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(await screen.findByText("Second reply")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Reply" })).toBeTruthy();
  });
});
