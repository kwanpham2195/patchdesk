// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BusyProvider } from "../../src/renderer/src/hooks/use-busy";
import { useInboxReviewOpening } from "../../src/renderer/src/flows/use-inbox-review-opening";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import {
  asJsonBody,
  dashboard,
  deferred,
  projection,
  savedRow,
  SHARED_INBOX_ROUTES,
} from "./inbox-flow-fixtures";

const runReviewRow = {
  ...savedRow,
  latestReview: undefined,
  recommendedAction: { kind: "run_review" as const },
};

/** Lets the opening request settle without leaving the notice timer running. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function renderOpening(open: () => ReturnType<typeof asJsonBody> | undefined) {
  installDesktopDouble({
    ...SHARED_INBOX_ROUTES,
    "/v1/reviews/open": () => {
      const body = open();
      return body === undefined
        ? {
            ok: false,
            status: 500,
            correlationId: "open-fail",
            body: { error: "unavailable" },
          }
        : { ok: true, status: 200, correlationId: "open", body };
    },
  });
  return renderHook(
    () => useInboxReviewOpening({ dashboard, onOpenWorkbench: vi.fn() }),
    { wrapper: BusyProvider },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useInboxReviewOpening notice timing", () => {
  it("clears the opened notice after six seconds", async () => {
    const { result } = renderOpening(() => asJsonBody(projection));

    act(() => {
      // SAFETY: the hook reads only the row fields this fixture supplies.
      result.current.openInboxRow(runReviewRow as never);
    });
    await settle();
    expect(result.current.openedPr).toBe("owner/repo#1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(result.current.openedPr).toBeUndefined();
  });

  it("clears the opened notice on dismiss and cancels its timer", async () => {
    const { result } = renderOpening(() => asJsonBody(projection));

    act(() => {
      // SAFETY: the hook reads only the row fields this fixture supplies.
      result.current.openInboxRow(runReviewRow as never);
    });
    await settle();
    expect(result.current.openedPr).toBe("owner/repo#1");
    // Other renderer timers (the log flush) run alongside, so the cancelled
    // auto-clear shows as one fewer pending timer, not as an empty queue.
    const timersWhileShowing = vi.getTimerCount();

    act(() => {
      result.current.dismissOpenedPr();
    });
    expect(result.current.openedPr).toBeUndefined();
    expect(vi.getTimerCount()).toBe(timersWhileShowing - 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(result.current.openedPr).toBeUndefined();
  });

  it("clears a reported error and a failed row operation on dismiss", async () => {
    const { result } = renderOpening(() => undefined);

    act(() => {
      // SAFETY: the hook reads only the row fields this fixture supplies.
      result.current.openInboxRow(runReviewRow as never);
    });
    await settle();
    act(() => {
      result.current.reportOpenError("Paste names another host.");
    });
    expect(result.current.openError).toBe("Paste names another host.");
    expect(
      [...result.current.openingOperations.values()].some(
        ({ status }) => status === "error",
      ),
    ).toBe(true);

    act(() => {
      result.current.dismissOpenError();
    });
    expect(result.current.openError).toBeUndefined();
    expect(result.current.openingOperations.size).toBe(0);
  });
});

/**
 * Two entry points can name one stored Review in the same event turn: the
 * second is turned away because the load is already in flight, so the hook
 * has to answer to whichever of them is still live when the payload arrives.
 */
describe("useInboxReviewOpening stored-review loading", () => {
  function renderStoredReviewOpening() {
    const load = deferred<ReturnType<typeof success>>();
    installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      "/v1/reviews/load": () => load.promise,
    });
    const onOpenWorkbench = vi.fn();
    const { result } = renderHook(
      () => useInboxReviewOpening({ dashboard, onOpenWorkbench }),
      { wrapper: BusyProvider },
    );
    return { load, onOpenWorkbench, result };
  }

  it("lands the payload on the caller still live when the one that started the load has gone", async () => {
    const { load, onOpenWorkbench, result } = renderStoredReviewOpening();
    let firstCallerActive = true;

    act(() => {
      void result.current.openStoredReviewById(
        "profile",
        "review-1",
        () => firstCallerActive,
      );
      void result.current.openStoredReviewById(
        "profile",
        "review-1",
        () => true,
      );
    });
    // The flow that asked first unmounts while the single request is in
    // flight, which is what remounting InboxFlow behind the workbench does.
    firstCallerActive = false;
    load.resolve(success(asJsonBody(projection)));
    await settle();

    expect(onOpenWorkbench).toHaveBeenCalledTimes(1);
  });

  it("drops the payload when every caller waiting on the load has gone", async () => {
    const { load, onOpenWorkbench, result } = renderStoredReviewOpening();
    let anyCallerActive = true;

    act(() => {
      void result.current.openStoredReviewById(
        "profile",
        "review-1",
        () => anyCallerActive,
      );
      void result.current.openStoredReviewById(
        "profile",
        "review-1",
        () => anyCallerActive,
      );
    });
    anyCallerActive = false;
    load.resolve(success(asJsonBody(projection)));
    await settle();

    expect(onOpenWorkbench).not.toHaveBeenCalled();
  });
});

/**
 * A destination restored from localStorage can name a Review the retention
 * sweep has since deleted, so the boot restore asks to handle that itself
 * rather than have the screen raise its "Could not open review" alert.
 */
describe("useInboxReviewOpening restore of a deleted Review", () => {
  function renderMissingStoredReview() {
    installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      "/v1/reviews/load": () => failure({ error: "not_found" }, 404),
    });
    return renderHook(
      () => useInboxReviewOpening({ dashboard, onOpenWorkbench: vi.fn() }),
      { wrapper: BusyProvider },
    );
  }

  it("hands a missing record to the boot restore instead of raising the open error", async () => {
    const { result } = renderMissingStoredReview();
    const onMissingRecord = vi.fn();

    act(() => {
      void result.current.openStoredReviewById(
        "profile",
        "review-1",
        () => true,
        onMissingRecord,
      );
    });
    await settle();

    expect(onMissingRecord).toHaveBeenCalledTimes(1);
    expect(result.current.openError).toBeUndefined();
  });

  it("reports a missing record to a caller that did not offer to handle it", async () => {
    const { result } = renderMissingStoredReview();

    act(() => {
      void result.current.openStoredReviewById(
        "profile",
        "review-1",
        () => true,
      );
    });
    await settle();

    expect(result.current.openError).not.toBeUndefined();
  });
});
