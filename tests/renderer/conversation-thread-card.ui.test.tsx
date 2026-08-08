// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationThreadCard } from "../../src/renderer/src/components/review-diff-view";

afterEach(() => cleanup());

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
});
