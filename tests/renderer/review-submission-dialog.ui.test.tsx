// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewSubmissionDialog } from "../../src/renderer/src/components/review-submission-dialog";

const draft = {
  state: { _tag: "LocalDraft" },
  summaryBody: "Review summary",
  comments: [
    { findingId: "p1", include: true, path: "src/write.ts", line: 8, body: "Keep the guard.", postability: "postable" },
    { findingId: "unmapped", include: true, path: "src/write.ts", line: 15, body: "Cannot post.", postability: "invalid_line" },
  ],
} as never;

afterEach(() => cleanup());

describe("review submission dialog", () => {
  it("requires explicit confirmation, previews only postable comments, and submits the selected event and summary", async () => {
    const user = userEvent.setup();
    const create = vi.fn(async () => ({ reviewId: "9001" }));
    const submit = vi.fn(async () => ({ reviewId: "9001" }));
    render(<ReviewSubmissionDialog draft={draft} findings={[{ id: "p1" as never, severity: "P1" }]} onCreatePending={create} onSubmitPending={submit} />);

    await user.click(screen.getByRole("button", { name: "Create pending review" }));
    expect(screen.getByRole("alertdialog", { name: "Create pending review" })).toBeTruthy();
    expect(screen.getByText("P0/P1 findings included")).toBeTruthy();
    expect(screen.getByText("src/write.ts:8")).toBeTruthy();
    expect(screen.queryByText("src/write.ts:15")).toBeNull();
    expect((screen.getByRole("button", { name: "Confirm pending review" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "I understand this creates one pending GitHub review." }));
    await user.click(screen.getByRole("button", { name: "Confirm pending review" }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Pending review 9001 created.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Submit pending review" }));
    expect(screen.getByRole("alertdialog", { name: "Submit pending review" })).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "Review event" }));
    await user.click(await screen.findByRole("option", { name: "REQUEST_CHANGES" }));
    expect(screen.getByText("Review summary")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "I understand this submits the pending review." }));
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    expect(submit).toHaveBeenCalledWith("REQUEST_CHANGES", "Review summary");
    expect(screen.getByText("Review 9001 submitted as REQUEST_CHANGES.")).toBeTruthy();
  });

  it("does not offer a second create or submit after the session has submitted one review", () => {
    render(<ReviewSubmissionDialog draft={{ state: { _tag: "SubmittedGitHubReview", reviewId: "9001", event: "COMMENT" }, summaryBody: "Review summary", comments: [] } as never} findings={[]} onCreatePending={async () => ({ reviewId: "9001" })} onSubmitPending={async () => ({ reviewId: "9001" })} />);
    expect(screen.getByText("Review 9001 submitted as COMMENT.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create|submit/i })).toBeNull();
  });

  it("keeps the dialog and editable draft visible when pending-review creation is rejected", async () => {
    const user = userEvent.setup();
    render(<ReviewSubmissionDialog draft={draft} findings={[]} onCreatePending={async () => { throw new Error("rejected"); }} onSubmitPending={async () => ({ reviewId: "9001" })} />);
    await user.click(screen.getByRole("button", { name: "Create pending review" }));
    await user.click(screen.getByRole("checkbox", { name: "I understand this creates one pending GitHub review." }));
    await user.click(screen.getByRole("button", { name: "Confirm pending review" }));
    expect(screen.getByRole("alert").textContent).toContain("GitHub rejected the pending review. Your saved local draft was preserved.");
    expect(screen.getByRole("alertdialog", { name: "Create pending review" })).toBeTruthy();
    expect(screen.getByText("Keep the guard.")).toBeTruthy();
  });

  it("reports a non-cancellable write while GitHub confirmation is pending", async () => {
    let resolveCreate: ((value: { reviewId: string }) => void) | undefined;
    const pendingStates: boolean[] = [];
    const user = userEvent.setup();
    render(<ReviewSubmissionDialog
      draft={draft}
      findings={[]}
      onCreatePending={async () => await new Promise((resolve) => { resolveCreate = resolve; })}
      onSubmitPending={async () => ({ reviewId: "9001" })}
      onPendingChange={(pending) => pendingStates.push(pending)}
    />);
    await user.click(screen.getByRole("button", { name: "Create pending review" }));
    await user.click(screen.getByRole("checkbox", { name: "I understand this creates one pending GitHub review." }));
    await user.click(screen.getByRole("button", { name: "Confirm pending review" }));

    expect(pendingStates.at(-1)).toBe(true);
    resolveCreate?.({ reviewId: "9001" });
    expect(await screen.findByText("Pending review 9001 created.")).toBeTruthy();
    expect(pendingStates.at(-1)).toBe(false);
  });
});
