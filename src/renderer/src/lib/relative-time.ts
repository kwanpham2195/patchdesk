const exactTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * A short age for a timestamp: "45 s ago", "2 min ago", "14 h ago", "3 d ago".
 * A future timestamp clamps to "just now" rather than counting backwards, and
 * an unreadable value comes back as given so nothing is hidden.
 */
export function formatRelativeTime(
  iso: string,
  now: number = Date.now(),
): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const seconds = Math.floor((now - timestamp) / 1_000);
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * The same age in the width a narrow column can spare: "45s", "2m", "14h",
 * "3d", "yesterday", "8w". Boundaries match `formatRelativeTime` up to a day;
 * past that the column names the day before and rolls over to weeks at
 * twenty-eight days, where a day count stops being worth reading.
 */
export function formatCompactRelativeTime(
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
  if (days === 1) return "yesterday";
  if (days < 28) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** The exact time a relative age stands for, shown on hover. */
export function formatExactTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  return exactTimeFormatter.format(timestamp);
}
