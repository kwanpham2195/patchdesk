// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs/react", () => ({
  PatchDiff: ({ patch }: { readonly patch: string }) => <div data-pierre-mock="true" data-patch={patch} />,
}));

import { CompletedReviewWorkbench } from "../../src/renderer/src/components/completed-review-workbench";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** Keeps older fixture literals terse while exercising the real compact boundary. */
function ReviewWorkbenchFixture(props: {
  readonly result: never;
  readonly [key: string]: unknown;
}): React.JSX.Element {
  const profileId = typeof props.profileId === "string" ? props.profileId : "fixture";
  const source = props.sourceSession as { readonly profileId: string; readonly sessionId: string } | undefined;
  const modelSource = source ?? { profileId, sessionId: "fixture-session" };
  return (
    <CompletedReviewWorkbench
      model={{
        source: modelSource,
        result: props.result,
        reviewScope: (props.reviewScope ?? { kind: "full" }) as never,
        ...(typeof props.fullPatch === "string" ? { fullPatch: props.fullPatch } : {}),
        ...(typeof props.comparisonPatch === "string" ? { comparisonPatch: props.comparisonPatch } : {}),
        ...(props.comparison === undefined ? {} : { comparison: props.comparison as never }),
        ...(props.lifecycle === undefined ? {} : { lifecycle: props.lifecycle as never }),
        comparisonAvailability: (props.comparisonAvailability ?? "not_requested") as never,
        ...(props.pullRequest === undefined ? {} : { pullRequest: props.pullRequest as never }),
        reviewedHeadSha: (props.reviewedHeadSha ?? "a".repeat(40)) as never,
        ...(props.currentHeadSha === undefined ? {} : { currentHeadSha: props.currentHeadSha as never }),
        freshness: (props.staleHead === true ? "stale" : props.freshness ?? "fresh") as never,
        refreshedAt: "2026-07-18T00:00:00.000Z" as never,
        comments: (props.comments ?? { threads: [] }) as never,
        checks: (props.checks ?? { overall: "unknown", checks: [] }) as never,
      }}
      actions={{
        reportNavigationState: () => undefined,
        ...(props.walkthrough === undefined ? {} : { walkthrough: props.walkthrough as never }),
      }}
    />
  );
}

