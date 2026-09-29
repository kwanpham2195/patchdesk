// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
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
  head: { kind: "branch", branch: "feature" },
  configured: true,
};
const linked = {
  path: "/work/pd-ux-pass",
  name: "pd-ux-pass",
  head: { kind: "branch", branch: "docs/ux" },
  configured: false,
};
/** `feature`, three commits past `main`, with `develop` and the remote-tracking `origin/main` also listed. */
const featureBranches = {
  head: { kind: "branch", branch: "feature" },
  branches: ["develop", "main"],
  remoteBranches: ["origin/main"],
  defaultBranch: "main",
  inferred: { baseBranch: "main", commitsBack: 3 },
  reviewedBases: [],
};

function branchesPath(checkout: string | undefined): string {
  return checkout === undefined
    ? "/v1/reviews/local-branches?profileId=acme"
    : `/v1/reviews/local-branches?profileId=acme&checkout=${encodeURIComponent(checkout)}`;
}

function install(
  checkouts: ReadonlyArray<typeof configured>,
  branches: (path: string) => RawJsonValue = () => featureBranches,
): void {
  installed = installDesktopDouble({
    "/v1/reviews/local-checkouts": () => success([...checkouts]),
    "/v1/reviews/local-branches": (input) => success(branches(input.path)),
  });
}

function renderAction(
  onOpen: (source: LocalReviewSourceInput) => Promise<void>,
) {
  render(
    <OpenLocalReviewAction
      repositoryLabel="octo-org/patchdesk"
      checkoutsPath={checkoutsPath}
      branchesPath={branchesPath}
      onOpen={onOpen}
    />,
  );
}

afterEach(() => {
  cleanup();
  installed?.restore();
  installed = undefined;
});

