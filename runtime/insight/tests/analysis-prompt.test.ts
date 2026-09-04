import { describe, expect, it } from "vitest";

import { composeReviewPrompt } from "../../../src/services/review-rubric";

import { createAnalysisAgent } from "../src/patchdesk-insight-agent";

const shared = composeReviewPrompt({
  reviewInput: "# PR review input",
  context: '{"projectReviewCriteria":[]}',
  fullPatch: "diff --git a/src/a.ts b/src/a.ts",
});

/** Inspectors that always answer, so the assertions pin the prompt alone. */
const inspectors = {
  async listChangedFiles() {
    return { files: [] };
  },
  async searchFiles() {
    return { files: [] };
  },
  async readFileRange() {
    return { denied: true as const };
  },
  async gitShow() {
    return { denied: true as const };
  },
};

function analysisSystemPrompt(): string {
  return createAnalysisAgent(
    {
      profileId: "profile",
      sessionId: "session",
      contextPath: "/immutable/context",
      reviewInputPath: "/immutable/input",
      patchPath: "/immutable/patch",
      worktreePath: "/immutable/worktree",
      model: "faux/test",
      reasoning: "low",
      prompt: shared,
    },
    inspectors,
    {
      name: "patchdesk-code-review",
      description: "Review",
      instructions: "Review safely.",
    },
  ).spec.systemPrompt;
}

describe("Pi Analysis system prompt", () => {
  it("carries the one shared Analysis prompt verbatim", () => {
    expect(analysisSystemPrompt()).toContain(shared);
  });

  it("carries the Analysis writing guidance", () => {
    const systemPrompt = analysisSystemPrompt();
    expect(systemPrompt).toContain("ASD-STE100 / Simplified Technical English");
    expect(systemPrompt).toContain("Never invent the why.");
  });

  it("defines every severity", () => {
    const systemPrompt = analysisSystemPrompt();
    expect(systemPrompt).toContain(
      "P0 is a defect that loses data, breaks security, or blocks the release.",
    );
    expect(systemPrompt).toContain(
      "P1 is a correctness defect a user will hit.",
    );
    expect(systemPrompt).toContain(
      "P2 is a defect with a workaround, or a real maintainability risk.",
    );
    expect(systemPrompt).toContain("P3 is a nit.");
  });

  it("labels each input section", () => {
    const systemPrompt = analysisSystemPrompt();
    expect(systemPrompt).toContain("REVIEW INPUT:");
    expect(systemPrompt).toContain("REVIEW CONTEXT DOCUMENT:");
    expect(systemPrompt).toContain("PATCH ARTIFACT:");
  });
});
