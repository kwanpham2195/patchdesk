// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  useReviewObservation,
  type ReviewWorkbenchPatch,
} from "../../src/renderer/src/flows/use-review-observation";
import { installDesktopDouble, success } from "./fake-desktop-response";
import { projection } from "./review-workbench-fixtures";

/**
 * `useReviewObservation` owns the detect-updates state machine: when a
 * detection may run, which snapshot generation its result belongs to, and
 * which committed callback receives it. Driving it through `renderHook`
 * exercises those decisions directly; `review-workbench-flow.ui.test.tsx`
 * keeps one mounted test proving `ReviewWorkbenchFlow` hands each writer the
 * `runDirectCommand` this hook returns, which no hook test can observe.
 */

const DETECT = "/v1/reviews/detect-updates";
const REFRESH = "/v1/reviews/refresh";
const FOCUS_DEBOUNCE_MS = 1_500;
const DETECT_INTERVAL_MS = 90_000;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/**
 * Answers one detect-updates call. The payload is `unknown` because each case
 * scripts a differently-shaped observation body; that is fixture data, not an
 * unparsed I/O boundary value.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- see comment above
type DetectAnswer = (call: number) => Promise<unknown> | unknown;

/** Answers the one refresh call a case scripts. See `DetectAnswer`. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- see comment above
type RefreshAnswer = () => Promise<unknown> | unknown;

let restore: (() => void) | undefined;
afterEach(() => {
  // Unmount before the double is removed: a hook left mounted keeps its
  // `focus`/`visibilitychange` listeners on the shared window, and the next
  // test's events would reach it and count against the next test's double.
  cleanup();
  restore?.();
  restore = undefined;
  vi.useRealTimers();
});

/**
 * Installs the shared bridge double with only the two routes this hook
 * reaches. Anything else the hook asked for fails the test by name, so a
 * request nobody scripted can never be answered by a default.
 */
function installObservationDouble(answers: {
  readonly detect: DetectAnswer;
  readonly refresh?: RefreshAnswer;
}) {
  const detectBodies: unknown[] = [];
  const double = installDesktopDouble({
    [DETECT]: async (input) => {
      detectBodies.push(input.body);
      // SAFETY: each case's scripted observation body is JSON fixture data;
      // the answer type is `unknown` only because the shapes differ per case.
      return success(
        (await answers.detect(detectBodies.length)) as RawJsonValue,
      );
    },
    [REFRESH]: async () => {
      if (answers.refresh === undefined)
        throw new Error("this case scripted no refresh answer");
      // SAFETY: as above — fixture data shaped per case.
      return success((await answers.refresh()) as RawJsonValue);
    },
  });
  restore = double.restore;
  return { detectBodies, detectCount: () => detectBodies.length };
}

