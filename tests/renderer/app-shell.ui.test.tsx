// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../../src/renderer/src/components/app-shell";
import { BusyProvider } from "../../src/renderer/src/hooks/use-busy";

afterEach(() => {
  cleanup();
  // The visited column's collapsed state is a local preference, so it would
  // otherwise carry into the next test in this file.
  window.localStorage.clear();
});

function ContentEditableAncestorFixture(): React.JSX.Element {
  return (
    <div
      contentEditable
      ref={(ancestor) => {
        if (ancestor === null || ancestor.firstChild !== null) return;
        const child = document.createElement("button");
        child.type = "button";
        child.ariaLabel = "Markdown editor toolbar";
        child.textContent = "Bold";
        ancestor.append(child);
      }}
    />
  );
}

describe("AppShell settings overlay entry points", () => {
  it("opens Settings without making it a destination or changing the main scroll owner", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();

    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "dashboard" }}
          onNavigate={() => undefined}
          visitedReloadKey={0}
          onOpenSettings={onOpenSettings}
        >
          <div>Inbox content</div>
        </AppShell>
      </BusyProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("main").className).toContain("overflow-hidden");
    expect(screen.queryByText("Settings content")).toBeNull();
    expect(screen.queryByLabelText("Workspace navigation")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /application sidebar/i }),
    ).toBeNull();
  });

  it("keeps Command Palette motion-free", async () => {
    const user = userEvent.setup();

    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "dashboard" }}
          onNavigate={() => undefined}
          visitedReloadKey={0}
          onOpenSettings={() => undefined}
        >
          <div>Inbox content</div>
        </AppShell>
      </BusyProvider>,
    );

    await user.click(screen.getByRole("button", { name: /^Navigate/ }));

    expect(
      screen.getByRole("dialog", { name: "Navigate Patchdesk" }).dataset.motion,
    ).toBe("none");
    expect(
      document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')
        ?.dataset.motion,
    ).toBe("none");
  });
});

describe("AppShell Navigate shortcut", () => {
  it.each([
    ["textarea", "Review comment", <textarea aria-label="Review comment" />],
    ["input", "Profile label", <input aria-label="Profile label" />],
    [
      "content-editable editor",
      "Markdown editor",
      <div aria-label="Markdown editor" contentEditable role="textbox" />,
    ],
    [
      "content-editable editor child",
      "Markdown editor toolbar",
      <ContentEditableAncestorFixture />,
    ],
  ])(
    "does not consume Meta+K or Ctrl+K from a %s",
    (_targetName, targetLabel, target) => {
      render(
        <BusyProvider>
          <AppShell
            destination={{ kind: "dashboard" }}
            onNavigate={() => undefined}
            visitedReloadKey={0}
            onOpenSettings={() => undefined}
          >
            {target}
          </AppShell>
        </BusyProvider>,
      );

      const editor = screen.getByLabelText(targetLabel);
      editor.focus();
      for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
        const event = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "k",
          ...modifiers,
        });
        editor.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(false);
        expect(
          screen.queryByRole("dialog", { name: "Navigate Patchdesk" }),
        ).toBeNull();
      }
    },
  );

  it("opens Navigate from a non-editable target", async () => {
    const user = userEvent.setup();
    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "dashboard" }}
          onNavigate={() => undefined}
          visitedReloadKey={0}
          onOpenSettings={() => undefined}
        >
          <button type="button">Review content</button>
        </AppShell>
      </BusyProvider>,
    );

    const target = screen.getByRole("button", { name: "Review content" });
    target.focus();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(
      screen.getByRole("dialog", { name: "Navigate Patchdesk" }),
    ).toBeTruthy();
  });
});

describe("AppShell pull-request command", () => {
  it.each([
    "https://github.com/acme/widgets/pull/42",
    "https://github.com/acme/widgets/pull/42/files?diff=split#discussion_r1",
  ])("offers and activates a parsed pull request for %s", async (input) => {
    const user = userEvent.setup();
    const onOpenPullRequest = vi.fn();
    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "dashboard" }}
          onNavigate={() => undefined}
          visitedReloadKey={0}
          onOpenSettings={() => undefined}
          onOpenPullRequest={onOpenPullRequest}
        >
          <div>Inbox content</div>
        </AppShell>
      </BusyProvider>,
    );

    await user.click(screen.getByRole("button", { name: /^Navigate/ }));
    await user.type(
      screen.getByRole("combobox", { name: "Search views and actions" }),
      input,
    );
    await user.click(
      screen.getByRole("option", { name: "Open acme/widgets#42" }),
    );

    expect(onOpenPullRequest).toHaveBeenCalledWith({
      host: "github.com",
      owner: "acme",
      repo: "widgets",
      number: 42,
    });
  });

  it("does not offer a pull-request action for a non-PR GitHub URL", async () => {
    const user = userEvent.setup();
    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "workbench", reviewId: "review-1" }}
          onNavigate={() => undefined}
          visitedReloadKey={0}
          onOpenSettings={() => undefined}
          onOpenPullRequest={() => undefined}
        >
          <div>Review content</div>
        </AppShell>
      </BusyProvider>,
    );

    await user.click(screen.getByRole("button", { name: /^Navigate/ }));
    await user.type(
      screen.getByRole("combobox", { name: "Search views and actions" }),
      "https://github.com/acme/widgets/issues/42",
    );

    expect(
      screen.queryByRole("option", { name: "Open acme/widgets#42" }),
    ).toBeNull();
  });
});

describe("AppShell visited pull requests toggle", () => {
  it("names the toggle for the action it performs and points it at the column", async () => {
    const user = userEvent.setup();
    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "dashboard" }}
          onNavigate={() => undefined}
          visitedReloadKey={0}
          onOpenSettings={() => undefined}
        >
          <div>Inbox content</div>
        </AppShell>
      </BusyProvider>,
    );

    const collapse = screen.getByRole("button", {
      name: "Collapse the pull requests you have opened",
    });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(
      document.getElementById(collapse.getAttribute("aria-controls") ?? ""),
    ).toBe(
      screen.getByRole("complementary", {
        name: "Pull requests you have opened",
      }),
    );

    await user.click(collapse);

    const expand = screen.getByRole("button", {
      name: "Expand the pull requests you have opened",
    });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
  });
});
