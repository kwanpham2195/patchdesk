// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChangeBaseBranchDialog } from "../../src/renderer/src/components/change-base-branch-dialog";
import type { BaseBranchChangeOutcome } from "../../src/renderer/src/flows/use-review-metadata-actions";
import type { BaseBranchReadState } from "../../src/renderer/src/hooks/use-base-branch-candidates";

afterEach(cleanup);

function readyState(
  permission: "permitted" | "denied" | "unknown",
): BaseBranchReadState {
  return {
    _tag: "ready",
    permission,
    current: "main",
    branches: ["main", "release/1.2"],
    totalCount: 2,
  };
}

function renderDialog(readState: BaseBranchReadState) {
  const onConfirm = vi.fn(
    async (_branch: string): Promise<BaseBranchChangeOutcome> => ({
      _tag: "Refreshed",
    }),
  );
  const onQueryChange = vi.fn();
  render(
    <ChangeBaseBranchDialog
      open
      onOpenChange={() => undefined}
      repository="octo-org/patchdesk"
      query=""
      onQueryChange={onQueryChange}
      readState={readState}
      onConfirm={onConfirm}
      onRefresh={async () => undefined}
    />,
  );
  return { onConfirm, onQueryChange };
}

describe("ChangeBaseBranchDialog", () => {
  it("offers the branches, keeps the current base unselectable, and confirms the picked one", async () => {
    const user = userEvent.setup();
    const { onConfirm, onQueryChange } = renderDialog(readyState("permitted"));

    expect(
      screen
        .getByRole("option", { name: /main/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    const confirm = screen.getByRole("button", { name: "Change base branch" });
    expect(confirm.getAttribute("disabled")).not.toBeNull();

    await user.type(
      screen.getByRole("combobox", { name: "Search branches" }),
      "r",
    );
    expect(onQueryChange).toHaveBeenLastCalledWith("r");

    await user.click(screen.getByRole("option", { name: "release/1.2" }));
    await user.click(confirm);
    await user.click(
      await screen.findByRole("button", { name: "Change base" }),
    );
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledExactlyOnceWith("release/1.2"),
    );
  });

  it("disables the confirm and states why when permission is denied", async () => {
    const user = userEvent.setup();
    renderDialog(readyState("denied"));
    await user.click(screen.getByRole("option", { name: "release/1.2" }));
    expect(
      screen
        .getByRole("button", { name: "Change base branch" })
        .getAttribute("disabled"),
    ).not.toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("leaves the confirm enabled with a warning when permission is unknown", async () => {
    const user = userEvent.setup();
    renderDialog(readyState("unknown"));
    await user.click(screen.getByRole("option", { name: "release/1.2" }));
    expect(
      screen
        .getByRole("button", { name: "Change base branch" })
        .getAttribute("disabled"),
    ).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});
