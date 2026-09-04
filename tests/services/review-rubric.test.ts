import { describe, expect, it } from "vitest";
import { composeReviewPrompt } from "../../src/services/review-rubric";

const prompt = composeReviewPrompt({
  reviewInput: "# PR review input",
  context: '{"projectReviewCriteria":[]}',
  fullPatch: "patch",
});

describe("review rubric", () => {
  it("uses the complete patch", () => expect(prompt).toContain("patch"));

  it("carries the Analysis writing guidance", () => {
    expect(prompt).toContain("ASD-STE100 / Simplified Technical English");
    expect(prompt).toContain("Never invent the why.");
    expect(prompt).toContain(
      "Keep facts, assumptions, and unresolved questions separate.",
    );
  });

  it("defines every severity and ties P0 and P1 to the merge block", () => {
    expect(prompt).toContain(
      "P0 is a defect that loses data, breaks security, or blocks the release.",
    );
    expect(prompt).toContain("P1 is a correctness defect a user will hit.");
    expect(prompt).toContain(
      "P2 is a defect with a workaround, or a real maintainability risk.",
    );
    expect(prompt).toContain("P3 is a nit.");
    expect(prompt).toContain(
      "P0 and P1 are the findings that block a merge. P2 and P3 do not block a merge",
    );
  });

  it("makes the repository rule files criteria the model must cite", () => {
    expect(prompt).toContain(
      "Apply them as review criteria, not as background reading.",
    );
    expect(prompt).toContain(
      "Name the rule you applied in the finding's explanation",
    );
  });

  it("labels each input section", () => {
    expect(prompt).toContain("REVIEW INPUT:\n\n# PR review input");
    expect(prompt).toContain(
      'REVIEW CONTEXT DOCUMENT:\n\n{"projectReviewCriteria":[]}',
    );
    expect(prompt).toContain("PATCH ARTIFACT:\n\npatch");
  });

  it("owns the description-versus-patch check at P2", () => {
    expect(prompt).toContain(
      "Check the pull request description against the patch",
    );
    expect(prompt).toContain(
      "give each one severity P2, since it blocks the review rather than the code",
    );
  });
});
