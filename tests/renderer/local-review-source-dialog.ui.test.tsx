// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenLocalReviewAction } from "../../src/renderer/src/components/local-review-source-dialog";
import type { LocalReviewSourceInput } from "../../src/renderer/src/flows/use-inbox-review-opening";

afterEach(cleanup);

describe("Open a local review", () => {
  it("opens a branch against its base branch and closes once the Review is open", async () => {
    const user = userEvent.setup();
    const opened: Array<LocalReviewSourceInput> = [];
    render(
      <OpenLocalReviewAction
        repositoryLabel="octo-org/patchdesk"
        onOpen={async (source) => {
          opened.push(source);
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Local review" }));
    await user.click(screen.getByRole("tab", { name: "Branch" }));
    const open = screen.getByRole("button", { name: "Open review" });
    expect(open).toHaveProperty("disabled", true);
    await user.type(screen.getByLabelText("Branch"), " feature/local ");
    await user.click(open);

    expect(opened).toEqual([
      { kind: "branch", branch: "feature/local", baseBranch: "main" },
    ]);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the picker open with the refusal when the checkout cannot be read", async () => {
    const user = userEvent.setup();
    render(
      <OpenLocalReviewAction
        repositoryLabel="octo-org/patchdesk"
        onOpen={async () => {
          throw new Error("The working tree has unresolved merge conflicts.");
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Local review" }));
    await user.click(screen.getByRole("button", { name: "Open review" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The working tree has unresolved merge conflicts.",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
