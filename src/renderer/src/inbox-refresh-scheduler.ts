export function inboxFreshnessLabel(input: {
  readonly remote?:
    | "current"
    | "partial"
    | "failed_cached"
    | "stale_cached"
    | "unavailable"
    | undefined;
  readonly refreshing: boolean;
  readonly refreshFailed?: boolean;
  readonly refreshedAt?: string | undefined;
  readonly now?: number;
}):
  | "Refreshing"
  | "Current"
  | "Aged"
  | "Partial"
  | "Cached after refresh failure"
  | "Stale"
  | "Unavailable" {
  if (input.refreshing) return "Refreshing";
  if (input.refreshFailed === true) return "Cached after refresh failure";
  if (input.remote === "partial") return "Partial";
  if (input.remote === "stale_cached") return "Stale";
  if (input.remote === "failed_cached") return "Cached after refresh failure";
  if (input.remote === "unavailable") return "Unavailable";
  const refreshedAt =
    input.refreshedAt === undefined
      ? Number.NaN
      : Date.parse(input.refreshedAt);
  if (
    !Number.isNaN(refreshedAt) &&
    (input.now ?? Date.now()) - refreshedAt > 120_000
  )
    return "Aged";
  return "Current";
}

/** Prose elapsed-time copy for cached/aged freshness states — e.g. "3 hours ago". */
export function formatInboxAge(ms: number): string {
  // An unparseable age (NaN) must fail closed, the same as the freshness
  // policy predicates: it must never read as "moments ago", which would
  // present an unknown-age cache as if it were merely seconds old. A
  // negative age (clock skew, cache genuinely newer than expected) is
  // treated the same as a true sub-minute age below.
  if (Number.isNaN(ms)) return "an unknown time ago";
  if (ms < 60_000) return "moments ago";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
