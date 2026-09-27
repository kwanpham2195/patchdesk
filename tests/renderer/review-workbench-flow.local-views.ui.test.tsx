// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type { ReviewWorkbenchPatch } from "../../src/renderer/src/flows/use-review-observation";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

function filePatch(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

const patchView = { patchHash: "c".repeat(64), paths: [] };

function sharedReview(): WorkbenchResponse {
  const base = projection();
  return projection({
    session: {
      ...base.session,
      key: {
        ...base.session.key,
        source: { kind: "local_branch", branch: "feature", baseBranch: "main" },
      },
    },
    pullRequest: undefined,
    fullPatch: filePatch("src/combined.ts"),
    viewedPaths: [],
    patchViews: {
      combined: patchView,
      committed: patchView,
      uncommitted: patchView,
    },
  });
}

describe("ReviewWorkbenchFlow patch views", () => {
  it("shows the Committed patch on a switch and keeps its Viewed marks to that view", async () => {
    const saved: unknown[] = [];
    bridge((input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/reviews/local-patch-view")
        return {
          sessionId: "session-a",
          view: "committed",
          patch: filePatch("src/committed.ts"),
          patchHash: "d".repeat(64),
          viewedPaths: [],
        };
      if (input.path === "/v1/reviews/viewed-files") {
        saved.push(input.body);
        return { paths: ["src/committed.ts"] };
      }
      if (input.path === "/v1/reviews/diff-file")
        return { state: "unavailable", reason: "path_unavailable" };
      throw new Error(input.path);
    });
    const patches: ReviewWorkbenchPatch[] = [];
    render(
      <ReviewWorkbenchFlow
        workbench={sharedReview()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={(patch) => patches.push(patch)}
        onNavigationStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByText(/Combined view/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Combined" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "Committed" }));

    await waitFor(() =>
      expect(screen.getAllByText(/src\/committed\.ts/).length).toBeGreaterThan(
        0,
      ),
    );
    expect(screen.queryByText(/src\/combined\.ts/)).toBeNull();
    expect(screen.getByText(/Committed view/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Committed" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "Mark all viewed" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({
      view: "committed",
      paths: ["src/committed.ts"],
    });
    expect(patches).not.toContainEqual(
      expect.objectContaining({ viewedPaths: expect.anything() }),
    );
  });
});
