// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Conversation } from "../../src/renderer/src/components/conversation";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";

afterEach(cleanup);

function generalThreadEntry(
  overrides: Partial<WorkbenchResponse["conversation"]["entries"][number]> = {},
): WorkbenchResponse["conversation"]["entries"][number] {
  // SAFETY: this literal matches the `GeneralThread` wire shape the
  // `Conversation` component under test destructures; it is fixture data,
  // not a runtime-decoded value.
  return {
    _tag: "GeneralThread",
    thread: {
      id: "thread-1",
      state: "open",
      complete: true,
      comments: [
        {
          id: "c-1",
          author: "reviewer",
          body: "General comment.",
          createdAt: "2026-08-01T00:00:00.000Z",
          viewerDidAuthor: true,
        },
      ],
    },
    ...overrides,
  } as WorkbenchResponse["conversation"]["entries"][number];
}

describe("Conversation", () => {
  it("does not present a populated pull request description as an empty conversation", () => {
    render(
      <Conversation
        conversation={{
          prDescription:
            "# What happened\n\n- Changed the route-planning solver.",
          entries: [],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "What happened" })).toBeTruthy();
    expect(screen.getByText("Changed the route-planning solver.")).toBeTruthy();
    expect(screen.queryByText("No conversation yet.")).toBeNull();
  });

  it("uses shared Markdown hierarchy for the PR description and timeline entries", () => {
    render(
      <Conversation
        conversation={{
          prDescription:
            "# Pull request heading\n\n- [x] Completed description task",
          entries: [
            {
              _tag: "IssueComment",
              comment: {
                id: "ic-markdown",
                author: "reviewer",
                body: "## Timeline heading\n\n- [ ] Incomplete timeline task",
                createdAt: "2026-08-01T00:00:00.000Z",
              },
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Pull request heading" }).className,
    ).toContain("text-xl");
    expect(
      screen.getByRole("heading", { name: "Timeline heading" }).className,
    ).toContain("text-lg");
    expect(screen.getByLabelText("Completed task")).toBeTruthy();
    expect(screen.getByLabelText("Incomplete task")).toBeTruthy();
  });

  it("renders Reply, Resolve, Edit, and Delete controls for a general thread when actions are wired", () => {
    render(
      <Conversation
        conversation={{
          prDescription: "",
          entries: [generalThreadEntry()],
        }}
        conversationActions={{
          setThreadState: vi.fn(),
          replyToThread: vi.fn(),
          editComment: vi.fn(),
          deleteComment: vi.fn(),
        }}
      />,
    );
    expect(screen.getByText("General comment.")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Reply" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("submits a reply through the Conversation tab and shows it immediately", async () => {
    const user = userEvent.setup();
    const replyToThread = vi.fn(async () => "c-reply-1");
    render(
      <Conversation
        conversation={{
          prDescription: "",
          entries: [generalThreadEntry()],
        }}
        conversationActions={{ replyToThread }}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "Reply" }), "A reply");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(replyToThread).toHaveBeenCalledWith("thread-1", "A reply");
    expect(await screen.findByText("A reply")).toBeTruthy();
  });

  it("resolves a general thread and flips the button label without a refetch", async () => {
    const user = userEvent.setup();
    const setThreadState = vi.fn(async () => undefined);
    render(
      <Conversation
        conversation={{
          prDescription: "",
          entries: [generalThreadEntry()],
        }}
        conversationActions={{ setThreadState }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(setThreadState).toHaveBeenCalledWith("thread-1", "resolved");
    expect(
      await screen.findByRole("button", { name: "Unresolve" }),
    ).toBeTruthy();
  });

  it("renders a general thread read-only when no conversation actions are passed", () => {
    render(
      <Conversation
        conversation={{
          prDescription: "",
          entries: [generalThreadEntry()],
        }}
      />,
    );
    expect(screen.getByText("General comment.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("shows the unavailable-replies notice instead of silently dropping a comment with an unparseable timestamp", () => {
    // SAFETY: this `thread` override matches the `GeneralThread` wire shape;
    // it is fixture data, not a runtime-decoded value.
    render(
      <Conversation
        conversation={{
          prDescription: "",
          entries: [
            generalThreadEntry({
              thread: {
                id: "thread-1",
                state: "open",
                complete: true,
                comments: [
                  {
                    id: "c-1",
                    author: "reviewer",
                    body: "Readable opening comment.",
                    createdAt: "2026-08-01T00:00:00.000Z",
                    viewerDidAuthor: true,
                  },
                  {
                    id: "c-2",
                    author: "reviewer",
                    body: "Reply with a bad timestamp.",
                    createdAt: "not-a-timestamp",
                    viewerDidAuthor: true,
                  },
                ],
              },
            } as never),
          ],
        }}
      />,
    );
    // The opening comment (readable) still renders...
    expect(screen.getByText("Readable opening comment.")).toBeTruthy();
    // ...but the unreadable reply is dropped, and that drop is visible
    // rather than silent.
    expect(screen.queryByText("Reply with a bad timestamp.")).toBeNull();
    expect(screen.getByText("Some replies unavailable")).toBeTruthy();
  });

  it("still renders a general thread's comments when its own id fails to parse, only withholding Reply/Resolve", () => {
    // SAFETY: this `thread` override matches the `GeneralThread` wire shape;
    // it is fixture data, not a runtime-decoded value.
    render(
      <Conversation
        conversation={{
          prDescription: "",
          entries: [
            generalThreadEntry({
              thread: {
                id: "not a valid thread id",
                state: "open",
                complete: true,
                comments: [
                  {
                    id: "c-1",
                    author: "reviewer",
                    body: "A comment on an unresolvable thread.",
                    createdAt: "2026-08-01T00:00:00.000Z",
                    viewerDidAuthor: true,
                  },
                ],
              },
            } as never),
          ],
        }}
        conversationActions={{
          setThreadState: vi.fn(),
          replyToThread: vi.fn(),
          editComment: vi.fn(),
          deleteComment: vi.fn(),
        }}
      />,
    );
    // The comment body is visible: an unresolvable thread id must not make
    // the thread vanish.
    expect(
      screen.getByText("A comment on an unresolvable thread."),
    ).toBeTruthy();
    // Reply/Resolve need the branded thread id and are withheld...
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    // ...but Edit/Delete key on the comment's own id and still work.
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("renders a cached avatar image for an issue comment when authorAvatarDataUri is present, and initials when it is absent", () => {
    const dataUri = "data:image/png;base64,AAAA";
    // SAFETY: these `IssueComment` literals match the wire shape the
    // `Conversation` component under test destructures; fixture data, not a
    // runtime-decoded value.
    const { container } = render(
      <Conversation
        conversation={{
          prDescription: "",
          entries: [
            {
              _tag: "IssueComment",
              comment: {
                id: "ic-1",
                author: "reviewer",
                authorAvatarDataUri: dataUri,
                body: "Synced avatar.",
                createdAt: "2026-08-01T00:00:00.000Z",
              },
            },
            {
              _tag: "IssueComment",
              comment: {
                id: "ic-2",
                author: "nobody",
                body: "No avatar synced yet.",
                createdAt: "2026-08-01T00:01:00.000Z",
              },
            },
          ] as WorkbenchResponse["conversation"]["entries"],
        }}
      />,
    );
    const avatars = container.querySelectorAll('[data-slot="avatar"]');
    expect(avatars).toHaveLength(2);
    const [withAvatar, withoutAvatar] = avatars;
    expect(withAvatar?.tagName).toBe("IMG");
    expect(withAvatar?.getAttribute("src")).toBe(dataUri);
    expect(withoutAvatar?.tagName).toBe("SPAN");
    expect(withoutAvatar?.textContent).toBe("N");
  });

  it("renders a cached avatar image for a general thread comment when authorAvatarDataUri is present", () => {
    const dataUri = "data:image/png;base64,BBBB";
    const { container } = render(
      <Conversation
        conversation={{
          prDescription: "",
          entries: [
            generalThreadEntry({
              thread: {
                id: "thread-1",
                state: "open",
                complete: true,
                comments: [
                  {
                    id: "c-1",
                    author: "reviewer",
                    authorAvatarDataUri: dataUri,
                    body: "General comment with a synced avatar.",
                    createdAt: "2026-08-01T00:00:00.000Z",
                  },
                ],
              },
            }),
          ],
        }}
      />,
    );
    const avatar = container.querySelector('[data-slot="avatar"]');
    expect(avatar?.tagName).toBe("IMG");
    expect(avatar?.getAttribute("src")).toBe(dataUri);
  });

  it("renders the initials fallback for a review summary, since PublishedReview carries no avatar data", () => {
    // SAFETY: this `ReviewSummary` literal matches the wire shape the
    // `Conversation` component under test destructures; fixture data, not a
    // runtime-decoded value.
    const { container } = render(
      <Conversation
        conversation={{
          prDescription: "",
          entries: [
            {
              _tag: "ReviewSummary",
              review: {
                id: "r-1",
                author: "approver",
                body: "Looks good.",
                event: "APPROVED",
                submittedAt: "2026-08-01T00:00:00.000Z",
                canDismiss: false,
              },
            },
          ] as WorkbenchResponse["conversation"]["entries"],
        }}
      />,
    );
    const avatar = container.querySelector('[data-slot="avatar"]');
    expect(avatar?.tagName).toBe("SPAN");
    expect(avatar?.textContent).toBe("A");
  });
});
