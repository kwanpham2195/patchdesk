// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopResponse } from "../../src/main/ipc-contract";
import { useReviewMergeAction } from "../../src/renderer/src/flows/use-review-merge-action";
import type { RunDirectCommand } from "../../src/renderer/src/flows/use-review-observation";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import { callPath, projection } from "./review-workbench-fixtures";

const MERGE = "/v1/reviews/merge";
const LOAD = "/v1/reviews/load";
let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

function renderMergeAction() {
  const onWorkbenchReplace = vi.fn();
  const runDirectCommand: RunDirectCommand = async (operation) =>
    await operation();
  const workbench = projection();
  const rendered = renderHook(() =>
    useReviewMergeAction({
      workbench,
      onWorkbenchReplace,
      runDirectCommand,
    }),
  );
  return { ...rendered, onWorkbenchReplace, workbench };
}

const confirmedReceipt = {
  readiness: { _tag: "Ready" as const, blockers: [], warnings: [] },
  mergeCommitSha: "c".repeat(40),
};

describe("useReviewMergeAction", () => {
  it("commits terminal confirmation before a rejected projection refresh and never retries the mutation", async () => {
    const double = installDesktopDouble({
      [MERGE]: () => success(confirmedReceipt),
      [LOAD]: () => failure({ error: "unavailable" }, 503),
    });
    restore = double.restore;
    const { result, onWorkbenchReplace, workbench } = renderMergeAction();
    const merge = result.current.mergeAction?.onMerge;
    if (merge === undefined) throw new Error("missing merge action");

    let outcome;
    await act(async () => {
      outcome = await merge("squash", []);
    });

    expect(outcome).toEqual({
      state: "confirmed_refresh_required",
      mergeCommitSha: confirmedReceipt.mergeCommitSha,
    });
    expect(onWorkbenchReplace).toHaveBeenNthCalledWith(1, {
      ...workbench,
      review: { ...workbench.review, status: "merged" },
    });
    expect(double.request.mock.calls.map(([input]) => callPath(input))).toEqual(
      [MERGE, LOAD],
    );

    await act(async () => {
      await merge("squash", []);
    });
    expect(
      double.request.mock.calls.filter(([input]) => callPath(input) === MERGE),
    ).toHaveLength(1);
  });

  it("retains confirmed-refresh recovery across the terminal-first workbench rerender", async () => {
    let releaseLoad: (value: DesktopResponse) => void = () => {
      throw new Error("load release was not initialized");
    };
    const load = new Promise<DesktopResponse>((resolve) => {
      releaseLoad = resolve;
    });
    const double = installDesktopDouble({
      [MERGE]: () => success(confirmedReceipt),
      [LOAD]: () => load,
    });
    restore = double.restore;
    const initial = projection();
    const onWorkbenchReplace = vi.fn();
    const runDirectCommand: RunDirectCommand = async (operation) =>
      await operation();
    const rendered = renderHook(
      ({ workbench }) =>
        useReviewMergeAction({
          workbench,
          onWorkbenchReplace,
          runDirectCommand,
        }),
      { initialProps: { workbench: initial } },
    );
    const merge = rendered.result.current.mergeAction?.onMerge;
    if (merge === undefined) throw new Error("missing merge action");
    let mergeResult: Promise<unknown> | undefined;
    act(() => {
      mergeResult = merge("squash", []);
    });
    await waitFor(() => expect(onWorkbenchReplace).toHaveBeenCalledOnce());
    const terminal = onWorkbenchReplace.mock.calls[0]?.[0];
    if (terminal === undefined) throw new Error("missing terminal projection");
    rendered.rerender({ workbench: terminal });
    expect(rendered.result.current.mergeAction).toBeDefined();

    await act(async () => releaseLoad(failure({ error: "unavailable" }, 503)));
    if (mergeResult === undefined) throw new Error("missing merge result");
    await expect(mergeResult).resolves.toMatchObject({
      state: "confirmed_refresh_required",
    });
    expect(rendered.result.current.mergeAction?.onRecoverMerge).toBeDefined();
    expect(
      double.request.mock.calls.filter(([input]) => callPath(input) === MERGE),
    ).toHaveLength(1);
  });

  it("rejects open projections after confirmation without replacing terminal state or retrying merge", async () => {
    const openProjection = projection();
    const double = installDesktopDouble({
      [MERGE]: () => success(confirmedReceipt),
      [LOAD]: () => success(openProjection as never),
      "/v1/reviews/merge/recover": () => success(openProjection as never),
    });
    restore = double.restore;
    const { result, onWorkbenchReplace, workbench } = renderMergeAction();
    const merge = result.current.mergeAction?.onMerge;
    const recover = result.current.mergeAction?.onRecoverMerge;
    if (merge === undefined || recover === undefined)
      throw new Error("missing merge actions");

    await expect(merge("squash", [])).resolves.toMatchObject({
      state: "confirmed_refresh_required",
    });
    expect(onWorkbenchReplace).toHaveBeenCalledExactlyOnceWith({
      ...workbench,
      review: { ...workbench.review, status: "merged" },
    });

    await expect(recover()).rejects.toThrow(/not terminal/i);
    expect(onWorkbenchReplace).toHaveBeenCalledOnce();
    await expect(merge("squash", [])).resolves.toMatchObject({
      state: "confirmed_refresh_required",
    });
    expect(
      double.request.mock.calls.filter(([input]) => callPath(input) === MERGE),
    ).toHaveLength(1);
  });

  it("admits same-tick submissions as one in-flight mutation", async () => {
    let release: (value: DesktopResponse) => void = () => {
      throw new Error("merge release was not initialized");
    };
    const deferred = new Promise<DesktopResponse>((resolve) => {
      release = resolve;
    });
    const double = installDesktopDouble({
      [MERGE]: () => deferred,
      [LOAD]: () =>
        success(
          // SAFETY: the projection factory returns JSON-safe fixture data;
          // this cast bridges its exact-optional TypeScript representation.
          projection({
            review: { id: "review-42", status: "merged" },
          }) as never,
        ),
    });
    restore = double.restore;
    const { result } = renderMergeAction();
    const merge = result.current.mergeAction?.onMerge;
    if (merge === undefined) throw new Error("missing merge action");

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = merge("squash", []);
      second = merge("squash", []);
    });
    expect(
      double.request.mock.calls.filter(([input]) => callPath(input) === MERGE),
    ).toHaveLength(1);

    await act(async () => {
      release(success(confirmedReceipt));
      await Promise.all([first, second]);
    });
  });

  it("fails closed on malformed or extra-field merge receipts", async () => {
    for (const receipt of [
      { readiness: confirmedReceipt.readiness, mergeCommitSha: "short" },
      { ...confirmedReceipt, rawResponse: "unsafe" },
    ]) {
      const double = installDesktopDouble({
        [MERGE]: () => success(receipt),
      });
      restore = double.restore;
      const { result, onWorkbenchReplace } = renderMergeAction();
      const merge = result.current.mergeAction?.onMerge;
      if (merge === undefined) throw new Error("missing merge action");

      await act(async () => {
        await expect(merge("squash", [])).rejects.toThrow(
          /could not confirm the merge/i,
        );
      });
      expect(onWorkbenchReplace).not.toHaveBeenCalled();
      expect(double.request).toHaveBeenCalledTimes(1);
      double.restore();
      restore = undefined;
    }
  });
});
