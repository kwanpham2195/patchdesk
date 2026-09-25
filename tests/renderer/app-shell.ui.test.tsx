// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../../src/renderer/src/components/app-shell";
import { BusyProvider } from "../../src/renderer/src/hooks/use-busy";
import { definedProps } from "../../src/domain/defined-props";
import { parseGitHubHost } from "../../src/domain/ids";
import type { PullRequestRef } from "../../src/domain/pull-request";
import type { RepositoryIdentity } from "../../src/domain/repository-identity";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
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
  it("opens Settings without making it a destination", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();

    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "dashboard" }}
          onNavigate={() => undefined}
          visitedReloadKey={0}
          onOpenSettings={onOpenSettings}
          onOpenDiagnostics={() => undefined}
          onOpenLocalReview={() => undefined}
        >
          <div>Inbox content</div>
        </AppShell>
      </BusyProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
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
          onOpenDiagnostics={() => undefined}
          onOpenLocalReview={() => undefined}
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
            onOpenDiagnostics={() => undefined}
            onOpenLocalReview={() => undefined}
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

  it("does not open Navigate from an input inside an open shadow root", () => {
    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "dashboard" }}
          onNavigate={() => undefined}
          visitedReloadKey={0}
          onOpenSettings={() => undefined}
          onOpenDiagnostics={() => undefined}
          onOpenLocalReview={() => undefined}
        >
          <div data-testid="tree-host" />
        </AppShell>
      </BusyProvider>,
    );
    // The Browse tree's search field lives in a shadow root, so a window listener sees the host as the target.
    const shadow = screen
      .getByTestId("tree-host")
      .attachShadow({ mode: "open" });
    const search = document.createElement("input");
    search.ariaLabel = "Search files";
    shadow.append(search);
    search.focus();

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "k",
      metaKey: true,
    });
    search.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(
      screen.queryByRole("dialog", { name: "Navigate Patchdesk" }),
    ).toBeNull();
  });

  it("opens Navigate from a non-editable target", async () => {
    const user = userEvent.setup();
    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "dashboard" }}
          onNavigate={() => undefined}
          visitedReloadKey={0}
          onOpenSettings={() => undefined}
          onOpenDiagnostics={() => undefined}
          onOpenLocalReview={() => undefined}
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