describe("Open a local review", () => {
  it("opens the branch's shared Review against the inferred base, says why it was picked, and closes once open", async () => {
    install([configured]);
    const user = userEvent.setup();
    const opened: Array<LocalReviewSourceInput> = [];
    renderAction(async (source) => {
      opened.push(source);
    });

    await user.click(screen.getByRole("button", { name: "Local review" }));
    const base = await screen.findByRole("combobox", { name: "Base branch" });
    expect(base).toHaveProperty("value", "main");
    expect(screen.getByText(/3 commits back/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open review" }));

    expect(opened).toEqual([
      {
        kind: "local_branch",
        baseRef: "refs/heads/main",
        expectedHead: { kind: "branch", branch: "feature" },
      },
    ]);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens against the base the maintainer picks instead of the inferred one", async () => {
    install([configured]);
    const user = userEvent.setup();
    const opened: Array<LocalReviewSourceInput> = [];
    renderAction(async (source) => {
      opened.push(source);
    });

    await user.click(screen.getByRole("button", { name: "Local review" }));
    await screen.findByRole("combobox", { name: "Base branch" });
    await user.click(
      screen.getByRole("button", { name: "Open base branch options" }),
    );
    await user.click(await screen.findByRole("option", { name: "develop" }));
    expect(screen.queryByText(/commits back/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open review" }));

    expect(opened).toEqual([
      {
        kind: "local_branch",
        baseRef: "refs/heads/develop",
        expectedHead: { kind: "branch", branch: "feature" },
      },
    ]);
  });

  it("searches local and remote-tracking branches in one list and opens against the remote one picked (#591)", async () => {
    install([configured]);
    const user = userEvent.setup();
    const opened: Array<LocalReviewSourceInput> = [];
    renderAction(async (source) => {
      opened.push(source);
    });

    await user.click(screen.getByRole("button", { name: "Local review" }));
    const base = await screen.findByRole("combobox", { name: "Base branch" });
    await user.clear(base);
    await user.type(base, "main");
    const local = await screen.findByRole("group", { name: "Local branches" });
    const remote = screen.getByRole("group", { name: "Remote branches" });
    expect(
      within(local)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["main"]);
    await user.click(
      within(remote).getByRole("option", { name: "origin/main" }),
    );
    await user.click(screen.getByRole("button", { name: "Open review" }));

    expect(opened).toEqual([
      {
        kind: "local_branch",
        baseRef: "refs/remotes/origin/main",
        expectedHead: { kind: "branch", branch: "feature" },
      },
    ]);
  });

  it("offers no open on a lone branch, which has no base to compare with", async () => {
    install([configured], () => ({
      head: { kind: "branch", branch: "main" },
      branches: [],
      remoteBranches: [],
      defaultBranch: "main",
      reviewedBases: [],
    }));
    const user = userEvent.setup();
    renderAction(async () => undefined);

    await user.click(screen.getByRole("button", { name: "Local review" }));
    // The listing has loaded once the dialog names the lone branch.
    await screen.findByText(/main is the only branch/);

    expect(screen.queryByRole("combobox", { name: "Base branch" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open review" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("keeps the picker open with the refusal when the checkout cannot be read", async () => {
    install([configured]);
    const user = userEvent.setup();
    renderAction(async () => {
      throw new Error("The working tree has unresolved merge conflicts.");
    });

    await user.click(screen.getByRole("button", { name: "Local review" }));
    await screen.findByRole("combobox", { name: "Base branch" });
    await user.click(screen.getByRole("button", { name: "Open review" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The working tree has unresolved merge conflicts.",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("reads the branches of the checkout picked, defaulting to the configured one (#489)", async () => {
    install([configured, linked], (path) =>
      path.includes("checkout=")
        ? {
            head: { kind: "branch", branch: "docs/ux" },
            branches: ["feature", "main"],
            remoteBranches: [],
            inferred: { baseBranch: "main", commitsBack: 1 },
            reviewedBases: [],
          }
        : featureBranches,
    );
    const user = userEvent.setup();
    const opened: Array<LocalReviewSourceInput> = [];
    renderAction(async (source) => {
      opened.push(source);
      throw new Error("kept open");
    });

    await user.click(screen.getByRole("button", { name: "Local review" }));
    const picker = await screen.findByRole("combobox", { name: "Checkout" });
    await screen.findByRole("combobox", { name: "Base branch" });
    await user.click(screen.getByRole("button", { name: "Open review" }));
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /pd-ux-pass/ }));
    await vi.waitFor(() =>
      expect(screen.getByText(/1 commit back/)).toBeTruthy(),
    );
    await user.click(screen.getByRole("button", { name: "Open review" }));

    expect(opened).toEqual([
      {
        kind: "local_branch",
        baseRef: "refs/heads/main",
        expectedHead: { kind: "branch", branch: "feature" },
      },
      {
        kind: "local_branch",
        baseRef: "refs/heads/main",
        expectedHead: { kind: "branch", branch: "docs/ux" },
        checkout: "/work/pd-ux-pass",
      },
    ]);
  });

  it("offers no checkout choice when the repository has one checkout", async () => {
    install([configured]);
    const user = userEvent.setup();
    renderAction(async () => undefined);

    await user.click(screen.getByRole("button", { name: "Local review" }));
    await screen.findByRole("combobox", { name: "Base branch" });

    expect(screen.queryByRole("combobox", { name: "Checkout" })).toBeNull();
  });

  it("opens one commit from the Commit tab", async () => {
    install([configured]);
    const user = userEvent.setup();
    const opened: Array<LocalReviewSourceInput> = [];
    renderAction(async (source) => {
      opened.push(source);
    });

    await user.click(screen.getByRole("button", { name: "Local review" }));
    await user.click(screen.getByRole("tab", { name: "Commit" }));
    await user.type(screen.getByLabelText("Commit SHA"), " ABCDEF12 ");
    await user.click(screen.getByRole("button", { name: "Open review" }));

    expect(opened).toEqual([{ kind: "commit", commit: "abcdef12" }]);
  });
});
