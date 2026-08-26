import { describe, expect, it } from "vitest";

import {
  formatInboxAge,
  inboxFreshnessLabel,
} from "../../src/renderer/src/inbox-refresh-scheduler";

describe("inboxFreshnessLabel", () => {
  it("returns Stale for a hard-refused cached snapshot", () => {
    expect(
      inboxFreshnessLabel({
        remote: "stale_cached",
        refreshing: false,
      }),
    ).toBe("Stale");
  });

  it("still returns the cached-after-failure label unchanged", () => {
    expect(
      inboxFreshnessLabel({
        remote: "failed_cached",
        refreshing: false,
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
