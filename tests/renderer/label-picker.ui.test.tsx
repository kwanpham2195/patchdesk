// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LabelPicker } from "../../src/renderer/src/components/label-picker";
import type { RepositoryLabelListResponse } from "../../src/renderer/src/renderer-contracts";

/**
 * What only a mounted `LabelPicker` can show, and only this one: that it
 * renders nothing without actions, that it draws each repository label as a
 * chip row keyed by name (not by id, the way the two people pickers key by
 * login, and not by colour), that a toggle reaches `addLabels` in this
 * surface's `[{id, name}]` shape, and that a denied permission reaches the
 * rows. Unlike the people pickers it has no search box, so there is no query
 * to wire.
 *
 * The state machine is proved once in `use-github-item-picker.test.ts`; the
 * rendering contract shared with the other two pickers — the write-failure
 * alert, the forbidden read's reason, the permission caveat, the truncation
 * note, a thrown fetch — is proved once per picker in
 * `github-item-picker.rendering.test.tsx`.
 */

afterEach(() => cleanup());

const repositoryLabels: RepositoryLabelListResponse = {
  state: "ready",
  labels: [
    { id: "LA_bug", name: "bug", color: "d73a4a" },
    { id: "LA_docs", name: "documentation", color: "0075ca" },
  ],
  totalCount: 2,
  permission: "permitted",
};

type FetchList = () => Promise<RepositoryLabelListResponse | undefined>;

function actionsFixture(fetchLabels: FetchList = async () => repositoryLabels) {
  return {
    fetchLabels: vi.fn(fetchLabels),
    addLabels: vi.fn(async () => undefined),
    removeLabels: vi.fn(async () => undefined),
  };
}

/** The row for one candidate, by the label its checkbox carries. */
const checkbox = (name: string): HTMLElement =>
  screen.getByRole("checkbox", { name });

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Manage labels" }));
}

/**
 * Open it the way a keyboard user does, and hand back the trigger so a test
 * can assert focus came back to it.
 */
async function openPickerFromKeyboard(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name: "Manage labels" });
  trigger.focus();
  await user.keyboard("{Enter}");
  return trigger;
}

describe("LabelPicker", () => {
  it("renders nothing when the Review can no longer accept label writes", () => {
    const { container } = render(<LabelPicker attachedLabels={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("opens onto the repository's labels, with the attached ones checked by name", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(
      <LabelPicker
        attachedLabels={[{ name: "bug", color: "d73a4a" }]}
        actions={actions}
      />,
    );
    await openPicker(user);
    await waitFor(() => expect(actions.fetchLabels).toHaveBeenCalledOnce());
    await screen.findByRole("checkbox", { name: "bug" });
    expect(checkbox("bug").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("documentation").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("sends each toggled row to the label command for its own direction, in this surface's own shape", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(
      <LabelPicker
        attachedLabels={[{ name: "bug", color: "d73a4a" }]}
        actions={actions}
      />,
    );
    await openPicker(user);
    await user.click(
      await screen.findByRole("checkbox", { name: "documentation" }),
    );
    await waitFor(() =>
      expect(actions.addLabels).toHaveBeenCalledWith([
        { id: "LA_docs", name: "documentation" },
      ]),
    );
    expect(actions.removeLabels).not.toHaveBeenCalled();
    await user.click(checkbox("bug"));
    await waitFor(() =>
      expect(actions.removeLabels).toHaveBeenCalledWith([
        { id: "LA_bug", name: "bug" },
      ]),
    );
    expect(actions.addLabels).toHaveBeenCalledOnce();
  });

  it("shows a denied permission on the rows themselves, not only in the hook", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture(async () => ({
      ...repositoryLabels,
      permission: "denied" as const,
    }));
    render(<LabelPicker attachedLabels={[]} actions={actions} />);
    await openPicker(user);
    await screen.findByRole("checkbox", { name: "documentation" });
    expect(
      document.querySelector('[data-slot="picker-permission-denied"]'),
    ).toBeTruthy();
    expect(checkbox("documentation").getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  // Movement between rows is the document's own tab order: the rows are plain
  // checkboxes in a <ul>, not a roving-tabindex listbox, so arrow keys do
  // nothing here and there is no arrow handling to assert.
  it("opens into its own popup from the keyboard, reaches each label row with Tab, and toggles the focused row with Space", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(<LabelPicker attachedLabels={[]} actions={actions} />);
    await openPickerFromKeyboard(user);

    // Enter on the trigger moves focus off the trigger and into the popup,
    // which is what makes the rows one Tab away rather than unreachable.
    const popup = screen.getByRole("dialog", { name: "Labels" });
    await screen.findByRole("checkbox", { name: "documentation" });
    expect(popup.contains(document.activeElement)).toBe(true);

    await user.tab();
    expect(document.activeElement).toBe(checkbox("bug"));
    await user.tab();
    expect(document.activeElement).toBe(checkbox("documentation"));

    await user.keyboard(" ");
    await waitFor(() => expect(actions.addLabels).toHaveBeenCalledOnce());
    expect(checkbox("documentation").getAttribute("aria-checked")).toBe("true");
  });

  it("closes on Escape and hands focus back to the trigger that opened it", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(<LabelPicker attachedLabels={[]} actions={actions} />);
    const trigger = await openPickerFromKeyboard(user);
    await screen.findByRole("checkbox", { name: "documentation" });

    await user.tab();
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "documentation" })).toBe(
        null,
      ),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
