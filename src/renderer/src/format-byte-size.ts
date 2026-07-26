/**
 * Format a non-negative byte count as a human-readable string.
 *
 * Uses binary (1024) units so the result matches the way `du`, `Finder`, and
 * other macOS tools show storage sizes. The renderer is the only consumer;
 * main-process services keep raw numbers and never rely on formatted output.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${rounded} ${units[unitIndex]}`;
}
