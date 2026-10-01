// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useLocalRefresh } from "../../src/renderer/src/flows/use-local-refresh";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { failure, installDesktopDouble } from "./fake-desktop-response";
import { projection } from "./review-workbench-fixtures";

let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

function localReview(reviewId: string): WorkbenchResponse {
  const base = projection();
  // SAFETY: fixture data in the wire shape the hook reads; the local branch source replaces the pull request fields.
  return projection({
    ...base,
    review: { ...base.review, id: reviewId },
    session: {
      ...base.session,
      key: {
        ...base.session.key,
        source: {
          kind: "local_branch",
          branch: "main",
          baseRef: "refs/heads/develop",
        },
      },
    },
    pullRequest: undefined,
  } as never);
}

async function failedRefresh(first: WorkbenchResponse) {
  const double = installDesktopDouble({
    "/v1/reviews/local-refresh": () =>
      failure({ error: "checkout_missing" }, 409),
  });
  restore = double.restore;
  const hook = renderHook(
    ({ workbench }) =>
      useLocalRefresh({ workbench, onWorkbenchReplace: () => undefined }),
    { initialProps: { workbench: first } },
  );
  await act(() => hook.result.current?.refresh() ?? Promise.resolve());
  await waitFor(() => expect(hook.result.current?.error).toBeDefined());
  return hook;
}

describe("useLocalRefresh error", () => {
  it("clears a failed Refresh when the same Review is reopened", async () => {
    const hook = await failedRefresh(localReview("review-1"));
    hook.rerender({ workbench: localReview("review-1") });
    expect(hook.result.current?.error).toBeUndefined();
  });

  it("keeps the error when the workbench is patched in place", async () => {
    const first = localReview("review-1");
    const hook = await failedRefresh(first);
    hook.rerender({ workbench: { ...first } });
    expect(hook.result.current?.error).toBeDefined();
  });

  it("clears a failed Refresh when another Review opens", async () => {
    const hook = await failedRefresh(localReview("review-1"));
    hook.rerender({ workbench: localReview("review-2") });
    expect(hook.result.current?.error).toBeUndefined();
  });
});
