// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewWorkbench } from "../../src/renderer/src/components/review-workbench";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("review workbench", () => {
  it("keeps Fix queue statuses local to the reviewed revision", async () => {
    const user = userEvent.setup();
    render(
      <ReviewWorkbench
        profileId="fix-queue"
        reviewedHeadSha="abcdef"
        result={{ changeSummary: "Fix queue.", verdict: "comment", summary: "Fix queue.", findings: [{ id: "guard", severity: "P1", title: "Protect guard", file: "src/a.ts", lineStart: 1, diffSide: "new", explanation: "Protect it.", confidence: "high", mappingStatus: "mapped" }], validationPlan: [], assumptions: [] } as never}
        draft={{ summaryBody: "", comments: [] }} comments={{ threads: [] }} checks={{ overall: "unknown", checks: [] }} history={[]} debugHref="/debug"
      />,
    );
    await user.click(screen.getByLabelText("Fix queue status for Protect guard"));
    await user.click(screen.getByRole("option", { name: "Investigating" }));
    expect(window.localStorage.getItem("patchdesk.fix-queue.v1.fix-queue.abcdef")).toContain('"guard":"investigating"');
  });

  it("persists compact Pierre controls and collapses both workbench rails", async () => {
    const user = userEvent.setup();
    render(
      <ReviewWorkbench
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
      <ReviewWorkbench
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

    await user.click(screen.getByRole("tab", { name: /Findings/ }));
    await user.click(screen.getByRole("button", { name: /Mapped finding/ }));
    expect(
      screen.getByLabelText("Review diff").getAttribute("data-selected-path"),
    ).toBe("src/workbench.ts");
    expect(screen.getByText("Finding mapped · new lines 7–8")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Accessible diff" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Accessible text view" }),
    );
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

  it("opens incremental reviews on Updates and preserves the full PR surface", async () => {
    const user = userEvent.setup();
    render(
      <ReviewWorkbench
        reviewScope={{ kind: "incremental", baseSessionId: "base" as never, baseHeadSha: "a".repeat(40) as never, headSha: "b".repeat(40) as never, comparisonPatchPath: "/tmp/comparison.diff" as never, comparisonMetadataPath: "/tmp/comparison.json" as never, previousFindingsPath: "/tmp/previous.json" as never, lifecyclePath: "/tmp/lifecycle.json" as never }}
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
    expect(screen.getAllByText("src/updates.ts").length).toBeGreaterThan(0);
    expect(screen.getByText("Prior guard")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Full PR" }));
    expect(screen.getAllByText("src/full.ts").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("tab", { name: "Updates" }));
    expect(screen.getAllByText("src/updates.ts").length).toBeGreaterThan(0);
  });

  it("keeps unmapped findings visible and exposes only read-only review context", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    render(
      <ReviewWorkbench
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

    await user.click(screen.getByRole("tab", { name: /Findings/ }));
    expect(screen.getByText("Unmapped — not postable")).toBeTruthy();
    expect(screen.getByText("Existing review comment")).toBeTruthy();
    expect(screen.getByText("unit")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Attempt 002: Discarded")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /resolve|reply|apply/i }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Copy validation plan" }),
    );
    expect(screen.getByText("Validation plan copied locally.")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Attempt 002: Discarded" }),
    );
    expect(screen.getByText("Viewing attempt 002 metadata.")).toBeTruthy();
  });

  it("shows a stale-head warning instead of a GitHub write control", () => {
    render(
      <ReviewWorkbench
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
