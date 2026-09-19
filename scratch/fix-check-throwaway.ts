// Throwaway helper for a live fix check. Never merged.
export function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

export function percentLabel(value: number): string {
  return `${clampPercent(value)}%`;
}