describe("completed review workbench", () => {
  it("shows truthful finding counts without a duplicate local queue", () => {
    const legacyQueueKey = "patchdesk.fix-queue.v1.findings.abcdef";
    window.localStorage.setItem(legacyQueueKey, '{"guard":"investigating"}');
    render(
      <ReviewWorkbenchFixture
        profileId="findings"
        reviewedHeadSha="abcdef"
        result={{ changeSummary: "Findings.", verdict: "comment", summary: "Findings.", findings: [{ id: "guard", severity: "P1", title: "Protect guard", file: "src/a.ts", lineStart: 1, diffSide: "new", explanation: "Protect it.", confidence: "high", mappingStatus: "mapped" }, { id: "manual", severity: "P2", title: "Inspect manual placement", explanation: "No verified line.", confidence: "medium", mappingStatus: "unmapped" }], validationPlan: [], assumptions: [] } as never}
        draft={{ summaryBody: "", comments: [] }} comments={{ threads: [] }} checks={{ overall: "unknown", checks: [] }} history={[]} debugHref="/debug"
      />,
    );
    expect(screen.getByText("2 findings · 1 mapped")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Fix queue" })).toBeNull();
    expect(screen.queryByLabelText("Fix queue status for Protect guard")).toBeNull();
    expect(window.localStorage.getItem(legacyQueueKey)).toBe('{"guard":"investigating"}');
  });

  it("persists compact Pierre controls and collapses both workbench rails", async () => {
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFixture
        profileId="compact-controls"
        result={
          {
            changeSummary: "Compact review controls.",
            verdict: "comment",
            summary: "Review preferences.",
            findings: [],
            validationPlan: [],
            assumptions: [],
          } as never
        }
        fullPatch={
          "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"
        }
        draft={{ summaryBody: "", comments: [] }}
        comments={{ threads: [] }}
        checks={{ overall: "unknown", checks: [] }}
        history={[]}
        debugHref="/debug"
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Unified" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "All files" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "Split" }));
    await user.click(screen.getByRole("button", { name: "Wrap" }));
    await user.click(
      screen.getByRole("button", { name: "Hide review navigator" }),
    );
    await user.click(screen.getByRole("button", { name: "Hide details" }));

    expect(
      screen.getByLabelText("Review diff").getAttribute("data-diff-style"),
    ).toBe("split");
    expect(screen.queryByLabelText("Review navigation")).toBeNull();
    expect(screen.queryByLabelText("Review result and actions")).toBeNull();
    expect(
      window.localStorage.getItem("patchdesk.review-view.v1.compact-controls"),
    ).toContain('"diffStyle":"split"');
    expect(
      window.localStorage.getItem("patchdesk.review-view.v1.compact-controls"),
    ).toContain('"overflow":"wrap"');
  });

  it("opens exact finding evidence and supports finding and panel navigation", async () => {
    const user = userEvent.setup();
    const patch = [
      "diff --git a/src/workbench.ts b/src/workbench.ts",
      "--- a/src/workbench.ts",
      "+++ b/src/workbench.ts",
      "@@ -6,3 +6,4 @@",
      " context",
      "+first finding line",
      "+second finding line",
      " context",
    ].join("\n");
    render(
      <ReviewWorkbenchFixture
        result={
          {
            changeSummary: "Review exact evidence.",
            verdict: "comment",
            summary: "Two findings.",
            findings: [
              {
                id: "mapped",
                severity: "P1",
                title: "Mapped finding",
                file: "src/workbench.ts",
                lineStart: 7,
                lineEnd: 8,
                diffSide: "new",
                explanation: "Mapped.",
                confidence: "high",
                mappingStatus: "mapped",
              },
              {
                id: "unmapped",
                severity: "P2",
                title: "Unmapped finding",
                explanation: "No line.",
                confidence: "medium",
                mappingStatus: "unmapped",
              },
            ],
            validationPlan: [],
            assumptions: [],
          } as never
        }
        fullPatch={patch}
        draft={{ summaryBody: "", comments: [] }}
        comments={{ threads: [] }}
        checks={{ overall: "unknown", checks: [] }}
        history={[]}
        debugHref="/debug"
      />,
    );

    await user.click(screen.getByRole("button", { name: /Mapped finding/ }));
    expect(
      screen.getByLabelText("Review diff").getAttribute("data-selected-path"),
    ).toBe("src/workbench.ts");
    expect(screen.getByText("Finding mapped · new lines 7–8")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Accessible diff" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Options" })).toBeNull();
    expect(
      document.querySelectorAll('[data-selected-line="true"]'),
    ).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Next finding" }));
    expect(screen.getByText("Finding unmapped · no mapped line")).toBeTruthy();
    expect(
      document.querySelectorAll('[data-selected-line="true"]'),
    ).toHaveLength(0);
    expect(
      screen
        .getByRole("button", { name: /Unmapped finding/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "Hide details" }));
    expect(screen.queryByLabelText("Review result and actions")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByLabelText("Review result and actions")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Previous finding" }));
    expect(screen.getByText("Finding mapped · new lines 7–8")).toBeTruthy();
  });

  it("shows every finding without filter controls", async () => {
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFixture
        result={{
          changeSummary: "All findings.",
          verdict: "comment",
          summary: "One finding per severity.",
          findings: [
            { id: "p1", severity: "P1", title: "High finding", explanation: "High.", confidence: "high", mappingStatus: "unmapped" },
            { id: "p2", severity: "P2", title: "Medium finding", explanation: "Medium.", confidence: "medium", mappingStatus: "unmapped" },
          ],
          validationPlan: [],
          assumptions: [],
        } as never}
        comments={{ threads: [] }}
        checks={{ overall: "unknown", checks: [] }}
        history={[]}
      />,
    );
    expect(screen.queryByLabelText("Filter findings by severity")).toBeNull();
    expect(screen.queryByLabelText("Filter findings by confidence")).toBeNull();
    expect(screen.queryByLabelText("Filter findings by evidence mapping")).toBeNull();
    expect(screen.queryByLabelText("Filter findings by category")).toBeNull();
    expect(screen.getByRole("button", { name: /High finding/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Medium finding/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /High finding/ }));
    await user.click(screen.getByRole("button", { name: "Next finding" }));
    expect(screen.getByText("Finding p2 · no mapped line")).toBeTruthy();
  });

  it("opens incremental reviews on Updates and preserves the full PR surface", async () => {
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFixture
        reviewScope={{ kind: "incremental", baseSessionId: "base" as never, baseHeadSha: "a".repeat(40) as never, headSha: "b".repeat(40) as never }}
        comparisonAvailability="available"
        comparison={{ schemaVersion: 1, baseSessionId: "base" as never, baseHeadSha: "a".repeat(40) as never, headSha: "b".repeat(40) as never, ancestry: "fast_forward", source: "local_git", completeness: "complete", commits: [], files: [], additions: 1, deletions: 0, createdAt: "2026-07-18T00:00:00.000Z" as never }}
        comparisonPatch={"diff --git a/src/updates.ts b/src/updates.ts\n--- a/src/updates.ts\n+++ b/src/updates.ts\n@@ -1 +1 @@\n-old\n+update\n"}
        fullPatch={"diff --git a/src/full.ts b/src/full.ts\n--- a/src/full.ts\n+++ b/src/full.ts\n@@ -1 +1 @@\n-old\n+full\n"}
        lifecycle={[{ status: "resolved", severity: "P1", title: "Prior guard", explanation: "Fixed.", evidence: "comparison_patch", draftPostability: "not_applicable" }]}
        result={{ changeSummary: "Incremental update", verdict: "comment", summary: "Update review.", findings: [], validationPlan: [], assumptions: [] } as never}
        draft={{ summaryBody: "", comments: [] }}
        comments={{ threads: [] }}
        checks={{ overall: "unknown", checks: [] }}
        history={[]}
        debugHref="/debug"
      />,
    );
    expect(screen.getByLabelText("Review diff").getAttribute("data-selected-path")).toBe("src/updates.ts");
    expect(screen.getByText("Prior guard")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Full PR" }));
    expect(screen.getByLabelText("Review diff").getAttribute("data-selected-path")).toBe("src/full.ts");
    await user.click(screen.getByRole("tab", { name: "Updates" }));
    expect(screen.getByLabelText("Review diff").getAttribute("data-selected-path")).toBe("src/updates.ts");
  });

  it("keeps unmapped findings visible and exposes only read-only review context", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    render(
      <ReviewWorkbenchFixture
        result={
          {
            changeSummary: "Adds the completed-review workbench.",
            verdict: "comment",
            summary: "A mapped finding needs a comment.",
            findings: [
              {
                id: "mapped",
                severity: "P1",
                title: "Mapped finding",
                file: "src/workbench.ts",
                lineStart: 7,
                diffSide: "new",
                explanation: "Use a safe path.",
                suggestedComment: "Use a safe path.",
                confidence: "high",
                mappingStatus: "mapped",
              },
              {
                id: "unmapped",
                severity: "P2",
                title: "Unmapped finding",
                explanation: "This cannot be placed.",
                confidence: "medium",
                mappingStatus: "unmapped",
              },
            ],
            validationPlan: ["pnpm test"],
            assumptions: ["The fixture is current."],
          } as never
        }
        draft={{
          summaryBody: "A mapped finding needs a comment.",
          comments: [
            {
              findingId: "mapped",
              body: "Use a safe path.",
              postability: "postable",
            },
          ],
        }}
        comments={{
          threads: [
            {
              id: "thread-1",
              state: "open",
              comments: [
                {
                  id: "comment-1",
                  author: "reviewer",
                  body: "Existing review comment",
                  createdAt: "2026-07-16T00:00:00.000Z" as never,
                  location: { path: "src/workbench.ts" as never, line: 7 },
                },
              ],
            },
          ],
        }}
        checks={{
          overall: "failing",
          checks: [
            {
              name: "unit",
              required: true,
              status: "completed",
              conclusion: "failure",
              url: "https://example.test/check",
            },
          ],
        }}
        history={[
          { id: "001", state: "ReviewCompleted" },
          { id: "002", state: "Discarded" },
        ]}
        debugHref="/debug/session"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unmapped finding" }));
    expect(screen.getByText("Unmapped evidence — inspect before drafting a comment")).toBeTruthy();
    expect(screen.getByText("Existing review comment")).toBeTruthy();
    expect(screen.getByText("unit")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText("Attempt 002: Discarded")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /resolve|reply|apply/i }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Copy validation plan" }),
    );
    expect(screen.getByText("Validation plan copied locally.")).toBeTruthy();
  });

  it("opens the chapter-rail takeover without changing Files state and restores focus", async () => {
    const user = userEvent.setup();
    const onSelectSection = vi.fn();
    const walkthrough = {
      projection: {
        lifecycle: "ready",
        noticeKey: "walkthrough-ready",
        walkthrough: {
          snapshot: {
            profileId: "fixture",
            sessionId: "fixture-session",
            headSha: "a".repeat(40),
            patchHash: "b".repeat(64),
          },
          title: "Read-only walkthrough",
          focus: "Recovery flow",
          chapters: [
            {
              id: "chapter-1",
              title: "Context",
              sections: [
                {
                  id: "section-1",
                  title: "Why this snapshot matters",
                  prose: "The stored patch remains readable.",
                  hunkIds: ["h1"],
                  hunks: [{ id: "h1", path: "src/a.ts", header: "@@ -1 +1 @@", raw: "@@ -1 +1 @@\\n-old\\n+new", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
                },
                {
                  id: "section-2",
                  title: "How reads stay read-only",
                  prose: "The walkthrough does not start a review run.",
                  hunkIds: ["h2"],
                  hunks: [{ id: "h2", path: "src/b.ts", header: "@@ -2 +2 @@", raw: "@@ -2 +2 @@\\n-old\\n+new", oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }],
                },
              ],
            },
          ],
          support: {
            id: "support",
            title: "Support",
            hunkIds: ["h3"],
            hunks: [{ id: "h3", path: "src/c.ts", header: "@@ -3 +3 @@", raw: "@@ -3 +3 @@\\n-old\\n+new", oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }],
          },
        },
      },
      dialogOpen: false,
      models: [{ id: "pi-design", label: "Design model" }],
      model: "pi-design",
      reasoning: "medium",
      catalogUnavailable: false,
      onOpenDialog: vi.fn(),
      onCloseDialog: vi.fn(),
      onModelChange: vi.fn(),
      onReasoningChange: vi.fn(),
      onConfirm: vi.fn(),
      onRetry: vi.fn(),
      onRegenerate: vi.fn(),
      busy: false,
      onSelectSection,
      onMarkSectionReviewed: vi.fn(),
      onMarkSupportReviewed: vi.fn(),
      onOpenTakeover: vi.fn(),
      onCloseTakeover: vi.fn(),
    } as never;
    render(
      <ReviewWorkbenchFixture
        result={{ changeSummary: "Walkthrough", verdict: "comment", summary: "Summary", findings: [], validationPlan: [], assumptions: [] } as never}
        fullPatch={"diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -2 +2 @@\n-old\n+new\ndiff --git a/src/c.ts b/src/c.ts\n--- a/src/c.ts\n+++ b/src/c.ts\n@@ -3 +3 @@\n-old\n+new\n"}
        draft={{ summaryBody: "", comments: [] }}
        comments={{ threads: [] }}
        checks={{ overall: "unknown", checks: [] }}
        history={[]}
        debugHref="/debug"
        walkthrough={walkthrough}
      />,
    );
    const open = screen.getByRole("button", { name: "Open walkthrough" });
    await user.click(open);
    expect(screen.getByTestId("back-to-files")).toBeTruthy();
    expect(screen.queryByLabelText("Review diff")).toBeNull();
    const preferencesBefore = window.localStorage.getItem("patchdesk.review-view.v1.fixture");
    await user.click(screen.getByRole("button", { name: "Split" }));
    await user.click(screen.getByRole("button", { name: "Wrap" }));
    expect(window.localStorage.getItem("patchdesk.review-view.v1.fixture")).toBe(preferencesBefore);
    await user.click(screen.getByRole("button", { name: "Next section" }));
    expect(onSelectSection).toHaveBeenCalledWith("section-2");
    await user.click(screen.getByRole("button", { name: "Back to files" }));
    expect(screen.queryByTestId("back-to-files")).toBeNull();
    expect(screen.getByRole("button", { name: "Open walkthrough" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open walkthrough" }));
  });

  it("shows a stale-head warning instead of a GitHub write control", () => {
    render(
      <ReviewWorkbenchFixture
        result={
          {
            changeSummary: "",
            verdict: "approve",
            summary: "",
            findings: [],
            validationPlan: [],
            assumptions: [],
          } as never
        }
        draft={{ summaryBody: "", comments: [] }}
        comments={{ threads: [] }}
        checks={{ overall: "unknown", checks: [] }}
        history={[]}
        debugHref="/debug"
        staleHead
      />,
    );
    expect(
      screen.getByText(
        "GitHub posting is blocked because this review head is stale.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /create pending review|submit pending review|confirm merge/i,
      }),
    ).toBeNull();
  });
});
