// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalysisReader } from "../../src/renderer/src/components/analysis-reader";
import type { LocalApplyControls } from "../../src/renderer/src/flows/use-local-apply";

afterEach(cleanup);

const withSuggestion = {
  id: "finding-bound",
  severity: "P2" as const,
  title: "Off-by-one bound",
  file: "src/a.ts",
  lineStart: 2,
  lineEnd: 2,
  diffSide: "new" as const,
  explanation: "The loop reads one past the end.",
  confidence: "high" as const,
  mappingStatus: "mapped" as const,
  suggestedReplacement: { code: "for (let i = 0; i < n; i++) {" },
};
const withoutSuggestion = {
  ...withSuggestion,
  id: "finding-plain",
  title: "Unchecked input",
  lineStart: 1,
  lineEnd: 1,
  suggestedReplacement: undefined,
};
const result: Parameters<typeof AnalysisReader>[0]["result"] = {
  changeSummary: "Adds a loop.",
  summary: "Check the bound.",
  verdict: "comment",
  findings: [withSuggestion, withoutSuggestion],
  validationPlan: [],
  assumptions: [],
};
const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/a.ts",
  "@@ -0,0 +1,3 @@",
  "+read(input);",
  "+for (let i = 0; i <= n; i++) {",
  "+}",
].join("\n");

function controls(
  overrides: Partial<LocalApplyControls> = {},
): LocalApplyControls {
  return {
    selectedIds: new Set(),
    setSelected: vi.fn(),
    apply: vi.fn(async () => undefined),
    check: vi.fn(async () => undefined),
    pending: false,
    blocked: false,
    ...overrides,
  };
}

function findingRow(title: string): HTMLElement {
  const row = screen.getByText(title).closest("li");
  if (row === null) throw new Error(`no row for ${title}`);
  return row;
}

describe("Apply suggestions on a working-tree Review", () => {
  it("offers Apply only on a Finding whose suggestion resolves, and confirms before writing", async () => {
    const user = userEvent.setup();
    const localApply = controls({ selectedIds: new Set(["finding-bound"]) });
    render(
      <AnalysisReader
        result={result}
        evidencePatch={patch}
        localApply={localApply}
      />,
    );

    const selectable = within(findingRow("Off-by-one bound")).getByRole(
      "checkbox",
      { name: "Apply" },
    );
    expect(selectable.getAttribute("aria-checked")).toBe("true");
    expect(
      within(findingRow("Unchecked input")).queryByRole("checkbox", {
        name: "Apply",
      }),
    ).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Apply 1 suggestion" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(
        within(dialog).getByRole("list", { name: "Suggestions to apply" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(1);
    expect(localApply.apply).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Apply to working tree" }),
    );

    expect(localApply.apply).toHaveBeenCalledTimes(1);
  });

  it("disables Apply and shows the refusal beside it when the session no longer matches the checkout", () => {
    render(
      <AnalysisReader
        result={result}
        evidencePatch={patch}
        localApply={controls({
          selectedIds: new Set(["finding-bound"]),
          blocked: true,
          refusal: "The working tree changed after this Analysis ran.",
        })}
      />,
    );

    const group = screen.getByRole("group", { name: "Apply suggestions" });
    expect(
      within(group).getByRole("button", { name: "Apply 1 suggestion" }),
    ).toHaveProperty("disabled", true);
    expect(within(group).getAllByRole("alert")).toHaveLength(1);
    expect(
      within(findingRow("Off-by-one bound"))
        .getByRole("checkbox", { name: "Apply" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("replaces Apply with a file check while an earlier Apply is unsettled", async () => {
    const user = userEvent.setup();
    const localApply = controls({ lock: "outcome_unknown" });
    render(
      <AnalysisReader
        result={result}
        evidencePatch={patch}
        localApply={localApply}
      />,
    );

    const group = screen.getByRole("group", { name: "Apply suggestions" });
    expect(within(group).queryByRole("button", { name: /^Apply/ })).toBeNull();
    await user.click(
      within(group).getByRole("button", { name: "Check files" }),
    );

    expect(localApply.check).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "an unsettled Apply",
      overrides: { lock: "outcome_unknown" },
      shown: () => screen.getByRole("button", { name: "Check files" }),
    },
    {
      name: "a refusal",
      overrides: { refusal: "git apply refused the change." },
      shown: () => screen.getByRole("alert"),
    },
    {
      name: "a notice",
      overrides: { notice: "Applied 1 suggestion." },
      shown: () => screen.getByRole("status"),
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly overrides: Partial<LocalApplyControls>;
    readonly shown: () => HTMLElement;
  }>)(
    "keeps the Apply bar for $name when nothing is left to apply",
    ({ overrides, shown }) => {
      render(
        <AnalysisReader
          result={{ ...result, findings: [withoutSuggestion] }}
          evidencePatch={patch}
          localApply={controls(overrides)}
        />,
      );

      const group = screen.getByRole("group", { name: "Apply suggestions" });
      expect(group.contains(shown())).toBe(true);
    },
  );

  it("leaves the Apply bar out when no open Finding has a suggestion that resolves", () => {
    render(
      <AnalysisReader
        result={{
          ...result,
          findings: [
            withoutSuggestion,
            { ...withSuggestion, disposition: "dismissed" as const },
          ],
        }}
        evidencePatch={patch}
        localApply={controls()}
      />,
    );

    expect(screen.getByText("Unchecked input")).toBeTruthy();
    expect(
      screen.queryByRole("group", { name: "Apply suggestions" }),
    ).toBeNull();
  });
});
