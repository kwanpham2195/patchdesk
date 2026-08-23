// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LabelPicker } from "../../src/renderer/src/components/label-picker";
import { PatchdeskApiError } from "../../src/renderer/src/api-client";
import type { RepositoryLabelListResponse } from "../../src/renderer/src/renderer-contracts";

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

function actionsFixture(
  overrides: Partial<{
    fetchLabels: () => Promise<RepositoryLabelListResponse | undefined>;
    addLabels: (
      labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    ) => Promise<void>;
    removeLabels: (
      labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    ) => Promise<void>;
  }> = {},
) {
  return {
    fetchLabels: vi.fn(async () => repositoryLabels),
    addLabels: vi.fn(async () => undefined),
    removeLabels: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Manage labels" }));
}

describe("LabelPicker", () => {
  it("renders nothing when the Review can no longer accept label writes", () => {
    const { container } = render(<LabelPicker attachedLabels={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders currently attached labels as checked and other repository labels as available", async () => {
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
    const bugCheckbox = await screen.findByRole("checkbox", { name: "bug" });
    const docsCheckbox = screen.getByRole("checkbox", {
      name: "documentation",
    });
    expect(bugCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(docsCheckbox.getAttribute("aria-checked")).toBe("false");
  });

  it("issues an add-labels command with the toggled label's id and name", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(<LabelPicker attachedLabels={[]} actions={actions} />);
    await openPicker(user);
    const docsCheckbox = await screen.findByRole("checkbox", {
      name: "documentation",
    });
    await user.click(docsCheckbox);
    await waitFor(() =>
      expect(actions.addLabels).toHaveBeenCalledWith([
        { id: "LA_docs", name: "documentation" },
      ]),
    );
    expect(actions.removeLabels).not.toHaveBeenCalled();
  });

  it("issues a remove-labels command with the toggled label's id and name", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(
      <LabelPicker
        attachedLabels={[{ name: "bug", color: "d73a4a" }]}
        actions={actions}
      />,
    );
    await openPicker(user);
    const bugCheckbox = await screen.findByRole("checkbox", { name: "bug" });
    await user.click(bugCheckbox);
    await waitFor(() =>
      expect(actions.removeLabels).toHaveBeenCalledWith([
        { id: "LA_bug", name: "bug" },
      ]),
    );
    expect(actions.addLabels).not.toHaveBeenCalled();
  });

  it("shows the toggled label immediately (optimistic) and reconciles once the authoritative labels arrive", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    const { rerender } = render(
      <LabelPicker attachedLabels={[]} actions={actions} />,
    );
    await openPicker(user);
    const docsCheckbox = await screen.findByRole("checkbox", {
      name: "documentation",
    });
    await user.click(docsCheckbox);
    // Applied immediately, before the write's promise ever settles.
    expect(
      screen
        .getByRole("checkbox", { name: "documentation" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await waitFor(() => expect(actions.addLabels).toHaveBeenCalledOnce());
    // The authoritative prop now agrees; the optimistic override should
    // have nothing left to override.
    rerender(
      <LabelPicker
        attachedLabels={[{ name: "documentation", color: "0075ca" }]}
        actions={actions}
      />,
    );
    expect(
      screen
        .getByRole("checkbox", { name: "documentation" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("reverts a failed write and surfaces the failure instead of silently reverting", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      addLabels: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    render(<LabelPicker attachedLabels={[]} actions={actions} />);
    await openPicker(user);
    const docsCheckbox = await screen.findByRole("checkbox", {
      name: "documentation",
    });
    await user.click(docsCheckbox);
    await waitFor(() =>
      expect(
        screen
          .getByRole("checkbox", { name: "documentation" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(
      await screen.findByText('Patchdesk could not add "documentation".'),
    ).toBeTruthy();
  });

  it("fully enables the picker with no caveat when the service reports 'permitted'", async () => {
    const user = userEvent.setup();
    render(<LabelPicker attachedLabels={[]} actions={actionsFixture()} />);
    await openPicker(user);
    const bugCheckbox = await screen.findByRole("checkbox", { name: "bug" });
    expect(bugCheckbox.getAttribute("aria-disabled")).not.toBe("true");
    expect(
      screen.queryByText(
        "This account cannot manage labels on this repository.",
      ),
    ).toBeNull();
    expect(
      screen.queryByText(
        "Patchdesk could not confirm you can manage labels here — a change may be refused.",
      ),
    ).toBeNull();
  });

  it("shows the honest unconfirmed caveat, without hiding or disabling the picker, when permission evidence is unavailable", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      fetchLabels: vi.fn(async () => ({
        ...repositoryLabels,
        permission: "unknown" as const,
      })),
    });
    render(<LabelPicker attachedLabels={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "Patchdesk could not confirm you can manage labels here — a change may be refused.",
      ),
    ).toBeTruthy();
    const bugCheckbox = screen.getByRole("checkbox", { name: "bug" });
    // Caveated, not withheld: a write is still offered even though the
    // evidence needed to confirm it is genuinely unavailable.
    expect(bugCheckbox.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("disables the picker and states the account cannot manage labels, with no retry, when the service reports 'denied'", async () => {
    const user = userEvent.setup();
    const addLabels = vi.fn(async () => undefined);
    const actions = actionsFixture({
      fetchLabels: vi.fn(async () => ({
        ...repositoryLabels,
        permission: "denied" as const,
      })),
      addLabels,
    });
    render(<LabelPicker attachedLabels={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "This account cannot manage labels on this repository.",
      ),
    ).toBeTruthy();
    const docsCheckbox = screen.getByRole("checkbox", {
      name: "documentation",
    });
    expect(docsCheckbox.getAttribute("aria-disabled")).toBe("true");
    // Disabled means disabled: clicking it must not issue a write.
    await user.click(docsCheckbox);
    expect(addLabels).not.toHaveBeenCalled();
  });

  it("still surfaces a write's specific forbidden reason even for a permitted account", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      addLabels: vi.fn(async () => {
        throw new PatchdeskApiError(
          "forbidden",
          403,
          false,
          "corr-1",
          "GitHub blocked this action: an IP allow list is enabled and this network is not on it.",
        );
      }),
    });
    render(<LabelPicker attachedLabels={[]} actions={actions} />);
    await openPicker(user);
    const docsCheckbox = await screen.findByRole("checkbox", {
      name: "documentation",
    });
    await user.click(docsCheckbox);
    expect(
      await screen.findByText(
        'Patchdesk could not add "documentation". GitHub blocked this action: an IP allow list is enabled and this network is not on it.',
      ),
    ).toBeTruthy();
    // A permitted account hitting a specific write failure is not
    // reclassified as denied: the picker still reflects the read path's
    // 'permitted' signal, so a retry remains offered.
    expect(docsCheckbox.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("shows a forbidden read's specific reason instead of an empty list", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      fetchLabels: vi.fn(async () => ({
        state: "github_forbidden" as const,
        forbiddenReason: "saml" as const,
      })),
    });
    render(<LabelPicker attachedLabels={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "GitHub blocked this read: this account's token needs SAML single sign-on authorization.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("makes truncation visible when totalCount exceeds the returned labels", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      fetchLabels: vi.fn(async () => ({
        state: "ready" as const,
        labels: [{ id: "LA_bug", name: "bug", color: "d73a4a" }],
        totalCount: 150,
      })),
    });
    render(<LabelPicker attachedLabels={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "Showing 1 of 150 labels. Some repository labels aren't shown.",
      ),
    ).toBeTruthy();
  });
});
