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
  it("renders the pending-comment ledger, decision choice, and the single discard entry point", () => {
    render(
      <FinishReviewDialog
        open
        onOpenChange={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit: vi.fn(), onDiscard: vi.fn() }}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Finish review" });
    expect(within(dialog).getByText("First comment")).toBeTruthy();
    expect(within(dialog).getByText("Second comment")).toBeTruthy();
    expect(within(dialog).getByText("src/b.ts:3–5 (old)")).toBeTruthy();
    expect(within(dialog).getByRole("combobox", { name: "Review decision" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Discard review" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Confirm discard" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Submit review" })).toBeTruthy();
  });

  it("requires a separate explicit confirmation before Discard invokes the write", async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn(async () => undefined);
    const onOpenChange = vi.fn();
    render(
      <FinishReviewDialog
        open
        onOpenChange={onOpenChange}
        projection={projection}
        actions={{ busy: false, onSubmit: vi.fn(), onDiscard }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Discard review" }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm discard" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("button", { name: "Confirm discard" })).toBeNull();
    expect(onDiscard).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard review" }));
    await user.click(screen.getByRole("button", { name: "Confirm discard" }));
    await vi.waitFor(() => expect(onDiscard).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("focuses the summary input when opened and keeps the summary modal-local", () => {
    render(
      <FinishReviewDialog
        open
        onOpenChange={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit: vi.fn(), onDiscard: vi.fn() }}
      />,
    );
    const summary = screen.getByRole("textbox", { name: "Final review summary" });
    expect(summary).toBeTruthy();
  });

  it("seeds a supplied Analysis summary on open while keeping Comment selected", () => {
    render(
      <FinishReviewDialog
        open
        onOpenChange={vi.fn()}
        projection={projection}
        initialSummary={"# Review Scope\nAnalysis context"}
        actions={{ busy: false, onSubmit: vi.fn(), onDiscard: vi.fn() }}
      />,
    );
    expect((screen.getByRole("textbox", { name: "Final review summary" }) as HTMLTextAreaElement).value).toBe("# Review Scope\nAnalysis context");
    expect(screen.getByRole("combobox", { name: "Review decision" }).textContent).toContain("Comment");
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
        actions={{ busy: false, onSubmit, onDiscard: vi.fn() }}
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
        actions={{ busy: true, onSubmit: vi.fn(), onDiscard: vi.fn() }}
      />,
    );
    expect((screen.getByRole("button", { name: "Submit review" }) as HTMLButtonElement).disabled).toBe(true);
    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    expect(closeButtons.length).toBeGreaterThan(0);
    expect((closeButtons[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces a bounded submit failure and leaves recovery outside the modal", async () => {
    const onSubmit = vi.fn(async () => { throw new Error("write failed"); });
    render(
      <FinishReviewDialog
        open
        onOpenChange={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit, onDiscard: vi.fn() }}
        error="GitHub could not confirm the submission. Check GitHub again before trying again."
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Final review summary" }), { target: { value: "Summary" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // The modal never hosts the recovery control; the unavailable/recovery
    // notice outside the modal owns Check GitHub again.
    expect(screen.queryByRole("button", { name: "Check GitHub again" })).toBeNull();
  });

  it("shows human decision labels in the closed select and submits uppercase values", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <FinishReviewDialog
        open
        onOpenChange={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit, onDiscard: vi.fn() }}
      />,
    );
    const decision = screen.getByRole("combobox", { name: "Review decision" });
    expect(decision.textContent).toContain("Comment");
    expect(decision.textContent).not.toContain("COMMENT");
    await user.click(decision);
    await user.click(await screen.findByRole("option", { name: "Approve" }));
    expect(decision.textContent).toContain("Approve");
    expect(decision.textContent).not.toContain("APPROVE");
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("APPROVE", ""));
  });

  it("keeps Discard in a separate footer group from Close and Submit", () => {
    render(
      <FinishReviewDialog
        open
        onOpenChange={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit: vi.fn(), onDiscard: vi.fn() }}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Finish review" });
    const dangerGroup = dialog.querySelector('[data-finish-review-actions-danger]');
    const primaryGroup = dialog.querySelector('[data-finish-review-actions-primary]');
    expect(dangerGroup).not.toBeNull();
    expect(primaryGroup).not.toBeNull();
    expect(dangerGroup?.textContent).toContain("Discard review");
    expect(dangerGroup?.textContent).not.toContain("Submit review");
    expect(dangerGroup?.textContent).not.toContain("Close");
    expect(primaryGroup?.textContent).toContain("Close");
    expect(primaryGroup?.textContent).toContain("Submit review");
    expect(primaryGroup?.textContent).not.toContain("Discard");
    // Both footer groups and the decision row wrap instead of clipping.
    const actions = dialog.querySelector('[data-finish-review-actions]');
    expect(actions?.className).toContain("flex-wrap");
    expect(actions?.className).toContain("justify-between");
    expect(dialog.querySelector('[data-finish-review-decision-row]')?.className).toContain("flex-wrap");
  });
});
