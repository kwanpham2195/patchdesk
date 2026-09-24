// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewWorkbenchPatch } from "../../src/renderer/src/flows/use-review-observation";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

const twoFilePatch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

function renderFlow(
  workbench: WorkbenchResponse,
  onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void,
) {
  return render(
    <ReviewWorkbenchFlow
      workbench={workbench}
      onWorkbenchReplace={vi.fn()}
      onWorkbenchPatch={onWorkbenchPatch}
      onNavigationStateChange={vi.fn()}
    />,
  );
}

function viewedCount(): string | null {
  return within(screen.getByRole("region", { name: "Review diff" })).getByRole(
    "status",
  ).textContent;
}

describe("ReviewWorkbenchFlow Viewed marks", () => {
  it("shows the saved Viewed marks when the Review is opened again", async () => {
    const saved: Array<unknown> = [];
    bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/reviews/viewed-files") {
        saved.push(input.body);
        return { paths: ["src/a.ts", "src/b.ts"] };
      }
      throw new Error(input.path);
    });
    let workbench = projection({ fullPatch: twoFilePatch });
    const view = renderFlow(workbench, (patch) => {
      workbench = { ...workbench, ...patch, insights: workbench.insights };
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    await user.click(screen.getByRole("button", { name: "Mark all viewed" }));
    await waitFor(() => expect(workbench.viewedPaths).toHaveLength(2));
    expect(saved).toEqual([
      expect.objectContaining({
        sessionId: workbench.session.id,
        paths: ["src/a.ts", "src/b.ts"],
      }),
    ]);

    view.unmount();
    renderFlow(workbench, vi.fn());
    await user.click(screen.getByRole("tab", { name: "Diff" }));

    expect(viewedCount()).toBe("2 of 2 viewed");
  });
});
