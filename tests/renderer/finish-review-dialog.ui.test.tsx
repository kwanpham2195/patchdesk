// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PatchdeskApiError } from "../../src/renderer/src/api-client";
import { FinishReviewDialog } from "../../src/renderer/src/components/finish-review-dialog";
import type { PendingReviewProjection } from "../../src/renderer/src/renderer-contracts";

const projection: PendingReviewProjection = {
  state: "pending",
  count: 2,
  review: {
    nodeId: "PRR_kwDORJzsQM7e6QwJ",
    headSha: "a".repeat(40),
    comments: [
      {
        threadId: "PRRT_1",
        body: "First comment",
        path: "src/a.ts",
        startLine: 1,
        line: 1,
        side: "new",
      },
      {
        threadId: "PRRT_2",
        body: "Second comment",
        path: "src/b.ts",
        startLine: 3,
        line: 5,
        side: "old",
      },
    ],
  },
};

afterEach(cleanup);

describe("FinishReviewDialog", () => {
  it("renders the pending-comment ledger, decision choice, and the single discard entry point", () => {
    render(
      <FinishReviewDialog
        open
        onClose={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit: vi.fn(), onDiscard: vi.fn() }}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Finish review" });
    expect(within(dialog).getByText("First comment")).toBeTruthy();
    expect(within(dialog).getByText("Second comment")).toBeTruthy();
    expect(within(dialog).getByText("src/b.ts:3–5 (old)")).toBeTruthy();
    expect(
      within(dialog).getByRole("combobox", { name: "Review decision" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Discard review" }),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Confirm discard" }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Submit review" }),
    ).toBeTruthy();
  });

  it("requires a separate explicit confirmation before Discard invokes the write", async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <FinishReviewDialog
        open
        onClose={onClose}
        projection={projection}
        actions={{ busy: false, onSubmit: vi.fn(), onDiscard }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Discard review" }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Confirm discard" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(
      screen.queryByRole("button", { name: "Confirm discard" }),
    ).toBeNull();
    expect(onDiscard).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard review" }));
    await user.click(screen.getByRole("button", { name: "Confirm discard" }));
    await vi.waitFor(() => expect(onDiscard).toHaveBeenCalledTimes(1));
    // The discarded summary is not handed back to be kept.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hands the summary and decision back on Escape and reopens with them", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const actions = { busy: false, onSubmit: vi.fn(), onDiscard: vi.fn() };
    const view = render(
      <FinishReviewDialog
        open
        onClose={onClose}
        projection={projection}
        actions={actions}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Final review summary" }),
      { target: { value: "A long summary" } },
    );
    await user.click(screen.getByRole("combobox", { name: "Review decision" }));
    await user.click(await screen.findByRole("option", { name: "Approve" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledWith({
      summary: "A long summary",
      event: "APPROVE",
    });

    view.rerender(
      <FinishReviewDialog
        open={false}
        onClose={onClose}
        projection={projection}
        actions={actions}
      />,
    );
    view.rerender(
      <FinishReviewDialog
        open
        onClose={onClose}
        projection={projection}
        actions={actions}
        draft={{ summary: "A long summary", event: "APPROVE" }}
      />,
    );
    const summary = screen.getByRole("textbox", {
      name: "Final review summary",
    });
    if (!(summary instanceof HTMLTextAreaElement))
      throw new Error("expected the final review summary textarea");
    expect(summary.value).toBe("A long summary");
    expect(
      screen.getByRole("combobox", { name: "Review decision" }).textContent,
    ).toContain("Approve");
  });

  it.each([
    { choice: "Replace summary", expected: "# Verdict\nAnalysis" },
    { choice: "Keep my summary", expected: "My own words" },
  ])(
    "asks before an Analysis summary replaces a kept one: $choice",
    async ({ choice, expected }) => {
      const user = userEvent.setup();
      render(
        <FinishReviewDialog
          open
          onClose={vi.fn()}
          projection={projection}
          draft={{ summary: "My own words", event: "REQUEST_CHANGES" }}
          offeredSummary={"# Verdict\nAnalysis"}
          actions={{ busy: false, onSubmit: vi.fn(), onDiscard: vi.fn() }}
        />,
      );
      const summary = screen.getByRole("textbox", {
        name: "Final review summary",
      });
      if (!(summary instanceof HTMLTextAreaElement))
        throw new Error("expected the final review summary textarea");
      expect(summary.value).toBe("My own words");

      await user.click(screen.getByRole("button", { name: choice }));

      expect(summary.value).toBe(expected);
      expect(
        screen.queryByRole("button", { name: "Replace summary" }),
      ).toBeNull();
      expect(
        screen.getByRole("combobox", { name: "Review decision" }).textContent,
      ).toContain("Request changes");
    },
  );

  it("seeds a supplied Analysis summary on open while keeping Comment selected", () => {
    render(
      <FinishReviewDialog
        open
        onClose={vi.fn()}
        projection={projection}
        offeredSummary={"# Review Scope\nAnalysis context"}
        actions={{ busy: false, onSubmit: vi.fn(), onDiscard: vi.fn() }}
      />,
    );
    const summary = screen.getByRole("textbox", {
      name: "Final review summary",
    });
    if (!(summary instanceof HTMLTextAreaElement))
      throw new Error("expected the final review summary textarea");
    expect(summary.value).toBe("# Review Scope\nAnalysis context");
    expect(
      screen.getByRole("combobox", { name: "Review decision" }).textContent,
    ).toContain("Comment");
  });

  it("sends the selected event and modal summary only on Submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <FinishReviewDialog
        open
        onClose={onClose}
        projection={projection}
        actions={{ busy: false, onSubmit, onDiscard: vi.fn() }}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Final review summary" }),
      { target: { value: "Only on submit" } },
    );
    await user.click(screen.getByRole("combobox", { name: "Review decision" }));
    await user.click(await screen.findByRole("option", { name: "Approve" }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("APPROVE", "Only on submit"),
    );
    // The submitted summary is not handed back to be kept.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables close, decision, and submit while a submission is in flight", () => {
    render(
      <FinishReviewDialog
        open
        onClose={vi.fn()}
        projection={projection}
        actions={{ busy: true, onSubmit: vi.fn(), onDiscard: vi.fn() }}
      />,
    );
    const submit = screen.getByRole("button", { name: "Submit review" });
    if (!(submit instanceof HTMLButtonElement))
      throw new Error("expected the submit review button");
    expect(submit.disabled).toBe(true);
    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    expect(closeButtons.length).toBeGreaterThan(0);
    const close = closeButtons[0];
    if (!(close instanceof HTMLButtonElement))
      throw new Error("expected the dialog close button");
    expect(close.disabled).toBe(true);
  });

  it("surfaces a bounded submit failure and leaves recovery outside the modal", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("write failed");
    });
    render(
      <FinishReviewDialog
        open
        onClose={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit, onDiscard: vi.fn() }}
        error="GitHub did not confirm the submission. Check GitHub before retrying."
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Final review summary" }),
      { target: { value: "Summary" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").getAttribute("data-slot")).toBe("alert"),
    );
    // The modal never hosts the recovery control; the unavailable/recovery
    // notice outside the modal owns Check GitHub again.
    expect(
      screen.queryByRole("button", { name: "Check GitHub again" }),
    ).toBeNull();
  });

  it("keeps the dialog open and names a refused submission and a refused discard", async () => {
    const refusal = () =>
      new PatchdeskApiError(
        "github_refused",
        409,
        false,
        "refused",
        "raw provider refusal",
        { error: "github_refused", cause: "unprocessable" },
      );
    const onSubmit = vi.fn(async () => {
      throw refusal();
    });
    const onDiscard = vi.fn(async () => {
      throw refusal();
    });
    render(
      <FinishReviewDialog
        open
        onClose={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit, onDiscard }}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Final review summary" }),
      { target: { value: "Summary" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "GitHub could not accept the submission as sent.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard review" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "GitHub could not accept the discard as sent.",
      ),
    );
  });

  it("shows human decision labels in the closed select and submits uppercase values", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <FinishReviewDialog
        open
        onClose={vi.fn()}
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
    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("APPROVE", ""),
    );
  });

  it("keeps Discard in a separate footer group from Close and Submit", () => {
    render(
      <FinishReviewDialog
        open
        onClose={vi.fn()}
        projection={projection}
        actions={{ busy: false, onSubmit: vi.fn(), onDiscard: vi.fn() }}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Finish review" });
    const dangerGroup = dialog.querySelector(
      "[data-finish-review-actions-danger]",
    );
    const primaryGroup = dialog.querySelector(
      "[data-finish-review-actions-primary]",
    );
    expect(dangerGroup).not.toBeNull();
    expect(primaryGroup).not.toBeNull();
    expect(dangerGroup?.textContent).toContain("Discard review");
    expect(dangerGroup?.textContent).not.toContain("Submit review");
    expect(dangerGroup?.textContent).not.toContain("Close");
    expect(primaryGroup?.textContent).toContain("Close");
    expect(primaryGroup?.textContent).toContain("Submit review");
    expect(primaryGroup?.textContent).not.toContain("Discard");
  });
});
