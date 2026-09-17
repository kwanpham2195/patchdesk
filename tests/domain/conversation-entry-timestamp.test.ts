import { describe, expect, it } from "vitest";

import {
  conversationEntryTimestamp,
  isNewSinceLastLooked,
  newestConversationTimestamp,
} from "../../src/domain/conversation-entry-timestamp";

const early = "2026-09-01T10:00:00.000Z";
const late = "2026-09-02T10:00:00.000Z";

const entries = {
  PrDescription: { entry: { _tag: "PrDescription" }, expected: undefined },
  IssueComment: {
    entry: { _tag: "IssueComment", comment: { createdAt: early } },
    expected: early,
  },
  ReviewComment: {
    entry: { _tag: "ReviewComment", comment: { createdAt: early } },
    expected: early,
  },
  ReviewSummary: {
    entry: { _tag: "ReviewSummary", review: { submittedAt: late } },
    expected: late,
  },
  GeneralThread: {
    entry: {
      _tag: "GeneralThread",
      thread: { comments: [{ createdAt: late }, { createdAt: early }] },
    },
    expected: late,
  },
} as const satisfies Record<
  Parameters<typeof conversationEntryTimestamp>[0]["_tag"],
  {
    readonly entry: Parameters<typeof conversationEntryTimestamp>[0];
    readonly expected: string | undefined;
  }
>;

describe("conversationEntryTimestamp", () => {
  it.each(Object.entries(entries))(
    "dates a %s entry",
    (_tag, { entry, expected }) => {
      expect(conversationEntryTimestamp(entry)).toBe(expected);
    },
  );

  it("finds the newest entry time, and none for an undated Conversation", () => {
    expect(
      newestConversationTimestamp(
        Object.values(entries).map(({ entry }) => entry),
      ),
    ).toBe(late);
    expect(
      newestConversationTimestamp([entries.PrDescription.entry]),
    ).toBeUndefined();
  });

  it("counts an entry new only when it is later than the cursor, and nothing before the first leave", () => {
    expect(isNewSinceLastLooked(late, { seenThrough: early })).toBe(true);
    expect(isNewSinceLastLooked(early, { seenThrough: early })).toBe(false);
    expect(isNewSinceLastLooked(early, {})).toBe(true);
    expect(isNewSinceLastLooked(undefined, {})).toBe(false);
    expect(isNewSinceLastLooked(late, undefined)).toBe(false);
  });
});
