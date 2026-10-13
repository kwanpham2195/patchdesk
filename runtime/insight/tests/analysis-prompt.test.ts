import { describe, expect, it } from "vitest";

import * as v from "valibot";
import { composeReviewPrompt } from "#app/services/review-rubric";
import { insightEvidenceReferenceSchema } from "#app/services/insight-evidence-reference";

import { createAnalysisAgent } from "#runtime/src/patchdesk-insight-agent";

const shared = composeReviewPrompt({
  evidence: v.parse(insightEvidenceReferenceSchema, {
    identity: {
      profileId: "profile",
      reviewId: "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
      sessionId:
        "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__0123456789ab",
      runId: "insight-analysis-1-aaaaaaaaaaaa-review",
      type: "analysis",
      intentHash: null,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      patchHash: "c".repeat(64),
    },
    bundleId: "d".repeat(64),
    entryPageId: `${"d".repeat(64)}-p1`,
    directory: "/captured",
    pages: [],
    sources: [],
    manifest: { sha256: "c".repeat(64), bytes: 2 },
  }),
  language: "en",
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
    expect(systemPrompt).toContain('BCP 47 tag "en"');
    expect(systemPrompt).toContain(
      "Keep domain names in the form used by that evidence. Translate the surrounding explanation.",
    );
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
    expect(systemPrompt).toContain("EVIDENCE ENTRY:");
    expect(systemPrompt).toContain("Captured head:");
    expect(systemPrompt).not.toContain("PATCH ARTIFACT:");
  });
});
