// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalysisReader } from "../../src/renderer/src/components/analysis-reader";

const result: Parameters<typeof AnalysisReader>[0]["result"] = {
  changeSummary: "Analysis of the `currentChange`",
  summary: "The implementation needs a **boundary check**.",
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
  it("reveals the complete containing hunk and highlights the mapped Finding range on demand", async () => {
    const user = userEvent.setup();
    render(<AnalysisReader result={result} evidencePatch={patch} />);

    expect(
      screen.queryByRole("region", { name: "Finding evidence src/a.ts" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "View evidence" }));
    const evidence = screen.getByRole("region", {
      name: "Finding evidence src/a.ts",
    });
    expect(
      screen.getByLabelText("Resizable code evidence").className,
    ).toContain("h-[50vh]");
    expect(
      screen.getByLabelText("Resizable code evidence").className,
    ).toContain("resize-y");
    expect(evidence.textContent).toContain("unchanged();");
    expect(evidence.textContent).toContain("oldValue();");
    expect(evidence.textContent).toContain("acceptInvalidValue();");
    expect(
      evidence.querySelector(
        '[data-selected-line="true"][data-line-number="2"]',
      ),
    ).toBeTruthy();
  });

  it("keeps dismissal detail hidden until requested", async () => {
    const user = userEvent.setup();
    const onDismissFinding = vi.fn(async () => undefined);
    render(
      <AnalysisReader result={result} onDismissFinding={onDismissFinding} />,
    );

    expect(
      screen.queryByLabelText("Dismiss reason for Missing boundary check"),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    const reason = screen.getByLabelText(
      "Dismiss reason for Missing boundary check",
    );
    await user.type(reason, "Covered by the API contract");
    await user.click(screen.getByRole("button", { name: "Confirm dismissal" }));
    expect(onDismissFinding).toHaveBeenCalledWith(
      result.findings[0],
      "Covered by the API contract",
    );
  });

  it("renders generated analysis prose with safe Markdown formatting", () => {
    render(<AnalysisReader result={result} />);

    expect(screen.getByText("currentChange").tagName).toBe("CODE");
    expect(screen.getByText("boundary check").tagName).toBe("STRONG");
    expect(
      screen.getByText("The implementation needs a", { exact: false }),
    ).toBeTruthy();
  });

  it("uses shared Markdown hierarchy and task states for analysis prose", () => {
    render(
      <AnalysisReader
        result={{
          ...result,
          summary:
            "# Analysis heading\n\n- [x] Completed analysis task\n- [ ] Incomplete analysis task",
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Analysis heading" }).className,
    ).toContain("text-xl");
    expect(screen.getByLabelText("Completed task")).toBeTruthy();
    expect(screen.getByLabelText("Incomplete task")).toBeTruthy();
  });

  it("sends the original suggested comment only after the explicit Add to review action", async () => {
    const user = userEvent.setup();
    const onAddFinding = vi.fn(async () => undefined);
    render(
      <AnalysisReader
        result={result}
        findingStatuses={{ "finding-1": "actionable" }}
        onAddFinding={onAddFinding}
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
        findingStatuses={{ "finding-1": "pending_review" }}
      />,
    );
    expect(screen.getByText("pending review")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();

    rerender(
      <AnalysisReader
        result={result}
        findingStatuses={{ "finding-1": "published" }}
      />,
    );
    expect(screen.getByText("published")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();
  });
});

it("deduplicates and groups supporting details by reviewer purpose", async () => {
  const user = userEvent.setup();
  render(
    <AnalysisReader
      result={{
        ...result,
        callouts: [
          {
            category: "configuration",
            title: "Pilot scope hardcoded as store code '005'",
            detail:
              "The pilot uses the literal '005' and needs a code change to expand.",
          },
        ],
        unresolvedItems: [
          "Whether the hierarchy API emits 'Store Space,Kam Space' as a per-space space type value.",
          "Whether nested pages exist under the route prefix.",
        ],
        assumptions: [
          "The hardcoded store code '005' pilot gate is intentional.",
          "Whether the hierarchy API emits 'Store Space,Kam Space' as a per-space space_type value is unknown.",
          "Whether nested pages exist under the route prefix is unverified.",
          "Only changed files were inspectable in this environment.",
        ],
      }}
    />,
  );

  expect(screen.getByText(/4 supporting details in 3 groups/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show details" }));
  expect(
    screen.getByRole("heading", { name: /Reviewer callouts 1/ }),
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: /Open questions 2/ }),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: /Assumptions 1/ })).toBeTruthy();
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
});

it("preserves the generated Markdown structure without rewriting prose", () => {
  const firstFinding = result.findings[0];
  if (firstFinding === undefined) throw new Error("finding fixture missing");
  render(
    <AnalysisReader
      result={{
        ...result,
        summary: "One deliberate paragraph. It keeps both sentences together.",
        findings: [
          {
            ...firstFinding,
            explanation:
              "- Mock omits the route key.\n- Redirect becomes invalid.",
          },
        ],
      }}
    />,
  );

  expect(
    screen.getByText(/One deliberate paragraph/).closest("p"),
  ).toBeTruthy();
  expect(
    screen.getByText("Mock omits the route key.").closest("li"),
  ).toBeTruthy();
  expect(
    screen.getByText("Redirect becomes invalid.").closest("li"),
  ).toBeTruthy();
});
