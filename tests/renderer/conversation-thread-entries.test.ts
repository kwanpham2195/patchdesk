import { describe, expect, it } from "vitest";

import { parseGitHubThreadId } from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";
import type { ReviewInlineAnnotation } from "../../src/renderer/src/components/review-diff-view";
import {
  deriveConversationThreadEntries,
  projectConversationThreadRows,
} from "../../src/renderer/src/conversation-thread-entries";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};

function published(input: {
  readonly id: string;
  readonly path: string;
  readonly start: number;
  readonly end?: number;
  readonly side?: "new" | "old";
  readonly state: "open" | "resolved" | "outdated" | "unknown";
  readonly author: string;
  readonly body: string;
  readonly ghThreadId: string;
}): ReviewInlineAnnotation {
  return {
    id: input.id,
    path: input.path,
    start: input.start,
    end: input.end ?? input.start,
    side: input.side ?? "new",
    severity: "conversation",
    title: "Conversation",
    explanation: "",
    conversationThread: {
      target: {
        _tag: "thread",
        id: must(parseGitHubThreadId(input.ghThreadId)),
      },
      state: input.state,
      comments: [
        {
          id: `${input.ghThreadId}-comment-1`,
          author: input.author,
          body: input.body,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
  };
}

function pending(input: {
  readonly id: string;
  readonly path: string;
  readonly start: number;
  readonly end?: number;
  readonly side?: "new" | "old";
  readonly body: string;
  readonly ghThreadId: string;
}): ReviewInlineAnnotation {
  return {
    id: input.id,
    path: input.path,
    start: input.start,
    end: input.end ?? input.start,
    side: input.side ?? "new",
    severity: "conversation",
    title: "Pending review",
    explanation: "",
    pendingReviewThread: {
      threadId: must(parseGitHubThreadId(input.ghThreadId)),
      body: input.body,
      nodeId: "PR_review_node",
    },
  };
}

describe("deriveConversationThreadEntries", () => {
  it("dedupes a published thread that also has a pending reply to its pending entry", () => {
    const publishedEntry = published({
      id: "conversation:PRRT_shared",
      path: "a.ts",
      start: 3,
      state: "open",
      author: "reviewer",
      body: "please fix this",
      ghThreadId: "PRRT_shared",
    });
    const pendingEntry = pending({
      id: "pending-review:PRRT_shared",
      path: "a.ts",
      start: 3,
      body: "on it",
      ghThreadId: "PRRT_shared",
    });

    const result = deriveConversationThreadEntries(
      [publishedEntry],
      [pendingEntry],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(pendingEntry);
  });

  it("keeps a published thread with no pending reply and every pending entry", () => {
    const publishedEntry = published({
      id: "conversation:PRRT_solo",
      path: "a.ts",
      start: 1,
      state: "open",
      author: "reviewer",
      body: "unrelated thread",
      ghThreadId: "PRRT_solo",
    });
    const pendingEntry = pending({
      id: "pending-review:PRRT_new",
      path: "b.ts",
      start: 5,
      body: "brand new reply",
      ghThreadId: "PRRT_new",
    });

    const result = deriveConversationThreadEntries(
      [publishedEntry],
      [pendingEntry],
    );

    expect(result).toEqual([publishedEntry, pendingEntry]);
  });
});

describe("projectConversationThreadRows", () => {
  it("projects author, a collapsed preview, and state for published open, published resolved, and pending entries", () => {
    const open = published({
      id: "c1",
      path: "a.ts",
      start: 1,
      state: "open",
      author: "alice",
      body: "  needs   a fix  ",
      ghThreadId: "PRRT_open",
    });
    const resolved = published({
      id: "c2",
      path: "a.ts",
      start: 2,
      state: "resolved",
      author: "bob",
      body: "looks good now",
      ghThreadId: "PRRT_resolved",
    });
    const draft = pending({
      id: "c3",
      path: "a.ts",
      start: 3,
      body: "draft reply",
      ghThreadId: "PRRT_pending",
    });

    const rows = projectConversationThreadRows(
      [open, resolved, draft],
      ["a.ts"],
    );

    expect(rows).toEqual([
      {
        id: "c1",
        path: "a.ts",
        start: 1,
        end: 1,
        side: "new",
        author: "alice",
        preview: "needs a fix",
        state: "open",
      },
      {
        id: "c2",
        path: "a.ts",
        start: 2,
        end: 2,
        side: "new",
        author: "bob",
        preview: "looks good now",
        state: "resolved",
      },
      {
        id: "c3",
        path: "a.ts",
        start: 3,
        end: 3,
        side: "new",
        author: "You",
        preview: "draft reply",
        state: "pending",
      },
    ]);
  });

  it("orders rows by the file's position in the patch, then by start ascending", () => {
    // Deliberately not alphabetical (b.ts before a.ts) and not the input's
    // published-then-pending concat order, to prove ordering follows
    // fileOrder + start rather than either of those.
    const fileOrder = ["b.ts", "a.ts"];
    const lateInFirstFile = published({
      id: "r-late",
      path: "a.ts",
      start: 10,
      state: "open",
      author: "x",
      body: "y",
      ghThreadId: "PRRT_late",
    });
    const earlyInFirstFile = published({
      id: "r-early",
      path: "a.ts",
      start: 2,
      state: "open",
      author: "x",
      body: "y",
      ghThreadId: "PRRT_early",
    });
    const secondFile = pending({
      id: "r-file",
      path: "b.ts",
      start: 100,
      body: "y",
      ghThreadId: "PRRT_file",
    });

    const rows = projectConversationThreadRows(
      [lateInFirstFile, earlyInFirstFile, secondFile],
      fileOrder,
    );

    expect(rows.map((row) => row.id)).toEqual(["r-file", "r-early", "r-late"]);
  });
});
