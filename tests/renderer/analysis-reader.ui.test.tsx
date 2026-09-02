// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
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

const findingFixture = result.findings[0];
if (findingFixture === undefined) throw new Error("missing Finding fixture");

const twoFindingResult: Parameters<typeof AnalysisReader>[0]["result"] = {
  ...result,
  findings: [
    findingFixture,
    {
      ...findingFixture,
      id: "finding-2",
      title: "Second boundary issue",
      lineStart: 3,
      lineEnd: 3,
    },
  ],
};

function deferred() {
  let resolve = (): void => undefined;
  let reject = (): void => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = () => rejectPromise(new Error("fixture failure"));
  });
  return { promise, resolve, reject };
}

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

  it("offers Open in diff only for a mapped Finding and hands back that Finding", async () => {
    const user = userEvent.setup();
    const onOpenFindingInDiff = vi.fn();
    const unmapped = {
      ...findingFixture,
      id: "finding-unmapped",
      title: "Unmapped finding",
      file: "src/missing.ts",
      lineStart: 9,
      mappingStatus: "unmapped" as const,
    };
    render(
      <AnalysisReader
        result={{ ...result, findings: [findingFixture, unmapped] }}
        onOpenFindingInDiff={onOpenFindingInDiff}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Open in diff: src/missing.ts:9" }),
    ).toBeNull();
    expect(screen.getByText("src/missing.ts:9")).toBeTruthy();
    const open = screen.getByRole("button", {
      name: "Open in diff: src/a.ts:2",
    });
    open.focus();
    expect(document.activeElement).toBe(open);
    await user.click(open);
    expect(onOpenFindingInDiff).toHaveBeenCalledWith(findingFixture);
  });

  it("keeps the location as plain text when no diff navigation is wired", () => {
    render(<AnalysisReader result={result} />);
    expect(
      screen.queryByRole("button", { name: "Open in diff: src/a.ts:2" }),
    ).toBeNull();
    expect(screen.getByText("src/a.ts:2")).toBeTruthy();
    expect(document.getElementById("finding-finding-1")).toBeTruthy();
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

  it("explains when Analysis generated no findings without review actions", () => {
    render(
      <AnalysisReader
        result={{ ...result, findings: [] }}
        findingStatuses={{ "finding-1": "actionable" }}
        onAddFinding={vi.fn(async () => undefined)}
        onDismissFinding={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole("status", { name: "No findings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("does not describe handled findings as if Analysis generated none", () => {
    render(
      <AnalysisReader
        result={{
          ...result,
          findings: [{ ...findingFixture, disposition: "dismissed" }],
        }}
      />,
    );

    expect(
      within(screen.getByRole("listitem")).getByText(findingFixture.title),
    ).toBeTruthy();
    expect(screen.queryByRole("status", { name: "No findings" })).toBeNull();
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

  // The banner and merge readiness share one handled rule: a receipt handles
  // a finding the same way a dismissal does.
  it("drops a finding from the attention count once it has a review receipt", () => {
    const { rerender } = render(
      <AnalysisReader
        result={twoFindingResult}
        findingStatuses={{
          "finding-1": "actionable",
          "finding-2": "actionable",
        }}
      />,
    );
    expect(screen.getByText("2 items need attention")).toBeTruthy();

    rerender(
      <AnalysisReader
        result={twoFindingResult}
        findingStatuses={{
          "finding-1": "pending_review",
          "finding-2": "actionable",
        }}
      />,
    );
    expect(screen.getByText("1 item needs attention")).toBeTruthy();

    rerender(
      <AnalysisReader
        result={twoFindingResult}
        findingStatuses={{ "finding-1": "published", "finding-2": "locked" }}
      />,
    );
    expect(screen.getByText("1 item needs attention")).toBeTruthy();
  });

  it("admits Add synchronously once and leaves another Finding usable", async () => {
    const first = deferred();
    const second = deferred();
    const onAddFinding = vi.fn(
      (finding: (typeof twoFindingResult.findings)[number]) =>
        finding.id === "finding-1" ? first.promise : second.promise,
    );
    render(
      <AnalysisReader
        result={twoFindingResult}
        findingStatuses={{
          "finding-1": "actionable",
          "finding-2": "actionable",
        }}
        onAddFinding={onAddFinding}
        onDismissFinding={vi.fn(async () => undefined)}
      />,
    );
    const [firstRow, secondRow] = screen.getAllByRole("listitem");
    if (firstRow === undefined || secondRow === undefined)
      throw new Error("missing Finding rows");
    const firstAdd = within(firstRow).getByRole("button", {
      name: "Add to review",
    });

    act(() => {
      firstAdd.click();
      firstAdd.click();
    });

    const adding = within(firstRow).getByRole("button", { name: /Adding/ });
    expect(adding.hasAttribute("disabled")).toBe(true);
    expect(
      within(adding)
        .getByRole("status", { name: "Loading" })
        .getAttribute("data-icon"),
    ).toBe("inline-start");
    expect(
      within(firstRow)
        .getByRole("button", { name: "Dismiss" })
        .hasAttribute("disabled"),
    ).toBe(true);
    const secondAdd = within(secondRow).getByRole("button", {
      name: "Add to review",
    });
    expect(secondAdd.hasAttribute("disabled")).toBe(false);
    act(() => secondAdd.click());
    expect(onAddFinding).toHaveBeenCalledTimes(2);

    act(() => {
      second.resolve();
      first.resolve();
    });
    expect(
      await within(firstRow).findByRole("button", { name: "Add to review" }),
    ).toBeTruthy();
  });

  it("admits Dismiss synchronously once and preserves its reason on row-local failure", async () => {
    const dismissal = deferred();
    const onDismissFinding = vi.fn(() => dismissal.promise);
    render(
      <AnalysisReader
        result={twoFindingResult}
        findingStatuses={{
          "finding-1": "actionable",
          "finding-2": "actionable",
        }}
        onAddFinding={vi.fn(async () => undefined)}
        onDismissFinding={onDismissFinding}
      />,
    );
    const user = userEvent.setup();
    const [firstRow, secondRow] = screen.getAllByRole("listitem");
    if (firstRow === undefined || secondRow === undefined)
      throw new Error("missing Finding rows");
    await user.click(within(firstRow).getByRole("button", { name: "Dismiss" }));
    const reason = screen.getByLabelText<HTMLInputElement>(
      "Dismiss reason for Missing boundary check",
    );
    await user.type(reason, "Keep this reason");
    const confirm = screen.getByRole("button", { name: "Confirm dismissal" });

    act(() => {
      confirm.click();
      confirm.click();
    });

    const dismissing = screen.getByRole("button", { name: /Dismissing/ });
    expect(dismissing.hasAttribute("disabled")).toBe(true);
    expect(
      within(dismissing)
        .getByRole("status", { name: "Loading" })
        .getAttribute("data-icon"),
    ).toBe("inline-start");
    expect(
      within(firstRow)
        .getByRole("button", { name: "Add to review" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(secondRow)
        .getByRole("button", { name: "Dismiss" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(onDismissFinding).toHaveBeenCalledTimes(1);

    act(() => dismissal.reject());
    expect(
      (await within(firstRow).findByRole("alert")).getAttribute("data-slot"),
    ).toBe("inline-error");
    expect(within(secondRow).queryByRole("alert")).toBeNull();
    expect(reason.value).toBe("Keep this reason");
  });

  it("keeps concurrent Finding errors owned after reverse settlement", async () => {
    const first = deferred();
    const second = deferred();
    const onAddFinding = vi.fn(
      (finding: (typeof twoFindingResult.findings)[number]) =>
        finding.id === "finding-1" ? first.promise : second.promise,
    );
    render(
      <AnalysisReader
        result={twoFindingResult}
        findingStatuses={{
          "finding-1": "actionable",
          "finding-2": "actionable",
        }}
        onAddFinding={onAddFinding}
      />,
    );
    const [firstRow, secondRow] = screen.getAllByRole("listitem");
    if (firstRow === undefined || secondRow === undefined)
      throw new Error("missing Finding rows");
    act(() => {
      within(firstRow).getByRole("button", { name: "Add to review" }).click();
      within(secondRow).getByRole("button", { name: "Add to review" }).click();
    });

    act(() => second.reject());
    expect(
      (await within(secondRow).findByRole("alert")).getAttribute("data-slot"),
    ).toBe("inline-error");
    expect(within(firstRow).queryByRole("alert")).toBeNull();
    expect(
      within(firstRow).getByRole("button", { name: /Adding/ }),
    ).toBeTruthy();

    act(() => first.resolve());
    expect(
      await within(firstRow).findByRole("button", { name: "Add to review" }),
    ).toBeTruthy();
    expect(within(secondRow).getByRole("alert")).toBeTruthy();
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
