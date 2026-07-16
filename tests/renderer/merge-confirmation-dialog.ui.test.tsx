// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MergeConfirmationDialog } from "../../src/renderer/src/components/merge-confirmation-dialog";

describe("merge confirmation dialog", () => {
  it("shows context and requires acknowledgement for merge warnings before one explicit merge", async () => {
    const user = userEvent.setup(); const merge = vi.fn(async () => ({ mergeCommitSha: "abcdef" }));
    render(<MergeConfirmationDialog readiness={{ _tag: "NeedsAcknowledgement", blockers: [], warnings: ["request_changes", "high_severity_finding"] }} context={{ repo: "centraldigital/patchdesk", prNumber: 42, title: "Protect review writes", base: "sit", head: "feat/review", headSha: "abcdef1234567890" }} methods={["squash", "merge"]} onMerge={merge} />);
    expect(screen.getByText("request_changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Prepare merge confirmation" }));
    expect(screen.getByRole("dialog", { name: "Confirm merge" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirm merge" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByLabelText("I acknowledge the merge warnings."));
    await user.click(screen.getByRole("button", { name: "Confirm merge" }));
    expect(merge).toHaveBeenCalledWith("squash", true);
    expect(screen.getByText("Merged abcdef.")).toBeTruthy();
  });
});
