export type InboxRefreshReason =
  | "entry"
  | "foreground"
  | "poll"
  | "retry"
  | "manual";
export type InboxRefreshOutcome = "success" | "failure";

const POLL_DELAY_MS = 60_000;
const RETRY_DELAYS_MS = [60_000, 120_000, 240_000, 300_000] as const;

/**
 * Renderer-only timing policy for a visible Inbox. It owns no data and makes
 * no assumptions about review state; callers provide the read-only request.
 */
export class InboxRefreshScheduler {
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private failures = 0;

  constructor(
    private readonly refresh: (
      reason: InboxRefreshReason,
    ) => Promise<InboxRefreshOutcome>,
  ) {}

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.schedule("entry", 0);
  }

  /** The initial API load already refreshed Inbox; start its next poll only. */
  activateAfterSuccessfulResponse(): void {
    if (this.active) return;
    this.active = true;
    this.failures = 0;
    this.schedule("poll", POLL_DELAY_MS);
  }

  deactivate(): void {
    this.active = false;
    this.clearTimer();
  }

  setForeground(foreground: boolean): void {
    if (!foreground) {
      this.deactivate();
      return;
    }
    if (!this.active) {
      this.active = true;
      this.schedule("foreground", 0);
    }
  }

  refreshManual(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return this.request("manual");
  }

  private schedule(reason: InboxRefreshReason, delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.request(reason);
    }, delay);
  }

  private request(reason: InboxRefreshReason): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    this.clearTimer();
    const request = this.refresh(reason)
      .then((outcome) => {
        if (!this.active) return;
        if (outcome === "success") {
          this.failures = 0;
          this.schedule("poll", POLL_DELAY_MS);
          return;
        }
        const delay =
          RETRY_DELAYS_MS[
            Math.min(this.failures, RETRY_DELAYS_MS.length - 1)
          ] ?? 300_000;
        this.failures += 1;
        this.schedule("retry", delay);
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = request;
    return request;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export function inboxFreshnessLabel(input: {
  readonly remote?:
    | "current"
    | "partial"
    | "failed_cached"
    | "stale_cached"
    | "unavailable"
    | undefined;
  readonly refreshing: boolean;
  readonly paused: boolean;
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
  | "Unavailable"
  | "Paused" {
  if (input.refreshing) return "Refreshing";
  if (input.paused) return "Paused";
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
