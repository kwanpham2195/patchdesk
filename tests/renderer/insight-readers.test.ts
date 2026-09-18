import { describe, expect, it } from "vitest";

import { walkthroughDiscussionState } from "../../src/renderer/src/components/insight-readers";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { patchHash, projection, sha } from "./review-workbench-fixtures";

const ready = projection({
  insights: {
    analysis: { status: "not_generated" },
    walkthrough: { status: "current", artifactStatus: "verified" },
  },
  conversation: {
    prDescription: "Represented description",
    entries: [],
    inline: { threads: [], complete: true },
  },
});
const snapshot = {
  profileId: "profile",
  sessionId: "session-a",
  headSha: sha,
  patchHash,
};

const withWalkthrough = (
  walkthrough: Partial<WorkbenchResponse["insights"]["walkthrough"]>,
): WorkbenchResponse => ({
  ...ready,
  insights: {
    ...ready.insights,
    walkthrough: { ...ready.insights.walkthrough, ...walkthrough },
  },
});
const withRevision = (
  revision: Partial<WorkbenchResponse["revision"]>,
): WorkbenchResponse => ({
  ...ready,
  revision: { ...ready.revision, ...revision },
});
const { fullPatch: _fullPatch, ...withoutPatch } = ready;
const { patchHash: _patchHash, ...revisionWithoutHash } = ready.revision;

describe("walkthroughDiscussionState", () => {
  it("is available when the Walkthrough matches a fresh, fully loaded revision", () => {
    expect(walkthroughDiscussionState(ready, snapshot)).toBe("available");
  });

  it.each([
    [
      "the Walkthrough is outdated",
      withWalkthrough({ status: "outdated" }),
      snapshot,
    ],
    [
      "the artifact is not verified",
      withWalkthrough({ artifactStatus: "mismatch" }),
      snapshot,
    ],
    ["the profile differs", ready, { ...snapshot, profileId: "other" }],
    ["the session differs", ready, { ...snapshot, sessionId: "session-b" }],
    ["the head differs", ready, { ...snapshot, headSha: "c".repeat(40) }],
    ["the patch differs", ready, { ...snapshot, patchHash: "d".repeat(64) }],
  ])(
    "is stale when %s, since only regenerating can fix it",
    (_, workbench, walkthroughSnapshot) => {
      expect(walkthroughDiscussionState(workbench, walkthroughSnapshot)).toBe(
        "stale",
      );
    },
  );

  it.each([
    ["the Review is not fresh", withRevision({ freshness: "not_refreshed" })],
    ["the patch is not loaded", withoutPatch],
    [
      "the patch hash is not loaded",
      { ...ready, revision: revisionWithoutHash },
    ],
    [
      "inline conversation is still loading",
      {
        ...ready,
        conversation: {
          ...ready.conversation,
          inline: { threads: [], complete: false },
        },
      },
    ],
    [
      "inline conversation is absent",
      { ...ready, conversation: { prDescription: "", entries: [] } },
    ],
  ])("is loading when %s, since Refresh can help", (_, workbench) => {
    expect(walkthroughDiscussionState(workbench, snapshot)).toBe("loading");
  });

  it("reports stale over loading when both hold, since Refresh alone cannot fix it", () => {
    expect(
      walkthroughDiscussionState(
        {
          ...withWalkthrough({ status: "outdated" }),
          revision: { ...ready.revision, freshness: "not_refreshed" },
        },
        snapshot,
      ),
    ).toBe("stale");
  });
});
