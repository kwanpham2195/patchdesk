import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InboxRefreshScheduler,
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
    const outcomes: Array<"success" | "failure"> = ["failure", "failure", "failure", "failure", "success"];
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

  it("shares one request when manual refresh happens during an active scan", async () => {
    vi.useFakeTimers();
    let resolve: ((outcome: "success") => void) | undefined;
    const refresh = vi.fn(
      () => new Promise<"success">((next) => { resolve = next; }),
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
