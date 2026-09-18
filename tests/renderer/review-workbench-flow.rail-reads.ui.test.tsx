// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type {
  DesktopRequest,
  DesktopResponse,
} from "../../src/main/ipc-contract";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { callPath, projection } from "./review-workbench-fixtures";

/**
 * The Reviewers and Assignees rail sections each read GitHub on mount and
 * again on every re-baseline. Both reads are seconds of GitHub traffic, so a
 * re-render of the flow — which rebuilds the actions object the rail is handed
 * — must not count as either.
 */

type BridgeSpy = Mock<(input: DesktopRequest) => Promise<DesktopResponse>>;

function installBridge(): BridgeSpy {
  return bridge((input) => {
    if (input.path.startsWith("/v1/reviews/assignees"))
      return {
        state: "ready",
        users: [],
        totalCount: 0,
        permission: "permitted",
      };
    if (input.path.startsWith("/v1/reviews/reviewers"))
      return {
        state: "ready",
        reviewers: [],
        candidates: [],
        permission: "permitted",
      };
    if (input.path === "/v1/reviews/detect-updates")
      return { updatesAvailable: false };
    throw new Error(`unscripted path: ${input.path}`);
  });
}

function reads(request: BridgeSpy, path: string): number {
  return request.mock.calls.filter(([input]) =>
    callPath(input)?.startsWith(path),
  ).length;
}

function flowElement(workbench: WorkbenchResponse): React.JSX.Element {
  return (
    <ReviewWorkbenchFlow
      workbench={workbench}
      onWorkbenchReplace={vi.fn()}
      onWorkbenchPatch={vi.fn()}
      onNavigationStateChange={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

describe("ReviewWorkbenchFlow pull-request metadata reads", () => {
  it("reads assignees and reviewers once across re-renders, and again on a re-baseline", async () => {
    const request = installBridge();
    const { rerender } = render(flowElement(projection()));
    await waitFor(() => {
      expect(reads(request, "/v1/reviews/assignees")).toBe(1);
      expect(reads(request, "/v1/reviews/reviewers")).toBe(1);
    });

    // New callback props rebuild every action object the flow composes.
    await act(async () => {
      rerender(flowElement(projection()));
    });
    expect(reads(request, "/v1/reviews/assignees")).toBe(1);
    expect(reads(request, "/v1/reviews/reviewers")).toBe(1);

    const rebaselined = projection({
      revision: {
        ...projection().revision,
        refreshedAt: "2026-08-02T00:00:00.000Z",
      },
    });
    rerender(flowElement(rebaselined));
    await waitFor(() => {
      expect(reads(request, "/v1/reviews/assignees")).toBe(2);
      expect(reads(request, "/v1/reviews/reviewers")).toBe(2);
    });
  });
});
