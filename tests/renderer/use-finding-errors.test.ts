// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  AnalysisFindingStatus,
  AnalysisResult,
} from "../../src/renderer/src/analysis-headline";
import { useFindingErrors } from "../../src/renderer/src/hooks/use-finding-errors";

const finding = {
  id: "finding-1",
  severity: "P1" as const,
  title: "Missing boundary check",
  file: "src/a.ts",
  lineStart: 2,
  lineEnd: 2,
  diffSide: "new" as const,
  explanation: "The added branch accepts an invalid value.",
  suggestedComment: "Reject invalid values before this branch.",
  confidence: "high" as const,
  mappingStatus: "mapped" as const,
};

const result: AnalysisResult = {
  changeSummary: "Change summary",
  summary: "Analysis summary",
  verdict: "comment",
  findings: [
    finding,
    { ...finding, id: "finding-2", title: "Second boundary check" },
  ],
  validationPlan: [],
  assumptions: [],
};

type Props = {
  readonly result: AnalysisResult;
  readonly statuses: Readonly<Record<string, AnalysisFindingStatus>>;
};

function renderFindingErrors(initialProps: Props) {
  return renderHook(
    (props: Props) => useFindingErrors(props.result, props.statuses),
    { initialProps },
  );
}

describe("useFindingErrors", () => {
  it("clears only errors whose authoritative Finding state settles", async () => {
    const rendered = renderFindingErrors({
      result,
      statuses: { "finding-1": "actionable", "finding-2": "actionable" },
    });
    act(() => {
      rendered.result.current.record("finding-1", "First failure");
      rendered.result.current.record("finding-2", "Second failure");
    });

    rendered.rerender({
      result,
      statuses: {
        "finding-1": "pending_review",
        "finding-2": "actionable",
      },
    });
    await waitFor(() =>
      expect(rendered.result.current.errors.has("finding-1")).toBe(false),
    );
    expect(rendered.result.current.errors.get("finding-2")).toBe(
      "Second failure",
    );

    rendered.rerender({
      result: {
        ...result,
        findings: result.findings.map((item) =>
          item.id === "finding-2"
            ? { ...item, disposition: "dismissed" as const }
            : item,
        ),
      },
      statuses: { "finding-1": "pending_review" },
    });
    await waitFor(() =>
      expect(rendered.result.current.errors.has("finding-2")).toBe(false),
    );
  });

  it("retains a deterministic failure until locked reconciliation returns to actionable", async () => {
    const rendered = renderFindingErrors({
      result,
      statuses: { "finding-1": "actionable" },
    });
    act(() => rendered.result.current.record("finding-1", "Add failed"));

    rendered.rerender({ result, statuses: { "finding-1": "actionable" } });
    expect(rendered.result.current.errors.get("finding-1")).toBe("Add failed");

    rendered.rerender({ result, statuses: { "finding-1": "locked" } });
    expect(rendered.result.current.errors.get("finding-1")).toBe("Add failed");

    rendered.rerender({ result, statuses: { "finding-1": "actionable" } });
    await waitFor(() =>
      expect(rendered.result.current.errors.has("finding-1")).toBe(false),
    );
  });

  it("clears an error when the user retries the same Finding", () => {
    const rendered = renderFindingErrors({
      result,
      statuses: { "finding-1": "actionable" },
    });
    act(() => rendered.result.current.record("finding-1", "Add failed"));
    act(() => rendered.result.current.clear("finding-1"));
    expect(rendered.result.current.errors.has("finding-1")).toBe(false);
  });
});
