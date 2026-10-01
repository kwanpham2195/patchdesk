// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppCommandDialog } from "../../src/renderer/src/components/app-command-dialog";

afterEach(() => {
  cleanup();
});

describe("AppCommandDialog Pull requests filter commands", () => {
  it("disables a state or preset command that would not fit and gives the reason", async () => {
    const user = userEvent.setup();
    const onInboxStateChange = vi.fn();
    const onInboxPresetChange = vi.fn();
    render(
      <AppCommandDialog
        open
        query=""
        navigationBlocked={false}
        destination={{ kind: "dashboard" }}
        settingsOpenerRef={{ current: null }}
        onOpenChange={vi.fn()}
        onQueryChange={vi.fn()}
        onNavigate={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenDiagnostics={vi.fn()}
        onInboxStateChange={onInboxStateChange}
        onInboxPresetChange={onInboxPresetChange}
        inboxChangeFits={() => false}
        visitedRows={[]}
        reviewCommands={undefined}
      />,
    );

    expect(
      screen.getAllByText("Too long alongside the other filters"),
    ).toHaveLength(4);
    const merged = screen.getByRole("option", { name: /Merged pull requests/ });
    expect(merged.getAttribute("aria-disabled")).toBe("true");
    await user.click(merged);
    await user.click(
      screen.getByRole("option", { name: /Awaiting review from you/ }),
    );
    expect(onInboxStateChange).not.toHaveBeenCalled();
    expect(onInboxPresetChange).not.toHaveBeenCalled();
  });
});
