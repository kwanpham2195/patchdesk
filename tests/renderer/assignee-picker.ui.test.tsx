// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssigneePicker } from "../../src/renderer/src/components/assignee-picker";
import type { AssignableUserListResponse } from "../../src/renderer/src/renderer-contracts";

/**
 * What only a mounted `AssigneePicker` can show, and only this one: that it
 * renders nothing without actions, that it states GitHub's ten-assignee cap
 * up front, that it draws each person with the avatar the response carried,
 * that its controls reach `useGithubItemPicker` and its commands go out in
 * this surface's `[{id, login}]` shape, and that a denied permission reaches
 * the rows.
 *
 * The state machine behind those controls is proved once in
 * `use-github-item-picker.test.ts`; the rendering contract this picker shares
 * with the other two — the write-failure alert, the forbidden read's reason,
 * the permission caveat, the truncation note — is proved once per picker in
 * `github-item-picker.rendering.test.tsx`.
 */

afterEach(() => cleanup());

// A tiny, obviously-fake `data:` URI, enough for `Avatar` to take its
// `<img>` branch instead of the initials-badge one.
const FIXTURE_AVATAR_DATA_URI = "data:image/png;base64,AAAA";

const assignableUsers: AssignableUserListResponse = {
  state: "ready",
  users: [
    { id: "U_bug", login: "octocat", avatarDataUri: FIXTURE_AVATAR_DATA_URI },
    { id: "U_docs", login: "hubot" },
  ],
  totalCount: 2,
  permission: "permitted",
};

type FetchList = () => Promise<AssignableUserListResponse | undefined>;

function actionsFixture(
  fetchAssignableUsers: FetchList = async () => assignableUsers,
) {
  return {
    fetchAssignableUsers: vi.fn(fetchAssignableUsers),
    addAssignees: vi.fn(async () => undefined),
    removeAssignees: vi.fn(async () => undefined),
  };
}

/** The row for one candidate, by the label its checkbox carries. */
const checkbox = (name: string): HTMLElement =>
  screen.getByRole("checkbox", { name });

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Manage assignees" }));
}

describe("AssigneePicker", () => {
  it("renders nothing when the Review can no longer accept assignee writes", () => {
    const { container } = render(<AssigneePicker attachedAssignees={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("opens onto the assignable people the service returned, keyed by login, with the ten-assignee limit stated up front and each resolved avatar drawn", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(
      <AssigneePicker attachedAssignees={["octocat"]} actions={actions} />,
    );
    await openPicker(user);
    await screen.findByRole("checkbox", { name: "octocat" });
    expect(
      document.querySelector('[data-slot="picker-cap"]')?.textContent,
    ).toContain("10");
    expect(checkbox("octocat").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("hubot").getAttribute("aria-checked")).toBe("false");
    // One row carried an avatar `data:` URI and one did not, so the picker
    // must pass each row's own `avatarDataUri` through to `Avatar`.
    expect(document.querySelectorAll('[data-slot="avatar"]')).toHaveLength(2);
    expect(document.querySelectorAll('img[data-slot="avatar"]')).toHaveLength(
      1,
    );
  });

  it("sends each toggled row to the assignee command for its own direction, in this surface's own shape, and the search box to its own fetch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({
      advanceTimers: (ms) => vi.advanceTimersByTime(ms),
    });
    const actions = actionsFixture();
    render(
      <AssigneePicker attachedAssignees={["octocat"]} actions={actions} />,
    );
    await openPicker(user);
    await user.click(await screen.findByRole("checkbox", { name: "hubot" }));
    await waitFor(() =>
      expect(actions.addAssignees).toHaveBeenCalledWith([
        { id: "U_docs", login: "hubot" },
      ]),
    );
    expect(actions.removeAssignees).not.toHaveBeenCalled();
    await user.click(checkbox("octocat"));
    await waitFor(() =>
      expect(actions.removeAssignees).toHaveBeenCalledWith([
        { id: "U_bug", login: "octocat" },
      ]),
    );
    expect(actions.addAssignees).toHaveBeenCalledOnce();
    await user.type(
      screen.getByRole("searchbox", { name: "Search assignable people" }),
      "hub",
    );
    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() =>
      expect(actions.fetchAssignableUsers).toHaveBeenCalledWith("hub"),
    );
    vi.useRealTimers();
  });

  it("shows a denied permission on the rows themselves, not only in the hook", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture(async () => ({
      ...assignableUsers,
      permission: "denied" as const,
    }));
    render(<AssigneePicker attachedAssignees={[]} actions={actions} />);
    await openPicker(user);
    await screen.findByRole("checkbox", { name: "hubot" });
    expect(
      document.querySelector('[data-slot="picker-permission-denied"]'),
    ).toBeTruthy();
    expect(checkbox("hubot").getAttribute("aria-disabled")).toBe("true");
  });
});
