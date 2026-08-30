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

import { SummaryReviewDialog } from "../../src/renderer/src/components/summary-review-dialog";

afterEach(cleanup);

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred resolve was not initialized");
  };
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function expectDisabled(element: HTMLElement): void {
  if (
    !(element instanceof HTMLButtonElement) &&
    !(element instanceof HTMLTextAreaElement)
  )
    throw new Error("expected a disableable control");
  expect(element.disabled).toBe(true);
}

describe("SummaryReviewDialog", () => {
  it("shows pending submit feedback and disables conflicting controls", async () => {
    const submitted = deferred<{
      readonly state: "confirmed";
      readonly receipt: {
        readonly reviewId: string;
        readonly event: "COMMENT";
      };
    }>();
    const onSubmit = vi.fn(() => submitted.promise);
    render(
      <SummaryReviewDialog
        open
        busy={false}
        state="idle"
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onRecover={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Review summary" }), {
      target: { value: "Pending summary" },
    });

    const submit = screen.getByRole("button", { name: "Submit review" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    const pendingSubmit = screen.getByRole("button", { name: /Submitting…$/ });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expectDisabled(pendingSubmit);
    expect(within(pendingSubmit).getByRole("status")).toBeTruthy();
    const close = screen.getAllByRole("button", { name: "Close" })[0];
    if (close === undefined)
      throw new Error("expected the dialog close action");
    expectDisabled(close);
    expectDisabled(screen.getByRole("textbox", { name: "Review summary" }));
    expectDisabled(screen.getByRole("combobox", { name: "Review decision" }));

    submitted.resolve({
      state: "confirmed",
      receipt: { reviewId: "9002", event: "COMMENT" },
    });
    await submitted.promise;
  });

  it("shows pending recovery feedback and disables conflicting controls", async () => {
    const recovered = deferred<{ readonly state: "idle" }>();
    const onRecover = vi.fn(() => recovered.promise);
    const onOpenPullRequest = vi.fn();
    render(
      <SummaryReviewDialog
        open
        busy={false}
        state="recovery_required"
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onRecover={onRecover}
        onOpenPullRequest={onOpenPullRequest}
      />,
    );

    const check = screen.getByRole("button", { name: "Check GitHub status" });
    fireEvent.click(check);
    fireEvent.click(check);

    const pendingCheck = screen.getByRole("button", { name: /Checking…$/ });
    expect(onRecover).toHaveBeenCalledTimes(1);
    expectDisabled(pendingCheck);
    expect(within(pendingCheck).getByRole("status")).toBeTruthy();
    const close = screen.getAllByRole("button", { name: "Close" })[0];
    if (close === undefined)
      throw new Error("expected the dialog close action");
    expectDisabled(close);
    expectDisabled(
      screen.getByRole("button", { name: "Open pull request on GitHub" }),
    );

    recovered.resolve({ state: "idle" });
    await recovered.promise;
  });

  it.each(["rejected", "uncertain", "malformed"])(
    "preserves the decision and body after a %s response",
    async (outcome) => {
      const user = userEvent.setup();
      const props = {
        open: true,
        busy: false,
        onOpenChange: vi.fn(),
        onSubmit: vi.fn(async () => {
          throw new Error(outcome);
        }),
        onRecover: vi.fn(async () => ({ state: "idle" as const })),
      };
      const { rerender } = render(
        <SummaryReviewDialog {...props} state="idle" />,
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "Review summary" }),
        { target: { value: "Keep this draft" } },
      );
      await user.click(
        screen.getByRole("combobox", { name: "Review decision" }),
      );
      await user.click(await screen.findByRole("option", { name: "Approve" }));
      await user.click(screen.getByRole("button", { name: "Submit review" }));

      if (outcome !== "rejected") {
        rerender(
          <SummaryReviewDialog
            {...props}
            state="recovery_required"
            recoveryResolution="check_required"
          />,
        );
        rerender(<SummaryReviewDialog {...props} state="idle" />);
      }

      const body = screen.getByRole("textbox", { name: "Review summary" });
      if (!(body instanceof HTMLTextAreaElement))
        throw new Error("expected the review summary textarea");
      expect(body.value).toBe("Keep this draft");
      expect(
        screen.getByRole("combobox", { name: "Review decision" }).textContent,
      ).toContain("Approve");
    },
  );

  it("makes an uncertain submission recoverable before allowing another submit", async () => {
    const user = userEvent.setup();
    const onRecover = vi.fn(async () => ({ state: "idle" as const }));
    const onSubmit = vi.fn(async () => ({
      state: "confirmed" as const,
      receipt: { reviewId: "9002", event: "COMMENT" as const },
    }));
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

    expect(
      screen.getByText("Review submission needs confirmation"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Check GitHub status" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit review" })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Check GitHub status" }),
    );
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
    fireEvent.change(screen.getByRole("textbox", { name: "Review summary" }), {
      target: { value: "Recovered summary" },
    });
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    expect(onSubmit).toHaveBeenCalledWith("COMMENT", "Recovered summary");
  });
  it("keeps the confirmed receipt open until the maintainer closes it", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn(async () => ({
      state: "confirmed" as const,
      receipt: { reviewId: "9002", event: "COMMENT" as const },
    }));
    const { rerender } = render(
      <SummaryReviewDialog
        open
        busy={false}
        state="idle"
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        onRecover={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Review summary" }), {
      target: { value: "Published" },
    });
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    rerender(
      <SummaryReviewDialog
        open
        busy={false}
        state="confirmed"
        receipt={{ reviewId: "9002", event: "COMMENT" }}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        onRecover={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "was published to GitHub.",
    );
    expect(screen.getByRole("status").textContent).not.toContain("Refresh");
  });
  it("shows the new confirmation after Write another review submits", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => ({
      state: "confirmed" as const,
      receipt: { reviewId: "9003", event: "APPROVE" as const },
    }));
    const { rerender } = render(
      <SummaryReviewDialog
        open
        busy={false}
        state="confirmed"
        receipt={{ reviewId: "9002", event: "COMMENT" }}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onRecover={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Write another review" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Review summary" }), {
      target: { value: "Approve" },
    });
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    rerender(
      <SummaryReviewDialog
        open
        busy={false}
        state="confirmed"
        receipt={{ reviewId: "9003", event: "APPROVE" }}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onRecover={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("#9003");
    expect(screen.queryByRole("button", { name: "Submit review" })).toBeNull();
  });
});
