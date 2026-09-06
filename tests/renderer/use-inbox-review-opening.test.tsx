// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BusyProvider } from "../../src/renderer/src/hooks/use-busy";
import { useInboxReviewOpening } from "../../src/renderer/src/flows/use-inbox-review-opening";
import { installDesktopDouble } from "./fake-desktop-response";
import {
  asJsonBody,
  dashboard,
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
