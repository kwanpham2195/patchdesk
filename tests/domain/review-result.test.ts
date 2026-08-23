import { describe, expect, it } from "vitest";
import type * as v from "valibot";

import type { modelReviewResultSchema } from "../../src/domain/review-result";
import { parseModelReviewResult } from "../../src/domain/review-result";

type ModelFindingInput = v.InferOutput<
  typeof modelReviewResultSchema
>["findings"][number];

function validResult(findings: ReadonlyArray<ModelFindingInput>) {
  return {
    changeSummary: "Fixture change summary.",
    verdict: "comment",
    summary: "Fixture summary.",
    findings,
    validationPlan: ["Fixture validation plan."],
    assumptions: ["Fixture assumption."],
  };
}

describe("model review result projection", () => {
  it("bounds a wide finding range to the evidence highlight limit", () => {
    const result = validResult([
      {
        id: "wide-doc-finding",
        severity: "P3",
        title: "Whole-doc concern",
        file: "docs/guide.md",
        lineStart: 1,
        lineEnd: 517,
        diffSide: "new",
        explanation: "The model cited a whole document.",
        confidence: "medium",
      },
    ]);
    const parsed = parseModelReviewResult(result);
    expect(parsed._tag).toBe("ok");
    if (parsed._tag === "err") return;
    expect(parsed.value.findings[0]?.lineStart).toBe(1);
    expect(parsed.value.findings[0]?.lineEnd).toBe(10);
  });

  it("keeps narrow ranges unchanged", () => {
    const result = validResult([
      {
        id: "narrow-finding",
        severity: "P2",
        title: "Narrow concern",
        file: "src/a.ts",
        lineStart: 5,
        lineEnd: 7,
        explanation: "A narrow range stays as cited.",
        confidence: "high",
      },
    ]);
    const parsed = parseModelReviewResult(result);
    expect(parsed._tag).toBe("ok");
    if (parsed._tag === "err") return;
    expect(parsed.value.findings[0]?.lineEnd).toBe(7);
  });

  it("still rejects an inverted finding range", () => {
    const result = validResult([
      {
        id: "inverted-finding",
        severity: "P1",
        title: "Inverted range",
        file: "src/a.ts",
        lineStart: 40,
        lineEnd: 20,
        explanation: "An inverted range is nonsense.",
        confidence: "high",
      },
    ]);
    expect(parseModelReviewResult(result)).toEqual({
      _tag: "err",
      error: { _tag: "InvalidModelReviewResult" },
    });
  });
});
