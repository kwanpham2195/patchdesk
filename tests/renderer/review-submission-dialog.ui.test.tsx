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
    expect(screen.getByRole("dialog", { name: "Create pending review" })).toBeTruthy();
    expect(screen.getByText("P0/P1 findings are included in this review.")).toBeTruthy();
    expect(screen.getByText("src/write.ts:8")).toBeTruthy();
    expect(screen.queryByText("src/write.ts:15")).toBeNull();
    expect((screen.getByRole("button", { name: "Confirm pending review" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByLabelText("I understand this creates one pending GitHub review."));
    await user.click(screen.getByRole("button", { name: "Confirm pending review" }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Pending review 9001 created.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Submit pending review" }));
    await user.selectOptions(screen.getByLabelText("Review event"), "REQUEST_CHANGES");
    await user.clear(screen.getByLabelText("Review summary"));
    await user.type(screen.getByLabelText("Review summary"), "Request changes before merge.");
    await user.click(screen.getByLabelText("I understand this submits the pending review."));
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    expect(submit).toHaveBeenCalledWith("REQUEST_CHANGES", "Request changes before merge.");
    expect(screen.getByText("Review 9001 submitted as REQUEST_CHANGES.")).toBeTruthy();
  });

  it("does not offer a second create or submit after the session has submitted one review", () => {
    render(<ReviewSubmissionDialog draft={{ state: { _tag: "SubmittedGitHubReview", reviewId: "9001", event: "COMMENT" }, summaryBody: "Review summary", comments: [] } as never} findings={[]} onCreatePending={async () => ({ reviewId: "9001" })} onSubmitPending={async () => ({ reviewId: "9001" })} />);
    expect(screen.getByText("Review 9001 submitted as COMMENT.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create|submit/i })).toBeNull();
  });
});
