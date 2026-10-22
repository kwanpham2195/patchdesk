import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { walkthroughInputSchemas } from "#src/domain/walkthrough-protocol";
import { walkthroughInputLimitDiagnostic } from "#src/domain/walkthrough-input-diagnostic";

describe("Walkthrough operation diagnostics", () => {
  it("rejects prose beyond the producer limit at operation admission", () => {
    expect(
      v.safeParse(walkthroughInputSchemas.open_section, {
        opId: "section-1",
        chapterId: "c1",
        title: "Decision",
        prose: `a.ts ${"detail ".repeat(46)}`,
      }).success,
    ).toBe(false);
  });

  it("records only violated field limits when a generated section exceeds them", () => {
    const parsed = v.safeParse(walkthroughInputSchemas.open_section, {
      opId: "section-1",
      chapterId: "c1",
      title: "Decision",
      prose: "private prose ".repeat(27),
    });
    if (parsed.success) throw new Error("Expected rejected prose");
    const detail = walkthroughInputLimitDiagnostic(parsed.issues);
    expect(detail).toBe("prose_377_gt_320");
    expect(detail).not.toContain("private prose");
  });
});
