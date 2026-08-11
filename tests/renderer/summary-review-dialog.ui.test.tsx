// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SummaryReviewDialog } from "../../src/renderer/src/components/summary-review-dialog";

afterEach(cleanup);

describe("SummaryReviewDialog", () => {
  it("makes an uncertain submission recoverable before allowing another submit", async () => {
    const user = userEvent.setup();
    const onRecover = vi.fn(async () => ({ state: "idle" as const }));
    const onSubmit = vi.fn(async () => ({ state: "confirmed" as const, receipt: { reviewId: "9002", event: "COMMENT" as const } }));
    const { rerender } = render(
      <SummaryReviewDialog
        open
        busy={false}
        state="recovery_required"
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onRecover={onRecover}
      />,
    );

    expect(screen.getByText("Review submission needs confirmation")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check GitHub status" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit review" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Check GitHub status" }));
    expect(onRecover).toHaveBeenCalledTimes(1);

    rerender(
      <SummaryReviewDialog
        open
        busy={false}
        state="idle"
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onRecover={onRecover}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Review summary" }), { target: { value: "Recovered summary" } });
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    expect(onSubmit).toHaveBeenCalledWith("COMMENT", "Recovered summary");
  });
  it("keeps the confirmed receipt open until the maintainer closes it", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn(async () => ({ state: "confirmed" as const, receipt: { reviewId: "9002", event: "COMMENT" as const } }));
    render(<SummaryReviewDialog open busy={false} state="idle" onOpenChange={onOpenChange} onSubmit={onSubmit} onRecover={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Review summary" }), { target: { value: "Published" } });
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

});