describe("AppShell preset commands", () => {
  it.each([
    ["Awaiting review from you", "awaiting_my_review"],
    ["Your pull requests", "my_pull_requests"],
  ])(
    "sets the %s preset and returns to Pull requests",
    async (label, preset) => {
      const user = userEvent.setup();
      const onInboxPresetChange = vi.fn();
      const onNavigate = vi.fn();
      render(
        <BusyProvider>
          <AppShell
            destination={{ kind: "dashboard" }}
            onNavigate={onNavigate}
            visitedReloadKey={0}
            onOpenSettings={() => undefined}
            onOpenDiagnostics={() => undefined}
            onOpenLocalReview={() => undefined}
            onInboxPresetChange={onInboxPresetChange}
          >
            <div>Inbox content</div>
          </AppShell>
        </BusyProvider>,
      );

      await user.click(screen.getByRole("button", { name: /^Navigate/ }));
      await user.click(screen.getByRole("option", { name: label }));

      // The command sets the preset rather than toggling it, so choosing the
      // same one twice leaves it on.
      expect(onInboxPresetChange).toHaveBeenCalledWith(preset);
      expect(onNavigate).toHaveBeenCalledWith({ kind: "dashboard" });
    },
  );
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
          onOpenDiagnostics={() => undefined}
          onOpenLocalReview={() => undefined}
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
          onOpenDiagnostics={() => undefined}
          onOpenLocalReview={() => undefined}
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
          onOpenDiagnostics={() => undefined}
          onOpenLocalReview={() => undefined}
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

describe("AppShell pull-request search", () => {
  const widgets = { host: "github.com", owner: "acme", repo: "widgets" };
  const visitedRow = {
    reviewId: "review-7",
    owner: "acme",
    repo: "gadgets",
    number: 7,
    title: "Throwaway PR for live checks",
    sortedAt: "2026-09-10T10:00:00.000Z",
  };

  /** Requests other than the renderer's timed log flush, which is not the palette's doing. */
  function apiRequestCount(): number {
    return (desktop?.request.mock.calls ?? []).filter(
      ([request]) => "path" in request && request.path !== "/v1/logs",
    ).length;
  }

  /** Renders the shell with one Visited row loaded, and resolves once the row is on screen. */
  async function renderSearchableShell(options: {
    readonly selectedRepository?: RepositoryIdentity;
    readonly onOpenPullRequest: (ref: PullRequestRef) => void;
  }): Promise<void> {
    const host = parseGitHubHost("github.com");
    if (host._tag !== "ok") throw new Error("github.com must parse");
    desktop = installDesktopDouble({
      "/v1/sidebar/reviews": () =>
        success({ rows: [visitedRow], unreadable: 0 }),
    });
    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "dashboard" }}
          onNavigate={() => undefined}
          visitedReloadKey={0}
          activeProfileId="profile-1"
          onOpenSettings={() => undefined}
          onOpenDiagnostics={() => undefined}
          onOpenLocalReview={() => undefined}
          pullRequestDefaultHost={host.value}
          onOpenPullRequest={options.onOpenPullRequest}
          {...definedProps({ selectedRepository: options.selectedRepository })}
        >
          <div>Inbox content</div>
        </AppShell>
      </BusyProvider>,
    );
    await screen.findByRole("button", { name: /Throwaway PR for live checks/ });
  }

  it.each(["345", "#345"])(
    "opens %s in the Selected repository",
    async (input) => {
      const user = userEvent.setup();
      const onOpenPullRequest = vi.fn();
      await renderSearchableShell({
        selectedRepository: widgets,
        onOpenPullRequest,
      });
      const requestsBeforeTyping = apiRequestCount();

      await user.click(screen.getByRole("button", { name: /^Navigate/ }));
      await user.type(
        screen.getByRole("combobox", { name: "Search views and actions" }),
        input,
      );
      expect(apiRequestCount()).toBe(requestsBeforeTyping);
      await user.click(
        screen.getByRole("option", { name: "Open #345 in acme/widgets" }),
      );

      expect(onOpenPullRequest).toHaveBeenCalledWith({
        host: "github.com",
        owner: "acme",
        repo: "widgets",
        number: 345,
      });
    },
  );

  it("offers nothing for a bare number without a Selected repository", async () => {
    const user = userEvent.setup();
    await renderSearchableShell({ onOpenPullRequest: () => undefined });

    await user.click(screen.getByRole("button", { name: /^Navigate/ }));
    await user.type(
      screen.getByRole("combobox", { name: "Search views and actions" }),
      "345",
    );

    expect(screen.queryByRole("option", { name: /#345/ })).toBeNull();
  });

  it("lists a Visited pull request whose title contains the query and opens it", async () => {
    const user = userEvent.setup();
    const onOpenPullRequest = vi.fn();
    await renderSearchableShell({
      selectedRepository: widgets,
      onOpenPullRequest,
    });
    const requestsBeforeTyping = apiRequestCount();

    await user.click(screen.getByRole("button", { name: /^Navigate/ }));
    await user.type(
      screen.getByRole("combobox", { name: "Search views and actions" }),
      "THROWAWAY",
    );
    expect(apiRequestCount()).toBe(requestsBeforeTyping);
    await user.click(screen.getByRole("option", { name: /acme\/gadgets#7/ }));

    expect(onOpenPullRequest).toHaveBeenCalledWith({
      host: "github.com",
      owner: "acme",
      repo: "gadgets",
      number: 7,
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Navigate Patchdesk" }),
      ).toBeNull(),
    );
  });
});
