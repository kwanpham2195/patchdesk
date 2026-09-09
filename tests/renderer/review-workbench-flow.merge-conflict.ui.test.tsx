// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type * as PierreDiffs from "@pierre/diffs";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";

/**
 * The Diff tab's merge-conflict notice. A Blocked merge is not the signal --
 * a draft, a stale head, a failing check and a review blocker all report
 * Blocked -- so these cases pin the notice to the `conflicting` blocker, and
 * pin the guidance to resolving the conflict in a local checkout.
 */

// oxlint-disable-next-line anti-slop/no-module-mocking -- @pierre/diffs is a third-party rendering library with no DI seam patchdesk owns; `preloadHighlighter` loads a WASM-backed syntax highlighter that jsdom cannot run, so it is the one method stubbed here while every other export passes through real.
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof PierreDiffs>();
  return {
    ...actual,
    preloadHighlighter: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

/** Mounts the flow on a projection whose merge readiness carries `blockers`. */
async function openDiffTab(
  blockers: ReadonlyArray<string>,
  overrides: Parameters<typeof projection>[0] = {},
): Promise<ReturnType<typeof userEvent.setup>> {
  bridge(async (input) =>
    input.path === "/v1/reviews/detect-updates"
      ? { updatesAvailable: false }
      : Promise.reject(new Error(input.path)),
  );
  render(
    <ReviewWorkbenchFlow
      workbench={projection({
        // SAFETY: fixture data; `blockers` here is the wire form of the
        // `MergeReadiness` blocker union the projection carries.
        mergeReadiness: { _tag: "Blocked", blockers, warnings: [] } as never,
        ...overrides,
      })}
      onWorkbenchReplace={vi.fn()}
      onWorkbenchPatch={vi.fn()}
      onNavigationStateChange={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Diff" }));
  return user;
}

describe("ReviewWorkbenchFlow merge-conflict notice", () => {
  it("names the conflict above the diff when the pull request conflicts", async () => {
    await openDiffTab(["conflicting"]);

    expect(screen.getByText("Merge conflicts")).toBeTruthy();
    expect(
      screen.getByText(
        /Merge conflicts are what block this merge, not the checks\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Resolve the conflicts in your own local checkout/),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Review diff" })).toBeTruthy();
  });

  it("names the head and base branch so the reviewer can find the local work", async () => {
    await openDiffTab(["conflicting"]);

    expect(
      screen.getByText(
        /head branch feature no longer merges cleanly into the base branch main\./,
      ),
    ).toBeTruthy();
  });

  it("drops the branch clause when the projection carries no pull request", async () => {
    await openDiffTab(["conflicting"], { pullRequest: undefined });

    expect(screen.getByText("Merge conflicts")).toBeTruthy();
    expect(screen.queryByText(/no longer merges cleanly/)).toBeNull();
    expect(
      screen.getByText(/Resolve the conflicts in your own local checkout/),
    ).toBeTruthy();
  });

  it("stays silent when the merge is blocked for any other reason", async () => {
    await openDiffTab(["draft", "failing_check"]);

    expect(screen.queryByText("Merge conflicts")).toBeNull();
    expect(screen.getByRole("region", { name: "Review diff" })).toBeTruthy();
  });
});
