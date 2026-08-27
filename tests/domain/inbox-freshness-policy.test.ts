import { describe, expect, it } from "vitest";
import {
  isInboxCacheDegraded,
  isInboxCacheStale,
} from "../../src/domain/inbox-freshness-policy";

// The thresholds are written out here rather than imported from the module
// under test, so the test pins the policy instead of restating whatever the
// implementation happens to hold.
const DEGRADED_AFTER_MS = 30 * 60 * 1000;
const REFUSE_AFTER_MS = 4 * 60 * 60 * 1000;

describe("inbox cache freshness policy", () => {
  it("is not degraded or stale just under each threshold", () => {
    expect(isInboxCacheDegraded(DEGRADED_AFTER_MS - 1)).toBe(false);
    expect(isInboxCacheStale(REFUSE_AFTER_MS - 1)).toBe(false);
  });
  it("flips exactly at each threshold", () => {
    expect(isInboxCacheDegraded(DEGRADED_AFTER_MS)).toBe(true);
    expect(isInboxCacheStale(REFUSE_AFTER_MS)).toBe(true);
  });
  it("treats a negative age (clock skew) as not degraded/stale", () => {
    // A negative age means the read clock ran behind the save clock — the
    // cache is genuinely newer than expected, not stale.
    expect(isInboxCacheDegraded(-1)).toBe(false);
    expect(isInboxCacheStale(-1)).toBe(false);
  });
  it("fails closed on an unparseable (NaN) age", () => {
    // Unlike a negative age, NaN carries no information about how old the
    // cache actually is, so it must never read as fresh — it is treated as
    // maximally stale rather than silently passed through as "not stale".
    expect(isInboxCacheDegraded(Number.NaN)).toBe(true);
    expect(isInboxCacheStale(Number.NaN)).toBe(true);
  });
});
