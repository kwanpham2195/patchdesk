// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
