// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { pending, projection } from "./review-workbench-fixtures";

/**
 * The wiring a hook test cannot see: the Finish review dialog hands its
 * summary to `usePendingReviewActions`, and the workbench turns a kept
 * summary into the app's leave guard (#606).
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

describe("ReviewWorkbenchFlow kept Finish review summary", () => {
  it("keeps the summary and decision after Escape and guards leaving until Submit review", async () => {
    const request = bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/reviews/pending-review/command")
        return { pendingReview: pending("none") };
      throw new Error(input.path);
    });
    const navigation = vi.fn();
    render(
      <ReviewWorkbenchFlow
        // SAFETY: `pending("pending")` is wider fixture data than the strict
        // `pendingReview` union; it is not a runtime-decoded value.
        workbench={projection({ pendingReview: pending("pending") as never })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={navigation}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Finish review/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Final review summary" }),
      "Kept summary",
    );
    await user.click(screen.getByRole("combobox", { name: "Review decision" }));
    await user.click(await screen.findByRole("option", { name: "Approve" }));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Finish review" }),
      ).toBeNull(),
    );
    expect(navigation).toHaveBeenLastCalledWith("dirty_draft");

    await user.click(screen.getByRole("button", { name: /Finish review/ }));
    const summary = screen.getByRole("textbox", {
      name: "Final review summary",
    });
    if (!(summary instanceof HTMLTextAreaElement))
      throw new Error("expected the final review summary textarea");
    expect(summary.value).toBe("Kept summary");
    expect(
      screen.getByRole("combobox", { name: "Review decision" }).textContent,
    ).toContain("Approve");
    await user.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() => expect(navigation).toHaveBeenLastCalledWith("clear"));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/reviews/pending-review/command",
        body: expect.objectContaining({
          command: expect.objectContaining({
            _tag: "Submit",
            event: "APPROVE",
            summaryBody: "Kept summary",
          }),
        }),
      }),
    );
  });
});
