// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../../src/renderer/src/components/app-shell";
import { BusyProvider } from "../../src/renderer/src/hooks/use-busy";

afterEach(() => {
  cleanup();
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
