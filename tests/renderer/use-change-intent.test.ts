// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopResponse } from "../../src/main/ipc-contract";
import { useChangeIntent } from "../../src/renderer/src/flows/use-change-intent";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import { callBody, callPath, projection } from "./review-workbench-fixtures";

const INTENT = "/v1/reviews/local-intent";
let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const stored = {
  intent: { kind: "text", markdown: "Reject a negative total." },
  setting: { kind: "text", sha256: "a".repeat(64) },
} as const;

/** A working-tree Review holding `changeIntent`. */
function localReview(
  changeIntent: WorkbenchResponse["changeIntent"],
): WorkbenchResponse {
  const base = projection();
  // SAFETY: fixture data in the wire shape `parseWorkbenchResponse` accepts; the working-tree source replaces the pull request fields.
  return projection({
    ...base,
    session: {
      ...base.session,
      key: {
        ...base.session.key,
        source: { kind: "working_tree", branch: "main" },
      },
    },
    pullRequest: undefined,
    changeIntent,
  } as never);
}

function renderIntent(workbench: WorkbenchResponse) {
  const onWorkbenchPatch = vi.fn();
  const rendered = renderHook(() =>
    useChangeIntent({ workbench, onWorkbenchPatch }),
  );
  return { ...rendered, onWorkbenchPatch };
}

describe("useChangeIntent", () => {
  it("sends the intent for the Review and adopts what the main process stored", async () => {
    const double = installDesktopDouble({
      [INTENT]: () => success({ changeIntent: stored }),
    });
    restore = double.restore;
    const { result, onWorkbenchPatch } = renderIntent(localReview(null));

    await act(async () => result.current?.save(stored.intent));

    const call = double.request.mock.calls.find(
      ([input]) => callPath(input) === INTENT,
    );
    expect(callBody(call?.[0])).toEqual({
      profileId: "profile",
      reviewId: "review-42",
      intent: stored.intent,
    });
    expect(onWorkbenchPatch).toHaveBeenCalledWith({ changeIntent: stored });
  });

  it("clears the intent with null", async () => {
    const double = installDesktopDouble({
      [INTENT]: () => success({ changeIntent: null }),
    });
    restore = double.restore;
    const { result, onWorkbenchPatch } = renderIntent(localReview(stored));

    await act(async () => result.current?.save(null));

    expect(
      callBody(
        double.request.mock.calls.find(
          ([input]) => callPath(input) === INTENT,
        )?.[0],
      ),
    ).toMatchObject({ intent: null });
    expect(onWorkbenchPatch).toHaveBeenCalledWith({ changeIntent: null });
  });

  it("rejects with the credential reason and leaves the workbench as it was", async () => {
    restore = installDesktopDouble({
      [INTENT]: () => failure({ error: "change_intent_sensitive" }, 400),
    }).restore;
    const { result, onWorkbenchPatch } = renderIntent(localReview(null));

    await act(async () => {
      await expect(result.current?.save(stored.intent)).rejects.toThrow(
        "looks like a credential",
      );
    });
    expect(onWorkbenchPatch).not.toHaveBeenCalled();
  });

  it("sends one request while a save is in flight", async () => {
    let answer: (response: DesktopResponse) => void = () => undefined;
    const double = installDesktopDouble({
      [INTENT]: () =>
        new Promise<DesktopResponse>((resolve) => {
          answer = resolve;
        }),
    });
    restore = double.restore;
    const { result } = renderIntent(localReview(null));

    let first: Promise<void> | undefined;
    act(() => {
      first = result.current?.save(stored.intent);
    });
    expect(result.current?.saving).toBe(true);
    await act(async () => result.current?.save(stored.intent));
    await act(async () => {
      answer(success({ changeIntent: stored }));
      await first;
    });

    expect(
      double.request.mock.calls.filter(([input]) => callPath(input) === INTENT),
    ).toHaveLength(1);
    expect(result.current?.saving).toBe(false);
  });

  it("offers nothing on a pull request Review", () => {
    restore = installDesktopDouble({}).restore;
    const { result } = renderIntent(projection());

    expect(result.current).toBeUndefined();
  });
});
