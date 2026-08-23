import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InboxRefreshScheduler,
  formatInboxAge,
  inboxFreshnessLabel,
  type InboxRefreshReason,
} from "../../src/renderer/src/inbox-refresh-scheduler";

afterEach(() => {
  vi.useRealTimers();
});

describe("inbox refresh scheduler", () => {
  it("refreshes on entry and every sixty seconds after success", async () => {
    vi.useFakeTimers();
    const reasons: Array<InboxRefreshReason> = [];
    const scheduler = new InboxRefreshScheduler(async (reason) => {
      reasons.push(reason);
      return "success";
    });

    scheduler.activate();
    await vi.runOnlyPendingTimersAsync();
    expect(reasons).toEqual(["entry"]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reasons).toEqual(["entry", "poll"]);
  });

  it("pauses while hidden and refreshes immediately when foregrounded", async () => {
    vi.useFakeTimers();
    const reasons: Array<InboxRefreshReason> = [];
    const scheduler = new InboxRefreshScheduler(async (reason) => {
      reasons.push(reason);
      return "success";
    });

    scheduler.activate();
    scheduler.setForeground(false);
    await vi.runOnlyPendingTimersAsync();
    expect(reasons).toEqual([]);

    scheduler.setForeground(true);
    await vi.runOnlyPendingTimersAsync();
    expect(reasons).toEqual(["foreground"]);
  });

  it("uses capped exponential backoff while manual refresh bypasses the delay", async () => {
    vi.useFakeTimers();
    const reasons: Array<InboxRefreshReason> = [];
    const outcomes: Array<"success" | "failure"> = [
      "failure",
      "failure",
      "failure",
      "failure",
      "success",
    ];
    const scheduler = new InboxRefreshScheduler(async (reason) => {
      reasons.push(reason);
      return outcomes.shift() ?? "success";
    });

    scheduler.activate();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(reasons).toEqual(["entry"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reasons).toEqual(["entry", "retry"]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reasons).toEqual(["entry", "retry", "retry"]);

    await scheduler.refreshManual();
    expect(reasons).toEqual(["entry", "retry", "retry", "manual"]);
  });

  it("waits for a rate-limited outcome's resumeAt instead of the poll/backoff cadence, and does not touch the failures ladder", async () => {
    vi.useFakeTimers();
    const reasons: Array<InboxRefreshReason> = [];
    const resumeAt = new Date(Date.now() + 90 * 60_000).toISOString();
    const outcomes: Array<
      | "success"
      | "failure"
      | { readonly kind: "rate_limited"; readonly resumeAt: string }
    > = [{ kind: "rate_limited", resumeAt }, "failure"];
    const scheduler = new InboxRefreshScheduler(async (reason) => {
      reasons.push(reason);
      return outcomes.shift() ?? "success";
    });

    scheduler.activate();
    await vi.runOnlyPendingTimersAsync();
    expect(reasons).toEqual(["entry"]);

    // Neither the 60s poll cadence nor the RETRY_DELAYS_MS ladder (capped at
    // 300s) should fire before resumeAt, which is 90 minutes out.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(reasons).toEqual(["entry"]);

    await vi.advanceTimersByTimeAsync(90 * 60_000 - 300_000);
    expect(reasons).toEqual(["entry", "retry"]);

    // The rate-limited wait must not have incremented the failures ladder:
    // this next failure should retry at the first backoff step (60s), not a
    // later one, proving the ladder still starts from zero.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(reasons).toEqual(["entry", "retry"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reasons).toEqual(["entry", "retry", "retry"]);
  });

  it("shares one request when manual refresh happens during an active scan", async () => {
    vi.useFakeTimers();
    let resolve: ((outcome: "success") => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<"success">((next) => {
          resolve = next;
        }),
    );
    const scheduler = new InboxRefreshScheduler(refresh);

    scheduler.activate();
    await vi.runOnlyPendingTimersAsync();
    const manual = scheduler.refreshManual();

    expect(refresh).toHaveBeenCalledTimes(1);
    resolve?.("success");
    await manual;
  });
});

describe("inboxFreshnessLabel", () => {
  it("returns Stale for a hard-refused cached snapshot", () => {
    expect(
      inboxFreshnessLabel({
        remote: "stale_cached",
        refreshing: false,
        paused: false,
      }),
    ).toBe("Stale");
  });

  it("still returns the cached-after-failure label unchanged", () => {
    expect(
      inboxFreshnessLabel({
        remote: "failed_cached",
        refreshing: false,
        paused: false,
      }),
    ).toBe("Cached after refresh failure");
  });
});

describe("formatInboxAge", () => {
  it("formats boundary ages", () => {
    expect(formatInboxAge(59_999)).toBe("moments ago");
    expect(formatInboxAge(60_000)).toBe("1 minute ago");
    expect(formatInboxAge(3_599_999)).toBe("1 hour ago");
    expect(formatInboxAge(3_600_000)).toBe("1 hour ago");
    expect(formatInboxAge(86_400_000)).toBe("1 day ago");
  });

  it("fails closed on an unparseable (NaN) age instead of reading as fresh", () => {
    expect(formatInboxAge(Number.NaN)).not.toBe("moments ago");
    expect(formatInboxAge(Number.NaN)).toBe("an unknown time ago");
  });
});
