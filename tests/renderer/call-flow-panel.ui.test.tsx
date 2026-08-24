// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CallFlowPanel } from "../../src/renderer/src/components/call-flow-panel";

const headSha = "2".repeat(40);
const baseSha = "1".repeat(40);

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "patchdesk");
});

describe("CallFlowPanel", () => {
  it("renders CallDiff nodes and filters unchanged descendants", async () => {
    const ascii =
      "· capturePayment\n  + RefreshRolePermissionCache\n    · stableBody\n  - syncPayment\n  + if ready\n  + first duplicate\n  + second duplicate\n  · unchangedHelper";
    const request = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      correlationId: "call-flow",
      body: {
        state: "ready",
        snapshot: { sessionId: "session-a", baseSha, headSha },
        trees: [
          {
            entry: "capturePayment",
            ascii,
            tree: {
              key: "capturePayment",
              label: "capturePayment(value)",
              status: "same",
              kind: "call",
              file: "src/payment.ts",
              line: 4,
              children: [
                {
                  key: "RefreshRolePermissionCache",
                  label: "RefreshRolePermissionCache()",
                  status: "added",
                  kind: "call",
                  file: "src/payment.ts",
                  line: 5,
                  children: [
                    {
                      key: "stableBody",
                      label: "stableBody()",
                      status: "same",
                      kind: "call",
                      file: "src/cache.ts",
                      line: 20,
                      children: [],
                    },
                  ],
                },
                {
                  key: "syncPayment",
                  label: "syncPayment(value)",
                  status: "removed",
                  kind: "call",
                  file: "src/payment.ts",
                  line: 6,
                  children: [],
                },
                {
                  key: "if:ready",
                  label: "if ready",
                  status: "added",
                  kind: "branch",
                  file: "src/payment.ts",
                  line: 7,
                  children: [],
                },
                {
                  key: "duplicate",
                  label: "first duplicate",
                  status: "added",
                  kind: "call",
                  file: "src/payment.ts",
                  line: 8,
                  children: [],
                },
                {
                  key: "duplicate",
                  label: "second duplicate",
                  status: "added",
                  kind: "call",
                  file: "src/payment.ts",
                  line: 8,
                  children: [],
                },
                {
                  key: "unchangedHelper",
                  label: "unchangedHelper()",
                  status: "same",
                  kind: "call",
                  file: "src/payment.ts",
                  line: 11,
                  children: [],
                },
              ],
            },
          },
        ],
        ascii,
        changedSteps: 5,
        contextSteps: 3,
        impactedFiles: 2,
        languages: {
          analyzed: ["Go"],
          available: 5,
          skippedChangedFiles: 0,
        },
        truncated: false,
      },
    }));
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    const openSource = vi.fn();
    const user = userEvent.setup();
    render(
      <CallFlowPanel
        profileId="profile-a"
        sessionId="session-a"
        headSha={headSha}
        onOpenSource={openSource}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "5 changed path steps" }),
    ).toBeTruthy();
    expect(screen.getByText("Changed call explanation")).toBeTruthy();
    expect(request).toHaveBeenCalledWith({
      path: "/v1/reviews/call-flow",
      method: "POST",
      body: { profileId: "profile-a", sessionId: "session-a" },
    });
    expect(
      screen.getByRole("button", { name: "Language coverage" }).textContent,
    ).toContain("Languages 1/5");
    expect(screen.queryByText("unchangedHelper()")).toBeNull();
    expect(screen.queryByText("stableBody()")).toBeNull();
    expect(within(nodeButton("if ready")).queryByText("branch")).toBeNull();
    expect(
      within(nodeButton("RefreshRolePermissionCache()")).queryByText("call"),
    ).toBeNull();
    await user.click(nodeButton("first duplicate"));
    fireEvent.click(nodeButton("second duplicate"), { shiftKey: true });
    expect(screen.getByText(/2 selected/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "New only" }));
    expect(screen.getByText("RefreshRolePermissionCache()")).toBeTruthy();
    expect(screen.queryByText("syncPayment(value)")).toBeNull();
    expect(screen.getByText("capturePayment(value)")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "All changes" }));
    expect(screen.getByText("syncPayment(value)")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Search call flow" }));
    const search = screen.getByRole("textbox", { name: "Search call flow" });
    await user.type(search, "missing path");
    expect(screen.getByText("No call paths match this search.")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("button", { name: "Search call flow" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Show all context" }));
    expect(screen.getByText("unchangedHelper()")).toBeTruthy();
    expect(screen.getByText("stableBody()")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: /RefreshRolePermissionCache/ }),
    );
    expect(openSource).toHaveBeenCalledWith({
      path: "src/payment.ts",
      line: 5,
      status: "added",
    });

    await user.click(screen.getByRole("button", { name: "Call Diff" }));
    const before = screen.getByRole("region", { name: "Before call flow" });
    const after = screen.getByRole("region", { name: "After call flow" });
    expect(within(before).getByText(baseSha.slice(0, 8))).toBeTruthy();
    expect(within(before).getByText("syncPayment(value)")).toBeTruthy();
    expect(
      within(before).queryByText("RefreshRolePermissionCache()"),
    ).toBeNull();
    expect(within(after).getByText(headSha.slice(0, 8))).toBeTruthy();
    expect(
      within(after).getByText("RefreshRolePermissionCache()"),
    ).toBeTruthy();
    expect(within(after).queryByText("syncPayment(value)")).toBeNull();
    openSource.mockClear();
    await user.click(
      within(after).getByRole("button", {
        name: /RefreshRolePermissionCache/,
      }),
    );
    expect(openSource).toHaveBeenCalledWith({
      path: "src/payment.ts",
      line: 5,
      status: "added",
    });

    await user.click(screen.getByRole("button", { name: "Raw" }));
    await waitFor(() =>
      expect(screen.getByText(/RefreshRolePermissionCache/)).toBeTruthy(),
    );
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(
      new Error("permission denied"),
    );
    await user.click(screen.getByRole("button", { name: "Copy raw" }));
    expect(
      await screen.findByRole("button", { name: "Copy failed" }),
    ).toBeTruthy();
  });
});

function nodeButton(label: string): HTMLButtonElement {
  const button = screen.getByText(label).closest("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Call Flow node has no button: ${label}`);
  }
  return button;
}
