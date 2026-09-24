import type { InboxSnapshotState } from "../../domain/maintainer-inbox";

/**
 * The maintainer-facing copy for how current the inbox rows are. This is
 * presentation, not policy: every value below is English shown in a badge,
 * and none of them is a rule about what Patchdesk will serve. The rules live in
 * `src/domain/inbox-freshness-policy.ts` — `isInboxCacheDegraded` and
 * `isInboxCacheStale` — which the main-process service also imports, and
 * which this module deliberately does not join: moving user-visible copy
 * there would put renderer strings in a module the main process loads.
 */

/** The freshness badge text the inbox shows for how current its rows are. */
export type InboxFreshnessLabel =
  | "Refreshing"
  | "Current"
  | "Partial"
  | "Cached after refresh failure"
  | "Stale"
  | "Unavailable";

export function inboxFreshnessLabel(input: {
  readonly remote?: InboxSnapshotState | undefined;
  readonly refreshing: boolean;
  readonly refreshFailed?: boolean;
}): InboxFreshnessLabel {
  if (input.refreshing) return "Refreshing";
  if (input.refreshFailed === true) return "Cached after refresh failure";
  if (input.remote === "partial") return "Partial";
  if (input.remote === "stale_cached") return "Stale";
  if (input.remote === "failed_cached") return "Cached after refresh failure";
  if (input.remote === "unavailable") return "Unavailable";
  return "Current";
}
