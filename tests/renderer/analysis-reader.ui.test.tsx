// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalysisReader } from "../../src/renderer/src/components/analysis-reader";

const result: Parameters<typeof AnalysisReader>[0]["result"] = {
  changeSummary: "Analysis of the current change",
  summary: "The implementation needs a boundary check.",
  verdict: "comment",
  findings: [
    {
      id: "finding-1",
      severity: "P1",
      title: "Missing boundary check",
      file: "src/a.ts",
      lineStart: 2,
      lineEnd: 2,
      diffSide: "new",
      explanation: "The added branch accepts an invalid value.",
      suggestedComment: "Reject invalid values before this branch.",
      confidence: "high",
      mappingStatus: "mapped",
    },
  ],
  validationPlan: [],
  assumptions: [],
};

const scope: Parameters<typeof AnalysisReader>[0]["scope"] = {
  baseShort: "base",
  headShort: "head",
  commitCount: 1,
  fileCount: 1,
  additions: 2,
  deletions: 1,
  changedFiles: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
};

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " unchanged();",
  "-oldValue();",
  "+newValue();",
  "+acceptInvalidValue();",
].join("\n");

afterEach(cleanup);

describe("AnalysisReader", () => {
  it("renders the complete containing hunk and highlights the mapped Finding range", () => {
    render(
      <AnalysisReader
        result={result}
        onBack={vi.fn()}
        evidencePatch={patch}
        scope={scope}
      />,
    );

    const evidence = screen.getByRole("region", {
      name: "Finding evidence src/a.ts",
    });
    expect(evidence.textContent).toContain("unchanged();");
    expect(evidence.textContent).toContain("oldValue();");
    expect(evidence.textContent).toContain("acceptInvalidValue();");
    expect(
      evidence.querySelector('[data-selected-line="true"][data-line-number="2"]'),
    ).toBeTruthy();
  });

  it("sends the original suggested comment only after the explicit Add to review action", async () => {
    const user = userEvent.setup();
    const onAddFinding = vi.fn(async () => undefined);
    render(
      <AnalysisReader
        result={result}
        onBack={vi.fn()}
        findingStatuses={{ "finding-1": "actionable" }}
        onAddFinding={onAddFinding}
        scope={scope}
      />,
    );

    expect(onAddFinding).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Add to review" }));
    expect(onAddFinding).toHaveBeenCalledWith(result.findings[0]);
    expect(screen.queryByRole("button", { name: /Files/i })).toBeNull();
  });

  it("shows receipt-derived pending and published states without another add action", () => {
    const { rerender } = render(
      <AnalysisReader
        result={result}
        onBack={vi.fn()}
        findingStatuses={{ "finding-1": "pending_review" }}
        scope={scope}
      />,
    );
    expect(screen.getByText("pending review")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();

    rerender(
      <AnalysisReader
        result={result}
        onBack={vi.fn()}
        findingStatuses={{ "finding-1": "published" }}
        scope={scope}
      />,
    );
    expect(screen.getByText("published")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();
  });
});
