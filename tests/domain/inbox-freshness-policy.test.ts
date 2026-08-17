import { describe, expect, it } from "vitest";
import {
  INBOX_CACHE_DEGRADED_AFTER_MS,
  INBOX_CACHE_REFUSE_AFTER_MS,
  isInboxCacheDegraded,
  isInboxCacheStale,
} from "../../src/domain/inbox-freshness-policy";

describe("inbox cache freshness policy", () => {
  it("is not degraded or stale just under each threshold", () => {
    expect(isInboxCacheDegraded(INBOX_CACHE_DEGRADED_AFTER_MS - 1)).toBe(false);
    expect(isInboxCacheStale(INBOX_CACHE_REFUSE_AFTER_MS - 1)).toBe(false);
  });
  it("flips exactly at each threshold", () => {
    expect(isInboxCacheDegraded(INBOX_CACHE_DEGRADED_AFTER_MS)).toBe(true);
    expect(isInboxCacheStale(INBOX_CACHE_REFUSE_AFTER_MS)).toBe(true);
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
