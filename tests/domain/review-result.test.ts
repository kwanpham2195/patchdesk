import { describe, expect, it } from "vitest";
import type * as v from "valibot";

import type { modelReviewResultSchema } from "../../src/domain/review-result";
import {
  parseModelReviewResult,
  parseReviewResult,
} from "../../src/domain/review-result";

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
  it("keeps a structured suggested replacement", () => {
    const parsed = parseModelReviewResult(
      validResult([
        {
          id: "replacement-finding",
          severity: "P2",
          title: "Guard runs too late",
          file: "src/a.ts",
          lineStart: 12,
          diffSide: "new",
          explanation: "The mutation runs before the guard.",
          confidence: "high",
          suggestedReplacement: { code: "if (stale) return stale;" },
        },
      ]),
    );
    expect(parsed._tag).toBe("ok");
    if (parsed._tag === "err") return;
    expect(parsed.value.findings[0]?.suggestedReplacement).toEqual({
      code: "if (stale) return stale;",
    });
  });

  it("no longer accepts the prose suggestedChange field", () => {
    const result = validResult([]);
    expect(
      parseModelReviewResult({
        ...result,
        verdict: "comment",
        findings: [
          {
            id: "prose-finding",
            severity: "P2",
            title: "Prose suggestion",
            explanation: "The model sent the retired field.",
            confidence: "low",
            suggestedChange: "Flip the condition.",
          },
        ],
      }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidModelReviewResult" },
    });
  });

  it("rejects a summary past the model prose cap the retained schema still reads", () => {
    const empty = { ...validResult([]), verdict: "approve" };
    expect(
      parseModelReviewResult({ ...empty, summary: "a".repeat(400) })._tag,
    ).toBe("ok");
    expect(
      parseModelReviewResult({ ...empty, summary: "a".repeat(401) }),
    ).toEqual({ _tag: "err", error: { _tag: "InvalidModelReviewResult" } });

    const stored = parseReviewResult({ ...empty, summary: "a".repeat(401) });
    expect(stored._tag).toBe("ok");
    if (stored._tag === "err") return;
    expect(stored.value.summary).toBe("a".repeat(401));
  });
});

describe("stored review result projection", () => {
  it("reads a v0.0.10 result carrying the retired suggestedChange and drops the field", () => {
    const parsed = parseReviewResult({
      ...validResult([]),
      findings: [
        {
          id: "stored-finding",
          severity: "P2",
          title: "Guard runs too late",
          file: "src/a.ts",
          lineStart: 12,
          diffSide: "new",
          explanation: "The mutation runs before the guard.",
          confidence: "high",
          mappingStatus: "mapped",
          suggestedChange: "Flip the condition.",
        },
      ],
    });
    expect(parsed._tag).toBe("ok");
    if (parsed._tag === "err") return;
    const finding = parsed.value.findings[0];
    if (finding === undefined) throw new Error("expected one stored finding");
    expect(finding.title).toBe("Guard runs too late");
    expect("suggestedChange" in finding).toBe(false);
  });
});
