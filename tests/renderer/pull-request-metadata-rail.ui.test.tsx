// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestMetadataRail } from "../../src/renderer/src/components/pull-request-metadata-rail";

afterEach(() => cleanup());

function renderRail(assignSelf: () => Promise<ReadonlyArray<string>>) {
  return render(
    <PullRequestMetadataRail
      labels={[]}
      assignees={[]}
      requestedReviewers={[]}
      freshness="fresh"
      refreshedAt="2026-01-01T00:00:00.000Z"
      terminal={false}
      assigneeActions={{
        fetchAssignableUsers: async () => ({
          state: "ready",
          users: [],
          totalCount: 0,
          permission: "permitted",
        }),
        addAssignees: async () => undefined,
        removeAssignees: async () => undefined,
        assignSelf,
      }}
    />,
  );
}

describe("PullRequestMetadataRail assign yourself", () => {
  it("admits once synchronously and shows only confirmed identity", async () => {
    let confirm: (value: ReadonlyArray<string>) => void = () => undefined;
    const assignSelf = vi.fn(
      async () =>
        await new Promise<ReadonlyArray<string>>((resolve) => {
          confirm = resolve;
        }),
    );
    renderRail(assignSelf);
    const button = await screen.findByRole("button", {
      name: "Assign yourself",
    });
    act(() => {
      button.click();
      button.click();
    });
    expect(assignSelf).toHaveBeenCalledOnce();
    const pending = screen.getByRole("button", { name: /Assigning/ });
    expect(pending.getAttribute("disabled")).not.toBeNull();
    expect(
      pending.querySelector('[role="status"][data-icon="inline-start"]'),
    ).not.toBeNull();
    expect(screen.queryByText("octocat")).toBeNull();
    confirm(["octocat"]);
    await screen.findByText("octocat");
  });

  it("keeps absence and shows a local error after rejection", async () => {
    const user = userEvent.setup();
    renderRail(async () => {
      throw new Error("rejected");
    });
    await user.click(
      await screen.findByRole("button", { name: "Assign yourself" }),
    );
    expect((await screen.findByRole("alert")).getAttribute("data-slot")).toBe(
      "inline-error",
    );
    expect(screen.queryByText("octocat")).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Assign yourself" }),
      ).not.toBeNull(),
    );
  });
});

describe("PullRequestMetadataRail reviewers on a terminal Review", () => {
  function renderTerminalRail(requestedReviewers: ReadonlyArray<string>) {
    return render(
      <PullRequestMetadataRail
        labels={[]}
        assignees={[]}
        requestedReviewers={requestedReviewers}
        freshness="fresh"
        refreshedAt="2026-01-01T00:00:00.000Z"
        terminal
      />,
    );
  }

  it("shows the stored requested reviewers without loading", () => {
    renderTerminalRail(["octocat", "hubot"]);
    const reviewers = screen.getByRole("region", { name: "Reviewers" });
    expect(within(reviewers).queryByRole("status")).toBeNull();
    const list = within(reviewers).getByRole("list", {
      name: "Pull request reviewers",
    });
    expect(within(list).getByText("octocat")).not.toBeNull();
    expect(within(list).getByText("hubot")).not.toBeNull();
    expect(within(reviewers).queryByRole("button")).toBeNull();
  });

  it("shows no loading state when nobody was requested", () => {
    renderTerminalRail([]);
    const reviewers = screen.getByRole("region", { name: "Reviewers" });
    expect(within(reviewers).queryByRole("status")).toBeNull();
    expect(within(reviewers).queryByRole("list")).toBeNull();
  });
});

describe("PullRequestMetadataRail re-request review", () => {
  function renderReviewers(
    requestReviewers: (
      reviewers: ReadonlyArray<{ readonly id: string; readonly login: string }>,
    ) => Promise<void>,
    permission: "permitted" | "denied" = "permitted",
  ) {
    return render(
      <PullRequestMetadataRail
        labels={[]}
        assignees={[]}
        requestedReviewers={[]}
        freshness="fresh"
        refreshedAt="2026-01-01T00:00:00.000Z"
        terminal={false}
        reviewerActions={{
          fetchReviewers: async () => ({
            state: "ready",
            reviewers: [
              { login: "octocat", verdict: "approved", outdated: true },
              { login: "hubot", outdated: false },
            ],
            candidates: [{ id: "U_1", login: "octocat" }],
            candidatesTotalCount: 1,
            permission,
          }),
          requestReviewers,
          removeReviewers: async () => undefined,
        }}
      />,
    );
  }

  it("re-requests the reviewer who already answered, by node id", async () => {
    const user = userEvent.setup();
    const requestReviewers = vi.fn(async () => undefined);
    renderReviewers(requestReviewers);
    await user.click(
      await screen.findByRole("button", {
        name: "Re-request review from octocat",
      }),
    );
    expect(requestReviewers).toHaveBeenCalledExactlyOnceWith([
      { id: "U_1", login: "octocat" },
    ]);
  });

  it("offers no re-request to a reviewer who has not answered", async () => {
    renderReviewers(async () => undefined);
    await screen.findByRole("button", {
      name: "Re-request review from octocat",
    });
    expect(
      screen.queryByRole("button", { name: "Re-request review from hubot" }),
    ).toBeNull();
  });

  it("keeps the control usable and shows a local error after rejection", async () => {
    const user = userEvent.setup();
    renderReviewers(async () => {
      throw new Error("rejected");
    });
    await user.click(
      await screen.findByRole("button", {
        name: "Re-request review from octocat",
      }),
    );
    expect((await screen.findByRole("alert")).getAttribute("data-slot")).toBe(
      "inline-error",
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Re-request review from octocat" })
          .getAttribute("disabled"),
      ).toBeNull(),
    );
  });

  it("offers no re-request without write permission", async () => {
    renderReviewers(async () => undefined, "denied");
    const reviewers = screen.getByRole("region", { name: "Reviewers" });
    await within(reviewers).findByText("octocat");
    expect(
      screen.queryByRole("button", { name: "Re-request review from octocat" }),
    ).toBeNull();
  });
});
