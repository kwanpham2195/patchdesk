import { describe, expect, it } from "vitest";

import { inboxFreshnessLabel } from "../../src/renderer/src/inbox-freshness";

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
