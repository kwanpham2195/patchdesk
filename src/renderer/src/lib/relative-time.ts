const exactTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * The one short age every relative time in the app uses: "now", "45s", "2m",
 * "14h", "3d", then "8w" from twenty-eight days, where a day count stops being
 * worth reading. It fits a narrow column (ADR 0042); the caller's own word
 * ("checked", "seen") says what the age is of. Elapsed hours never name a
 * calendar day, since a visited row's date header buckets by local day and the
 * two disagree across midnight. A future timestamp clamps to "now", and an
 * unreadable value comes back as given so nothing is hidden.
 */
export function formatRelativeTime(
  iso: string,
  now: number = Date.now(),
): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const seconds = Math.floor((now - timestamp) / 1_000);
  if (seconds < 1) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 28) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** The exact time a relative age stands for, shown on hover. */
export function formatExactTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  return exactTimeFormatter.format(timestamp);
}
