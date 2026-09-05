import { describe, expect, it } from "vitest";

import { renderAnalysisFixPrompt } from "../../src/renderer/src/analysis-fix-prompt";
import { parseFindingId, parseRepoRelativePath } from "../../src/domain/ids";
import type { ReviewResult } from "../../src/domain/review-result";
import type { Result } from "../../src/domain/result";

function requireParsed<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("invalid test fixture");
  return result.value;
}

const findingP2 = requireParsed(parseFindingId("p2"));
const findingP0 = requireParsed(parseFindingId("p0"));
const findingP1 = requireParsed(parseFindingId("p1"));
const fileA = requireParsed(parseRepoRelativePath("src/a.ts"));
const fileB = requireParsed(parseRepoRelativePath("src/b.ts"));

const context = {
  owner: "acme",
  repo: "patchdesk",
  number: 42,
  headBranch: "feat/fix_prompt",
  baseBranch: "main",
};

const result: ReviewResult = {
  changeSummary: "Adds parse_input and a *new* flag.",
  verdict: "request_changes",
  summary: "The change needs review.",
  findings: [
    {
      id: findingP2,
      severity: "P2",
      title: "Second",
      explanation: "Rename to_snake_case here.",
      confidence: "high",
      mappingStatus: "mapped",
      file: fileB,
      lineStart: 4,
    },
    {
      id: findingP0,
      severity: "P0",
      title: "First",
      explanation: "The guard is inverted.",
      confidence: "high",
      mappingStatus: "mapped",
      file: fileA,
      lineStart: 12,
      lineEnd: 20,
      category: "bug",
      whyItMatters: "Users lose data.",
      affectedScenario: "Submitting an empty form.",
      suggestedChange: "Flip the condition.",
    },
  ],
  validationPlan: ["Run pnpm test", "Click submit"],
  assumptions: [],
};

describe("renderAnalysisFixPrompt", () => {
  it("renders the whole prompt with raw, unescaped model text", () => {
    expect(renderAnalysisFixPrompt({ context, result }))
      .toBe(`# Fix review findings

You are working in the repository acme/patchdesk, on branch \`feat/fix_prompt\` (pull request #42 targeting \`main\`).

A code review produced the findings below. Fix each one in the codebase. For each finding: read the referenced file and lines, make the smallest correct change, and add or update a test when the finding is a bug. Do not change unrelated code. When you finish, list what you changed per finding and anything you deliberately left alone with the reason.

## Change summary

Adds parse_input and a *new* flag.

## Findings

### 1. [P0] First

- File: \`src/a.ts:12-20\`
- Category: bug
- Why it matters: Users lose data.
- Affected scenario: Submitting an empty form.

The guard is inverted.

Suggested change: Flip the condition.

### 2. [P2] Second

- File: \`src/b.ts:4\`

Rename to_snake_case here.

## Verify

- [ ] Run pnpm test
- [ ] Click submit`);
  });

  it("orders findings by severity and keeps original order within one severity", () => {
    const prompt = renderAnalysisFixPrompt({
      context,
      result: {
        ...result,
        findings: [
          {
            id: findingP2,
            severity: "P2",
            title: "Low",
            explanation: "Low detail.",
            confidence: "low",
            mappingStatus: "mapped",
          },
          {
            id: findingP1,
            severity: "P1",
            title: "Middle one",
            explanation: "Middle detail.",
            confidence: "low",
            mappingStatus: "mapped",
          },
          {
            id: findingP0,
            severity: "P0",
            title: "Top",
            explanation: "Top detail.",
            confidence: "low",
            mappingStatus: "mapped",
          },
        ],
      },
    });
    expect(prompt).toContain("### 1. [P0] Top");
    expect(prompt).toContain("### 2. [P1] Middle one");
    expect(prompt).toContain("### 3. [P2] Low");
  });

  it("omits every optional finding field that is absent", () => {
    const prompt = renderAnalysisFixPrompt({
      context,
      result: {
        ...result,
        findings: [
          {
            id: findingP0,
            severity: "P0",
            title: "Bare",
            explanation: "Only an explanation.",
            confidence: "low",
            mappingStatus: "unmapped",
          },
        ],
        validationPlan: [],
      },
    });
    expect(prompt).toContain("### 1. [P0] Bare\n\nOnly an explanation.");
    expect(prompt).not.toContain("- File:");
    expect(prompt).not.toContain("- Category:");
    expect(prompt).not.toContain("- Why it matters:");
    expect(prompt).not.toContain("- Affected scenario:");
    expect(prompt).not.toContain("Suggested change:");
    expect(prompt).not.toContain("## Verify");
  });

  it("excludes findings dismissed by disposition and by id", () => {
    const prompt = renderAnalysisFixPrompt({
      context,
      result: {
        ...result,
        findings: [
          {
            id: findingP0,
            severity: "P0",
            title: "Dismissed by disposition",
            explanation: "Gone.",
            confidence: "low",
            mappingStatus: "mapped",
            disposition: "dismissed",
          },
          {
            id: findingP1,
            severity: "P1",
            title: "Dismissed by id",
            explanation: "Also gone.",
            confidence: "low",
            mappingStatus: "mapped",
            disposition: "open",
          },
          {
            id: findingP2,
            severity: "P2",
            title: "Kept",
            explanation: "Still here.",
            confidence: "low",
            mappingStatus: "mapped",
          },
        ],
      },
      dismissedFindingIds: new Set([findingP1]),
    });
    expect(prompt).not.toContain("Dismissed by disposition");
    expect(prompt).not.toContain("Dismissed by id");
    expect(prompt).toContain("### 1. [P2] Kept");
  });

  it("says there are no open findings when every finding is dismissed", () => {
    const prompt = renderAnalysisFixPrompt({
      result: { ...result, findings: [], validationPlan: [] },
    });
    expect(prompt).toContain("## Findings\n\nNo open findings.");
  });

  it("drops the repository details when no context is given", () => {
    const prompt = renderAnalysisFixPrompt({ result });
    expect(prompt).toContain(
      "You are working in the repository that this review was produced for.",
    );
    expect(prompt).not.toContain("pull request #");
  });
});
