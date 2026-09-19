// Throwaway helper for the ADR 0046 live write check. Never merged.
export function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

export function percentLabel(value: number): string {
  return `${clampPercent(value)}%`;
}
