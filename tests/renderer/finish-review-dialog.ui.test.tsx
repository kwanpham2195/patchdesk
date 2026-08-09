// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FinishReviewDialog } from "../../src/renderer/src/components/finish-review-dialog";
import type { PendingReviewProjection } from "../../src/renderer/src/renderer-contracts";

const projection: PendingReviewProjection = {
  state: "pending",
  count: 2,
  review: {
    nodeId: "PRR_kwDORJzsQM7e6QwJ",
    headSha: "a".repeat(40),
    comments: [
      { threadId: "PRRT_1", body: "First comment", path: "src/a.ts", startLine: 1, line: 1, side: "new" },
      { threadId: "PRRT_2", body: "Second comment", path: "src/b.ts", startLine: 3, line: 5, side: "old" },
    ],
  },
};

afterEach(cleanup);

describe("FinishReviewDialog", () => {
  it("renders the pending-comment ledger, decision choice, and no Discard action", () => {
    render(
      <FinishReviewDialog
        open
        onOpenChange={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit: vi.fn(), onCheckGitHubAgain: vi.fn() }}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Finish review" });
    expect(within(dialog).getByText("First comment")).toBeTruthy();
    expect(within(dialog).getByText("Second comment")).toBeTruthy();
    expect(within(dialog).getByText("src/b.ts:3–5 (old)")).toBeTruthy();
    expect(within(dialog).getByRole("combobox", { name: "Review decision" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Discard/ })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Submit review" })).toBeTruthy();
  });

  it("focuses the summary input when opened and keeps the summary modal-local", () => {
    render(
      <FinishReviewDialog
        open
        onOpenChange={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit: vi.fn(), onCheckGitHubAgain: vi.fn() }}
      />,
    );
    const summary = screen.getByRole("textbox", { name: "Final review summary" });
    expect(summary).toBeTruthy();
  });

  it("sends the selected event and modal summary only on Submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    const onOpenChange = vi.fn();
    render(
      <FinishReviewDialog
        open
        onOpenChange={onOpenChange}
        projection={projection}
        actions={{ busy: false, onSubmit, onCheckGitHubAgain: vi.fn() }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Final review summary" }), { target: { value: "Only on submit" } });
    await user.click(screen.getByRole("combobox", { name: "Review decision" }));
    await user.click(await screen.findByRole("option", { name: "Approve" }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("APPROVE", "Only on submit"));
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("disables close, decision, and submit while a submission is in flight", () => {
    render(
      <FinishReviewDialog
        open
        onOpenChange={vi.fn()}
        projection={projection}
        actions={{ busy: true, onSubmit: vi.fn(), onCheckGitHubAgain: vi.fn() }}
      />,
    );
    expect((screen.getByRole("button", { name: "Submit review" }) as HTMLButtonElement).disabled).toBe(true);
    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    expect(closeButtons.length).toBeGreaterThan(0);
    expect((closeButtons[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces a bounded submit failure and offers Check GitHub again", async () => {
    const onSubmit = vi.fn(async () => { throw new Error("write failed"); });
    render(
      <FinishReviewDialog
        open
        onOpenChange={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit, onCheckGitHubAgain: vi.fn() }}
        error="GitHub could not confirm the submission. Check GitHub again before trying again."
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Final review summary" }), { target: { value: "Summary" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Check GitHub again" })).toBeTruthy();
  });
});
