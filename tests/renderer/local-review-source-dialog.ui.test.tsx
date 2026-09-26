// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenLocalReviewAction } from "../../src/renderer/src/components/local-review-source-dialog";
import type { LocalReviewSourceInput } from "../../src/renderer/src/flows/use-inbox-review-opening";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let installed: DesktopDouble | undefined;
const checkoutsPath = "/v1/reviews/local-checkouts?profileId=acme";
const configured = {
  path: "/work/patchdesk",
  name: "patchdesk",
  head: { kind: "branch", branch: "main" },
  configured: true,
};
const linked = {
  path: "/work/pd-ux-pass",
  name: "pd-ux-pass",
  head: { kind: "branch", branch: "docs/ux" },
  configured: false,
};

function listCheckouts(checkouts: ReadonlyArray<typeof configured>): void {
  installed = installDesktopDouble({
    "/v1/reviews/local-checkouts": () => success([...checkouts]),
  });
}

afterEach(() => {
  cleanup();
  installed?.restore();
  installed = undefined;
});

describe("Open a local review", () => {
  it("opens a branch against its base branch and closes once the Review is open", async () => {
    listCheckouts([configured]);
    const user = userEvent.setup();
    const opened: Array<LocalReviewSourceInput> = [];
    render(
      <OpenLocalReviewAction
        repositoryLabel="octo-org/patchdesk"
        checkoutsPath={checkoutsPath}
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
    listCheckouts([configured]);
    const user = userEvent.setup();
    render(
      <OpenLocalReviewAction
        repositoryLabel="octo-org/patchdesk"
        checkoutsPath={checkoutsPath}
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

  it("opens the working tree of the checkout picked, defaulting to the configured one (#489)", async () => {
    listCheckouts([configured, linked]);
    const user = userEvent.setup();
    const opened: Array<LocalReviewSourceInput> = [];
    render(
      <OpenLocalReviewAction
        repositoryLabel="octo-org/patchdesk"
        checkoutsPath={checkoutsPath}
        onOpen={async (source) => {
          opened.push(source);
          throw new Error("kept open");
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Local review" }));
    const picker = await screen.findByRole("combobox", { name: "Checkout" });
    await user.click(screen.getByRole("button", { name: "Open review" }));
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /pd-ux-pass/ }));
    await user.click(screen.getByRole("button", { name: "Open review" }));

    expect(opened).toEqual([
      { kind: "working_tree" },
      { kind: "working_tree", checkout: "/work/pd-ux-pass" },
    ]);
  });

  it("offers no checkout choice when the repository has one checkout", async () => {
    listCheckouts([configured]);
    const user = userEvent.setup();
    render(
      <OpenLocalReviewAction
        repositoryLabel="octo-org/patchdesk"
        checkoutsPath={checkoutsPath}
        onOpen={async () => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Local review" }));
    await vi.waitFor(() => expect(installed?.request).toHaveBeenCalled());

    expect(screen.queryByRole("combobox", { name: "Checkout" })).toBeNull();
  });
});
