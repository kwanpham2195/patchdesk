import { describe, expect, it } from "vitest";

import { renderAnalysisReviewBody, renderAnalysisReviewSummary } from "../../src/services/analysis-review-body";
import type { ReviewResult } from "../../src/domain/review-result";

const result: ReviewResult = {
  changeSummary: "Adds `safe` parsing",
  verdict: "request_changes",
  summary: "The change needs review.",
  findings: [
    { id: "p2" as never, severity: "P2", title: "Second", explanation: "Explain *this*.", confidence: "high", mappingStatus: "mapped", file: "src/b.ts" as never, lineStart: 4 },
    { id: "p0" as never, severity: "P0", title: "First", explanation: "Fix [this].", confidence: "high", mappingStatus: "unmapped" },
  ],
  validationPlan: ["Run `pnpm test`"],
  assumptions: ["The provider is available."],
  unresolvedItems: ["Confirm rollout."],
  callouts: [{ category: "configuration", title: "Config", detail: "Check `CONFIG`." }],
};

describe("renderAnalysisReviewBody", () => {
  it("renders the specified stable section order and escapes model text", () => {
    const body = renderAnalysisReviewBody({
      result,
      scope: {
        baseShort: "base",
        headShort: "head",
        commitCount: 2,
        fileCount: 2,
        additions: 4,
        deletions: 1,
        changedFiles: [{ path: "src/a.ts", additions: 3, deletions: 0 }, { path: "src/b.ts", additions: 1, deletions: 1 }],
      },
    });
    expect(body.indexOf("# Review Scope")).toBeLessThan(body.indexOf("# Pull Request Overview"));
    expect(body.indexOf("# Pull Request Overview")).toBeLessThan(body.indexOf("# Reviewed Changes"));
    expect(body.indexOf("# Reviewed Changes")).toBeLessThan(body.indexOf("# Verification"));
    expect(body.indexOf("# Verification")).toBeLessThan(body.indexOf("# Findings"));
    expect(body.indexOf("# Findings")).toBeLessThan(body.indexOf("# Verdict"));
    expect(body.indexOf("# Verdict")).toBeLessThan(body.indexOf("# Human Reviewer Callouts"));
    expect(body).toContain("**P0** First: Fix \\[this\\].");
    expect(body).toContain("- **P2** Second (`src/b.ts`:4): Explain \\*this\\*.");
    expect(body).not.toContain("mappingStatus");
  });

  it("omits optional sections when their inputs are empty", () => {
    const body = renderAnalysisReviewBody({
      result: { ...result, findings: [], validationPlan: [], assumptions: [], unresolvedItems: [], callouts: [] },
      scope: { baseShort: "base", headShort: "head", commitCount: 1, fileCount: 0, additions: 0, deletions: 0, changedFiles: [] },
    });
    expect(body).not.toContain("# Verification");
    expect(body).not.toContain("# Human Reviewer Callouts");
    expect(body).toContain("No changed files were reported.");
    expect(body).toContain("No findings.");
  });
});

describe("renderAnalysisReviewSummary", () => {
  it("keeps high-level context while omitting every Finding", () => {
    const body = renderAnalysisReviewSummary({
      result,
      scope: { baseShort: "base", headShort: "head", commitCount: 2, fileCount: 2, additions: 4, deletions: 1, changedFiles: [] },
    });
    expect(body).toContain("# Review Scope");
    expect(body).toContain("# Verdict");
    expect(body).not.toContain("# Findings");
    expect(body).not.toContain("Second");
    expect(body).not.toContain("First");
  });
});
