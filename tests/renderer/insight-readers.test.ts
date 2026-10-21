// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildGuideInventory, retainGuide } from "#src/domain/guide";
import { must } from "#tests/services/insight-run-fixture";

import { walkthroughDiscussionState } from "#src/renderer/src/components/insight-readers";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import { patchHash, projection, sha } from "./review-workbench-fixtures";
import { guideReviewDisabledReason } from "#src/renderer/src/components/guide-review-controls";

afterEach(cleanup);

const ready = projection({
  insights: {
    guide: { status: "not_generated" },
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

describe("Guide revision eligibility", () => {
  const patch = ready.fullPatch ?? "";
  const guide = must(
    retainGuide(
      {
        groups: [
          {
            title: "Review",
            explanation: "Current change.",
            files: [{ fileId: "f1", relevance: "Changed file." }],
          },
        ],
      },
      { patchText: patch, inventory: must(buildGuideInventory(patch)) },
    ),
  );
  const retained = {
    runId: "guide",
    sessionId: ready.session.id,
    headSha: ready.revision.reviewedHeadSha,
    generatedAt: "2026-10-08T00:00:00.000Z",
    freshness: "current" as const,
    value: guide,
  };
  const current: WorkbenchResponse = {
    ...ready,
    insights: {
      ...ready.insights,
      guide: { status: "current", artifactStatus: "verified", retained },
    },
  };
  it("allows current evidence during a replacement run", () => {
    expect(
      guideReviewDisabledReason({
        ...current,
        insights: {
          ...current.insights,
          guide: { ...current.insights.guide, status: "running" },
        },
      }),
    ).toBeUndefined();
  });
  it.each([
    [
      "retained freshness",
      {
        ...current,
        insights: {
          ...current.insights,
          guide: {
            ...current.insights.guide,
            retained: { ...retained, freshness: "outdated" as const },
          },
        },
      },
    ],
    [
      "session identity",
      {
        ...current,
        insights: {
          ...current.insights,
          guide: {
            ...current.insights.guide,
            retained: { ...retained, sessionId: "older-session" },
          },
        },
      },
    ],
    [
      "head identity",
      {
        ...current,
        insights: {
          ...current.insights,
          guide: {
            ...current.insights.guide,
            retained: { ...retained, headSha: "c".repeat(40) },
          },
        },
      },
    ],
    ["snapshot identity", { ...current, fullPatch: patch + "\n" }],
    [
      "artifact verification",
      {
        ...current,
        insights: {
          ...current.insights,
          guide: {
            ...current.insights.guide,
            artifactStatus: "mismatch" as const,
          },
        },
      },
    ],
    [
      "terminal Review",
      { ...current, review: { ...current.review, status: "merged" as const } },
    ],
    [
      "GitHub freshness",
      {
        ...current,
        revision: {
          ...current.revision,
          freshness: "updates_available" as const,
        },
      },
    ],
  ])(
    "refuses actions when %s differs even with injected workbench controls",
    (_, workbench) => {
      expect(guideReviewDisabledReason(workbench)).toBeDefined();
    },
  );
  it("preserves the session-only local note gate when remote freshness is unavailable", () => {
    expect(
      guideReviewDisabledReason({
        ...current,
        session: {
          ...current.session,
          key: {
            ...current.session.key,
            source: {
              kind: "local_branch",
              branch: "fixture",
              baseRef: "main",
            },
          },
        },
        revision: { ...current.revision, freshness: "not_refreshed" },
      }),
    ).toBeUndefined();
  });
});

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
