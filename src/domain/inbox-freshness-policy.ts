/**
 * Single source of truth for how long a cached maintainer-inbox snapshot may
 * be presented before Patchdesk stops treating it as current. Imported by
 * both the main-process service (hard refusal) and the renderer (visible
 * aging copy) so the two layers cannot drift apart.
 */
export const INBOX_CACHE_DEGRADED_AFTER_MS = 30 * 60 * 1000; // 30 minutes
export const INBOX_CACHE_REFUSE_AFTER_MS = 4 * 60 * 60 * 1000; // 4 hours

export function isInboxCacheDegraded(ageMs: number): boolean {
  // An unparseable age (NaN) must fail closed: presenting a cache of
  // unknown age as merely "recent" would be worse than the staleness bug
  // this policy exists to fix. A negative age is a different situation —
  // clock skew put the read clock behind the save clock, so the cache is
  // genuinely newer than expected, not stale — and correctly falls through
  // to the ordinary (false) comparison below.
  if (Number.isNaN(ageMs)) return true;
  return ageMs >= INBOX_CACHE_DEGRADED_AFTER_MS;
}

export function isInboxCacheStale(ageMs: number): boolean {
  // See isInboxCacheDegraded: NaN fails closed, negative age fails open.
  if (Number.isNaN(ageMs)) return true;
  return ageMs >= INBOX_CACHE_REFUSE_AFTER_MS;
}
