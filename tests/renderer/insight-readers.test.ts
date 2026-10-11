// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { buildGuideInventory, retainGuide } from "#src/domain/guide";
import { parseContentHash } from "#src/domain/ids";
import { parseUnifiedPatch } from "#src/domain/patch";
import { must } from "#tests/services/insight-run-fixture";

import {
  buildInsightReaders,
  walkthroughDiscussionState,
} from "#src/renderer/src/components/insight-readers";
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

describe("Guide production composition", () => {
  it("keeps the retained old patch when the workbench advances to a distinct current patch", async () => {
    const oldPatch =
      "diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-beforeRetained()\n+retainedRecovery()\n";
    const newerPatch =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-retainedRecovery()\n+currentReplacement()\n";
    const guide = must(
      retainGuide(
        {
          groups: [
            {
              title: "Recovery",
              explanation: "Retained change.",
              files: [{ fileId: "f1", relevance: "Recovery owner." }],
            },
          ],
        },
        { patchText: oldPatch, inventory: must(buildGuideInventory(oldPatch)) },
      ),
    );
    const workbench = projection({
      fullPatch: oldPatch,
      insights: {
        ...ready.insights,
        guide: {
          status: "current",
          artifactStatus: "verified",
          retained: {
            runId: "guide-old",
            sessionId: "session-a",
            headSha: sha,
            generatedAt: "2026-08-01T00:00:00.000Z",
            freshness: "current",
            value: guide,
          },
        },
      },
    });
    const controls = {
      selectedInsight: "guide",
      walkthroughDiffAuthoring: {
        localCommentAuthoring: { enabled: true, onSave: async () => undefined },
        pendingReviewDrafts: {
          writes: [],
          updateWrites: () => undefined,
          orphanedBody: undefined,
          setOrphanedBody: () => undefined,
          fullPatch: oldPatch,
        },
        annotations: [],
        conversationActions: {},
        viewedFiles: {
          paths: new Set<string>(),
          setPaths: () => undefined,
          saveFailed: false,
        },
      },
      dismissFinding: async () => undefined,
      restoreFinding: async () => "restored",
      analysisVerification: {
        checkedSteps: new Set<number>(),
        saveFailed: false,
        setStepChecked: () => undefined,
      },
      walkthroughProgress: {
        progress: { reviewedSectionIds: [], supportReviewed: false },
        saveFailed: false,
        selectSection: () => undefined,
      },
      walkthroughFocused: false,
      setWalkthroughFocused: () => undefined,
      onRegenerateBrief: () => undefined,
      runEnabled: true,
    } satisfies Omit<
      Parameters<typeof buildInsightReaders>[0],
      "workbench" | "patchFiles"
    >;
    const view = render(
      buildInsightReaders({
        ...controls,
        workbench,
        patchFiles: parseUnifiedPatch(oldPatch),
      }),
    );
    expect(
      screen
        .getByRole("checkbox", { name: "Viewed src/a.ts" })
        .hasAttribute("disabled"),
    ).toBe(false);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "File src/a.ts" }));
    const newerWorkbench = projection({
      ...workbench,
      fullPatch: newerPatch,
      session: {
        ...workbench.session,
        key: { ...workbench.session.key, headSha: "c".repeat(40) },
      },
      revision: {
        ...workbench.revision,
        reviewedHeadSha: "c".repeat(40),
        currentHeadSha: "c".repeat(40),
        patchHash: must(parseContentHash("d".repeat(64))),
      },
      insights: {
        ...workbench.insights,
        guide: {
          ...workbench.insights.guide,
          status: "outdated",
          retained: {
            runId: "guide-old",
            sessionId: "session-a",
            headSha: sha,
            generatedAt: "2026-08-01T00:00:00.000Z",
            freshness: "outdated",
            value: guide,
          },
        },
      },
    });
    view.rerender(
      buildInsightReaders({
        ...controls,
        workbench: newerWorkbench,
        patchFiles: parseUnifiedPatch(newerPatch),
      }),
    );
    const evidence = screen.getByRole("group", {
      name: "Guide evidence src/a.ts",
    });
    expect(evidence.textContent).toContain("beforeRetained()");
    expect(evidence.textContent).toContain("retainedRecovery()");
    expect(evidence.textContent).toContain("new mode 100755");
    expect(evidence.textContent).not.toContain("currentReplacement()");
    expect(
      screen
        .getByRole("checkbox", { name: "Viewed src/a.ts" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getAllByRole("note").length).toBeGreaterThan(0);
  });
});

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