function renderObservation(workbench: WorkbenchResponse) {
  const replace = vi.fn();
  const patch = vi.fn<(value: ReviewWorkbenchPatch) => void>();
  const rendered = renderHook(
    (props: {
      readonly workbench: WorkbenchResponse;
      readonly onPatch: (value: ReviewWorkbenchPatch) => void;
    }) =>
      useReviewObservation({
        workbench: props.workbench,
        onWorkbenchReplace: replace,
        onWorkbenchPatch: props.onPatch,
      }),
    { initialProps: { workbench, onPatch: patch } },
  );
  return { ...rendered, replace, patch };
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const REPLACED = projection({
  session: { ...projection().session, id: "session-b" },
});

describe("useReviewObservation detection table", () => {
  const triggers = ["focus", "visibility", "timer", "direct command"] as const;
  const generations = ["same", "replaced"] as const;
  const responses = ["RevisionChanged", "Unavailable", "malformed"] as const;
  const bodyOf = {
    RevisionChanged: { _tag: "RevisionChanged" },
    Unavailable: { _tag: "Unavailable" },
    malformed: { detected: "yes" },
  } as const;
  const freshnessOf = {
    RevisionChanged: "updates_available",
    Unavailable: "unavailable",
  } as const;

  const cases = triggers.flatMap((trigger) =>
    generations.flatMap((generation) =>
      responses.map((response) => ({ trigger, generation, response })),
    ),
  );

  it.each(cases)(
    "$trigger on a $generation snapshot answered $response",
    async ({ trigger, generation, response }) => {
      vi.useFakeTimers();
      const second = deferred<unknown>();
      const observed = installObservationDouble({
        detect: (call) => (call === 1 ? { _tag: "Unchanged" } : second.promise),
      });
      const base = projection();
      const { result, rerender, replace, patch } = renderObservation(base);
      await flush();
      expect(observed.detectCount()).toBe(1);

      if (trigger === "focus") {
        window.dispatchEvent(new Event("focus"));
        await flush(FOCUS_DEBOUNCE_MS);
      } else if (trigger === "visibility") {
        document.dispatchEvent(new Event("visibilitychange"));
        await flush(FOCUS_DEBOUNCE_MS);
      } else if (trigger === "timer") {
        await flush(DETECT_INTERVAL_MS);
      } else {
        void result.current.observeConfirmedReviewWrite();
        await flush();
      }
      expect(observed.detectCount()).toBe(2);
      patch.mockClear();

      if (generation === "replaced")
        rerender({ workbench: REPLACED, onPatch: patch });
      await act(async () => {
        second.resolve(bodyOf[response]);
        await vi.advanceTimersByTimeAsync(0);
      });

      if (generation === "replaced" || response === "malformed") {
        expect(patch).not.toHaveBeenCalled();
      } else {
        expect(patch).toHaveBeenCalledWith({
          revision: { ...base.revision, freshness: freshnessOf[response] },
        });
      }
      expect(replace).not.toHaveBeenCalled();
      expect(observed.detectCount()).toBe(2);
    },
  );
});

describe("useReviewObservation scheduling", () => {
  it("coalesces a focus and a visibility change into one detection", async () => {
    vi.useFakeTimers();
    const observed = installObservationDouble({
      detect: () => ({ _tag: "Unchanged" }),
    });
    renderObservation(projection());
    await flush();
    expect(observed.detectCount()).toBe(1);

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(FOCUS_DEBOUNCE_MS);

    expect(observed.detectCount()).toBe(2);
  });

  it("clears the scheduled detection and ignores a late result after unmount", async () => {
    vi.useFakeTimers();
    const late = deferred<unknown>();
    const observed = installObservationDouble({
      detect: () => late.promise,
    });
    const { unmount, patch } = renderObservation(projection());
    await flush();
    unmount();
    await flush(DETECT_INTERVAL_MS);
    await act(async () => {
      late.resolve({ _tag: "RevisionChanged" });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(observed.detectCount()).toBe(1);
    expect(patch).not.toHaveBeenCalled();
  });

  it("delivers a same-generation result to the latest committed callback", async () => {
    vi.useFakeTimers();
    const detection = deferred<unknown>();
    installObservationDouble({ detect: () => detection.promise });
    const base = projection();
    const { rerender, patch: firstPatch } = renderObservation(base);
    await flush();
    const secondPatch = vi.fn<(value: ReviewWorkbenchPatch) => void>();
    rerender({ workbench: base, onPatch: secondPatch });
    await act(async () => {
      detection.resolve({ _tag: "RevisionChanged" });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(firstPatch).not.toHaveBeenCalled();
    expect(secondPatch).toHaveBeenCalledWith({
      revision: { ...base.revision, freshness: "updates_available" },
    });
  });

  it("does not detect while the Review is no longer open", async () => {
    vi.useFakeTimers();
    const observed = installObservationDouble({
      detect: () => ({ _tag: "Unchanged" }),
    });
    renderObservation(
      projection({ review: { id: "review-42", status: "merged" } }),
    );
    await flush(DETECT_INTERVAL_MS);

    expect(observed.detectCount()).toBe(0);
  });
});

describe("useReviewObservation direct commands", () => {
  it("holds a direct command until the in-flight detection completes", async () => {
    vi.useFakeTimers();
    const detection = deferred<unknown>();
    installObservationDouble({ detect: () => detection.promise });
    const { result } = renderObservation(projection());
    await flush();
    const operation = vi.fn(async () => "written");

    void result.current.runDirectCommand(operation);
    await flush();
    expect(operation).not.toHaveBeenCalled();

    await act(async () => {
      detection.resolve({ _tag: "Unchanged" });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("pauses detection until every overlapping direct command completes", async () => {
    vi.useFakeTimers();
    const observed = installObservationDouble({
      detect: () => ({ _tag: "Unchanged" }),
    });
    const { result } = renderObservation(projection());
    await flush();
    expect(observed.detectCount()).toBe(1);
    const first = deferred<string>();
    const second = deferred<string>();

    void result.current.runDirectCommand(() => first.promise);
    void result.current.runDirectCommand(() => second.promise);
    await flush(DETECT_INTERVAL_MS);
    expect(observed.detectCount()).toBe(1);

    await act(async () => {
      first.resolve("first");
      await vi.advanceTimersByTimeAsync(DETECT_INTERVAL_MS);
    });
    expect(observed.detectCount()).toBe(1);

    await act(async () => {
      second.resolve("second");
      await vi.advanceTimersByTimeAsync(DETECT_INTERVAL_MS);
    });
    expect(observed.detectCount()).toBe(2);
  });

  it("discards a detection result a direct command overtook", async () => {
    vi.useFakeTimers();
    const detection = deferred<unknown>();
    installObservationDouble({
      detect: (call) =>
        call === 1 ? detection.promise : { _tag: "Unchanged" },
    });
    const { result, replace, patch } = renderObservation(projection());
    await flush();

    void result.current.runDirectCommand(async () => "written");
    await flush();
    await act(async () => {
      detection.resolve({ _tag: "Reconciled", projection: projection() });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(replace).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("useReviewObservation observation outcomes", () => {
  it("replaces the projection for a Reconciled observation of the same snapshot", async () => {
    vi.useFakeTimers();
    const reconciled = projection({
      pullRequest: {
        ...projection().pullRequest,
        title: "Reconciled workbench",
      },
    } as never);
    installObservationDouble({
      detect: (call) =>
        call === 1
          ? { _tag: "Unchanged" }
          : { _tag: "Reconciled", projection: reconciled },
    });
    const { result, replace } = renderObservation(projection());
    await flush();

    await act(async () => {
      await result.current.observeConfirmedReviewWrite();
    });
    expect(replace).toHaveBeenCalledWith(reconciled);
  });

  it("patches the Review status for a Terminal observation", async () => {
    vi.useFakeTimers();
    installObservationDouble({
      detect: (call) =>
        call === 1
          ? { _tag: "Unchanged" }
          : { _tag: "Terminal", status: "merged" },
    });
    const { result, patch } = renderObservation(projection());
    await flush();

    await act(async () => {
      await result.current.observeConfirmedReviewWrite();
    });
    expect(patch).toHaveBeenCalledWith({
      review: { id: "review-42", status: "merged" },
    });
  });

  it("carries the recent-write journal into the next detect-updates request", async () => {
    vi.useFakeTimers();
    const observed = installObservationDouble({
      detect: () => ({ _tag: "Unchanged" }),
    });
    const { result } = renderObservation(projection());
    await flush();
    expect(observed.detectBodies[0]).toEqual({
      profileId: "profile",
      reviewId: "review-42",
    });

    act(() => {
      result.current.appendRecentWrites({
        _tag: "DirectSummaryReview",
        reviewId: "9002",
      });
    });
    await flush(DETECT_INTERVAL_MS);

    expect(observed.detectBodies[1]).toEqual({
      profileId: "profile",
      reviewId: "review-42",
      recentWrites: [{ _tag: "DirectSummaryReview", reviewId: "9002" }],
    });
  });

  it("refreshes by reviewId, replaces the projection, and clears the journal", async () => {
    vi.useFakeTimers();
    const refreshed = projection({
      session: { ...projection().session, id: "session-b" },
    });
    const observed = installObservationDouble({
      detect: () => ({ _tag: "Unchanged" }),
      refresh: () => refreshed,
    });
    const { result, replace } = renderObservation(projection());
    await flush();
    act(() => {
      result.current.appendRecentWrites({
        _tag: "DirectSummaryReview",
        reviewId: "9002",
      });
    });

    await act(async () => {
      await result.current.refresh();
    });
    expect(replace).toHaveBeenCalledWith(refreshed);
    expect(result.current.refreshError).toBe(false);

    await flush(DETECT_INTERVAL_MS);
    expect(observed.detectBodies.at(-1)).toEqual({
      profileId: "profile",
      reviewId: "review-42",
    });
  });

  it("reports a refresh failure without replacing the projection", async () => {
    vi.useFakeTimers();
    installObservationDouble({
      detect: () => ({ _tag: "Unchanged" }),
      refresh: () => ({ nothing: "parseable" }),
    });
    const { result, replace } = renderObservation(projection());
    await flush();

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.refreshError).toBe(true);
    expect(result.current.refreshing).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
});
