import { describe, expect, it } from "vitest";

import {
  threadNeedsReply,
  type GitHubConversationThread,
} from "../../src/domain/github-context";

type ThreadCase = {
  readonly state: GitHubConversationThread["state"];
  readonly lastViewerDidAuthor: boolean | undefined;
  readonly expected: boolean;
};

const cases = {
  "resolved, someone else last": {
    state: "resolved",
    lastViewerDidAuthor: false,
    expected: false,
  },
  "open, viewer last": {
    state: "open",
    lastViewerDidAuthor: true,
    expected: false,
  },
  "open, someone else last": {
    state: "open",
    lastViewerDidAuthor: false,
    expected: true,
  },
  "open, viewerDidAuthor absent": {
    state: "open",
    lastViewerDidAuthor: undefined,
    expected: false,
  },
} satisfies Record<string, ThreadCase>;

describe("threadNeedsReply", () => {
  it.each(Object.entries(cases))("%s", (_name, testCase) => {
    const thread = {
      state: testCase.state,
      comments: [
        { viewerDidAuthor: true },
        { viewerDidAuthor: testCase.lastViewerDidAuthor },
      ],
    };

    expect(threadNeedsReply(thread)).toBe(testCase.expected);
  });

  it("reads only the last comment, not an earlier reply by someone else", () => {
    expect(
      threadNeedsReply({
        state: "open",
        comments: [{ viewerDidAuthor: false }, { viewerDidAuthor: true }],
      }),
    ).toBe(false);
  });
});
