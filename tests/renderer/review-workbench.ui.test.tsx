// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ReviewWorkbench } from "../../src/renderer/src/components/review-workbench";

describe("review workbench", () => {
  it("keeps unmapped findings visible, drafts local edits, and exposes only read-only review context", async () => {
    const user = userEvent.setup();
    render(
      <ReviewWorkbench
        result={{
          changeSummary: "Adds the completed-review workbench.",
          verdict: "comment",
          summary: "A mapped finding needs a comment.",
          findings: [
            { id: "mapped", severity: "P1", title: "Mapped finding", file: "src/workbench.ts", lineStart: 7, diffSide: "new", explanation: "Use a safe path.", suggestedComment: "Use a safe path.", confidence: "high", mappingStatus: "mapped" },
            { id: "unmapped", severity: "P2", title: "Unmapped finding", explanation: "This cannot be placed.", confidence: "medium", mappingStatus: "unmapped" },
          ],
          validationPlan: ["pnpm test"],
          assumptions: ["The fixture is current."],
        } as never}
        draft={{ summaryBody: "A mapped finding needs a comment.", comments: [{ findingId: "mapped", body: "Use a safe path.", postability: "postable" }] }}
        comments={{ threads: [{ id: "thread-1", state: "open", comments: [{ id: "comment-1", author: "reviewer", body: "Existing review comment", createdAt: "2026-07-16T00:00:00.000Z" as never, location: { path: "src/workbench.ts" as never, line: 7 } }] }] }}
        checks={{ overall: "failing", checks: [{ name: "unit", required: true, status: "completed", conclusion: "failure", url: "https://example.test/check" }] }}
        history={[{ id: "001", state: "ReviewCompleted" }, { id: "002", state: "Discarded" }]}
        debugHref="/debug/session"
      />,
    );

    expect(screen.getByText("Unmapped — not postable")).toBeTruthy();
    expect(screen.getByText("Existing review comment")).toBeTruthy();
    expect(screen.getByText("unit · Required · failure")).toBeTruthy();
    expect(screen.getByText("Attempt 002: Discarded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /resolve|reply|apply/i })).toBeNull();
    await user.clear(screen.getByLabelText("Draft for mapped"));
    await user.type(screen.getByLabelText("Draft for mapped"), "Edited locally");
    expect(screen.getByDisplayValue("Edited locally")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy validation plan" }));
    expect(screen.getByText("Validation plan copied locally.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Attempt 002: Discarded" }));
    expect(screen.getByText("Reopened attempt 002 in the workbench.")).toBeTruthy();
  });

  it("shows a stale-head warning instead of a GitHub write control", () => {
    render(<ReviewWorkbench result={{ changeSummary: "", verdict: "approve", summary: "", findings: [], validationPlan: [], assumptions: [] } as never} draft={{ summaryBody: "", comments: [] }} comments={{ threads: [] }} checks={{ overall: "unknown", checks: [] }} history={[]} debugHref="/debug" staleHead />);
    expect(screen.getByText("GitHub posting is blocked because this review head is stale.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /post|submit/i })).toBeNull();
  });
});
