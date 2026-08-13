import { describe, expect, it } from "vitest";
import { composeReviewPrompt } from "../../src/services/review-rubric";

describe("review rubric", () => {
  it("uses the complete patch", () =>
    expect(
      composeReviewPrompt({
        reviewInput: "input",
        context: "context",
        fullPatch: "patch",
      }),
    ).toContain("patch"));
});
