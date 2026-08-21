// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssigneePicker } from "../../src/renderer/src/components/assignee-picker";
import { PatchdeskApiError } from "../../src/renderer/src/api-client";
import type { AssignableUserListResponse } from "../../src/renderer/src/renderer-contracts";

afterEach(() => cleanup());

// A tiny, obviously-fake `data:` URI standing in for a resolved avatar --
// enough for `Avatar` to take the `<img>` branch instead of the
// initials-badge one.
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

function actionsFixture(
  overrides: Partial<{
    fetchAssignableUsers: (
      query?: string,
    ) => Promise<AssignableUserListResponse | undefined>;
    addAssignees: (
      assignees: ReadonlyArray<{
        readonly id: string;
        readonly login: string;
      }>,
    ) => Promise<void>;
    removeAssignees: (
      assignees: ReadonlyArray<{
        readonly id: string;
        readonly login: string;
      }>,
    ) => Promise<void>;
  }> = {},
) {
  return {
    fetchAssignableUsers: vi.fn(async () => assignableUsers),
    addAssignees: vi.fn(async () => undefined),
    removeAssignees: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Manage assignees" }));
}

describe("AssigneePicker", () => {
  it("renders nothing when the Review can no longer accept assignee writes", () => {
    const { container } = render(<AssigneePicker attachedAssignees={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("states the ten-assignee limit up front", async () => {
    const user = userEvent.setup();
    render(
      <AssigneePicker attachedAssignees={[]} actions={actionsFixture()} />,
    );
    await openPicker(user);
    expect(
      await screen.findByText(
        "GitHub allows up to 10 assignees on a pull request.",
      ),
    ).toBeTruthy();
  });

  it("renders currently assigned people as checked and other assignable people as available", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(
      <AssigneePicker attachedAssignees={["octocat"]} actions={actions} />,
    );
    await openPicker(user);
    await waitFor(() =>
      expect(actions.fetchAssignableUsers).toHaveBeenCalledOnce(),
    );
    const octocatCheckbox = await screen.findByRole("checkbox", {
      name: "octocat",
    });
    const hubotCheckbox = screen.getByRole("checkbox", { name: "hubot" });
    expect(octocatCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(hubotCheckbox.getAttribute("aria-checked")).toBe("false");
  });

  it("renders a candidate's resolved avatar as an <img>, and initials for a candidate without one", async () => {
    const user = userEvent.setup();
    render(
      <AssigneePicker attachedAssignees={[]} actions={actionsFixture()} />,
    );
    await openPicker(user);
    const octocatCheckbox = await screen.findByRole("checkbox", {
      name: "octocat",
    });
    const octocatRow = octocatCheckbox.closest("li");
    expect(octocatRow).toBeTruthy();
    const octocatAvatar = octocatRow?.querySelector('[data-slot="avatar"]');
    expect(octocatAvatar?.tagName).toBe("IMG");
    expect(octocatAvatar?.getAttribute("src")).toBe(FIXTURE_AVATAR_DATA_URI);

    const hubotCheckbox = screen.getByRole("checkbox", { name: "hubot" });
    const hubotRow = hubotCheckbox.closest("li");
    const hubotAvatar = hubotRow?.querySelector('[data-slot="avatar"]');
    expect(hubotAvatar?.tagName).toBe("SPAN");
  });

  it("issues an add-assignees command with the toggled person's id and login", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(<AssigneePicker attachedAssignees={[]} actions={actions} />);
    await openPicker(user);
    const hubotCheckbox = await screen.findByRole("checkbox", {
      name: "hubot",
    });
    await user.click(hubotCheckbox);
    await waitFor(() =>
      expect(actions.addAssignees).toHaveBeenCalledWith([
        { id: "U_docs", login: "hubot" },
      ]),
    );
    expect(actions.removeAssignees).not.toHaveBeenCalled();
  });

  it("issues a remove-assignees command with the toggled person's id and login", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(
      <AssigneePicker attachedAssignees={["octocat"]} actions={actions} />,
    );
    await openPicker(user);
    const octocatCheckbox = await screen.findByRole("checkbox", {
      name: "octocat",
    });
    await user.click(octocatCheckbox);
    await waitFor(() =>
      expect(actions.removeAssignees).toHaveBeenCalledWith([
        { id: "U_bug", login: "octocat" },
      ]),
    );
    expect(actions.addAssignees).not.toHaveBeenCalled();
  });

  it("shows the toggled person immediately (optimistic) and reconciles once the authoritative assignees arrive", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    const { rerender } = render(
      <AssigneePicker attachedAssignees={[]} actions={actions} />,
    );
    await openPicker(user);
    const hubotCheckbox = await screen.findByRole("checkbox", {
      name: "hubot",
    });
    await user.click(hubotCheckbox);
    expect(
      screen
        .getByRole("checkbox", { name: "hubot" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await waitFor(() => expect(actions.addAssignees).toHaveBeenCalledOnce());
    rerender(
      <AssigneePicker attachedAssignees={["hubot"]} actions={actions} />,
    );
    expect(
      screen
        .getByRole("checkbox", { name: "hubot" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("reverts a failed write and names the person instead of silently reverting", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      addAssignees: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    render(<AssigneePicker attachedAssignees={[]} actions={actions} />);
    await openPicker(user);
    const hubotCheckbox = await screen.findByRole("checkbox", {
      name: "hubot",
    });
    await user.click(hubotCheckbox);
    await waitFor(() =>
      expect(
        screen
          .getByRole("checkbox", { name: "hubot" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(
      await screen.findByText('Patchdesk could not assign "hubot".'),
    ).toBeTruthy();
  });

  it("surfaces the ten-assignee limit by name when GitHub rejects a write for it", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      addAssignees: vi.fn(async () => {
        throw new PatchdeskApiError(
          "assignee_cap_exceeded",
          400,
          false,
          "corr-cap",
          "GitHub limits a pull request to ten assignees.",
        );
      }),
    });
    render(<AssigneePicker attachedAssignees={[]} actions={actions} />);
    await openPicker(user);
    const hubotCheckbox = await screen.findByRole("checkbox", {
      name: "hubot",
    });
    await user.click(hubotCheckbox);
    expect(
      await screen.findByText(
        'Patchdesk could not assign "hubot". GitHub limits a pull request to ten assignees.',
      ),
    ).toBeTruthy();
  });

  it("fully enables the picker with no caveat when the service reports 'permitted'", async () => {
    const user = userEvent.setup();
    render(
      <AssigneePicker attachedAssignees={[]} actions={actionsFixture()} />,
    );
    await openPicker(user);
    const octocatCheckbox = await screen.findByRole("checkbox", {
      name: "octocat",
    });
    expect(octocatCheckbox.getAttribute("aria-disabled")).not.toBe("true");
    expect(
      screen.queryByText(
        "This account cannot manage assignees on this repository.",
      ),
    ).toBeNull();
    expect(
      screen.queryByText(
        "Patchdesk could not confirm you can manage assignees here — a change may be refused.",
      ),
    ).toBeNull();
  });

  it("shows the honest unconfirmed caveat, without hiding or disabling the picker, when permission evidence is unavailable", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      fetchAssignableUsers: vi.fn(async () => ({
        ...assignableUsers,
        permission: "unknown" as const,
      })),
    });
    render(<AssigneePicker attachedAssignees={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "Patchdesk could not confirm you can manage assignees here — a change may be refused.",
      ),
    ).toBeTruthy();
    const octocatCheckbox = screen.getByRole("checkbox", { name: "octocat" });
    expect(octocatCheckbox.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("disables the picker and states the account cannot manage assignees, with no retry, when the service reports 'denied'", async () => {
    const user = userEvent.setup();
    const addAssignees = vi.fn(async () => undefined);
    const actions = actionsFixture({
      fetchAssignableUsers: vi.fn(async () => ({
        ...assignableUsers,
        permission: "denied" as const,
      })),
      addAssignees,
    });
    render(<AssigneePicker attachedAssignees={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "This account cannot manage assignees on this repository.",
      ),
    ).toBeTruthy();
    const hubotCheckbox = screen.getByRole("checkbox", { name: "hubot" });
    expect(hubotCheckbox.getAttribute("aria-disabled")).toBe("true");
    await user.click(hubotCheckbox);
    expect(addAssignees).not.toHaveBeenCalled();
  });

  it("shows a forbidden read's specific reason instead of an empty list", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      fetchAssignableUsers: vi.fn(async () => ({
        state: "github_forbidden" as const,
        forbiddenReason: "saml" as const,
      })),
    });
    render(<AssigneePicker attachedAssignees={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "GitHub blocked this read: this account's token needs SAML single sign-on authorization.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("reads a failed fetch as a failure, not an empty list", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      fetchAssignableUsers: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    render(<AssigneePicker attachedAssignees={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "Patchdesk could not load this repository's assignable people. Reopen this menu to retry.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("makes truncation visible when totalCount exceeds the returned people", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      fetchAssignableUsers: vi.fn(async () => ({
        state: "ready" as const,
        users: [{ id: "U_bug", login: "octocat" }],
        totalCount: 150,
      })),
    });
    render(<AssigneePicker attachedAssignees={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "Showing 1 of 150 people. Some assignable people aren't shown.",
      ),
    ).toBeTruthy();
  });

  it("sends the search box's value to fetchAssignableUsers, debounced, once typing settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({
      advanceTimers: (ms) => vi.advanceTimersByTime(ms),
    });
    const actions = actionsFixture();
    render(<AssigneePicker attachedAssignees={[]} actions={actions} />);
    await openPicker(user);
    await waitFor(() =>
      expect(actions.fetchAssignableUsers).toHaveBeenCalledWith(undefined),
    );
    const search = screen.getByRole("searchbox", {
      name: "Search assignable people",
    });
    await user.type(search, "hub");
    // Not yet, before the debounce window elapses.
    expect(actions.fetchAssignableUsers).not.toHaveBeenCalledWith("hub");
    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() =>
      expect(actions.fetchAssignableUsers).toHaveBeenCalledWith("hub"),
    );
    vi.useRealTimers();
  });

  it("never lets a slow, stale response overwrite a newer one", async () => {
    let resolveFirst: (
      value: AssignableUserListResponse | undefined,
    ) => void = () => undefined;
    const first = new Promise<AssignableUserListResponse | undefined>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    const fetchAssignableUsers = vi
      .fn<(query?: string) => Promise<AssignableUserListResponse | undefined>>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(async () => ({
        state: "ready",
        users: [{ id: "U_docs", login: "hubot" }],
        totalCount: 1,
        permission: "permitted",
      }));
    const actions = actionsFixture({ fetchAssignableUsers });
    render(<AssigneePicker attachedAssignees={[]} actions={actions} />);
    const user = userEvent.setup();
    await openPicker(user);
    await waitFor(() => expect(fetchAssignableUsers).toHaveBeenCalledTimes(1));
    // Force a second request while the first is still pending, by closing
    // and reopening the picker.
    await user.click(screen.getByRole("button", { name: "Manage assignees" }));
    await user.click(screen.getByRole("button", { name: "Manage assignees" }));
    await waitFor(() => expect(fetchAssignableUsers).toHaveBeenCalledTimes(2));
    await screen.findByRole("checkbox", { name: "hubot" });
    // The stale first response lands after the second already rendered.
    resolveFirst({
      state: "ready",
      users: [{ id: "U_bug", login: "octocat" }],
      totalCount: 1,
      permission: "permitted",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("checkbox", { name: "octocat" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "hubot" })).toBeTruthy();
  });
});
