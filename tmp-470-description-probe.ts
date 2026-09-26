/** Keeps a percentage inside the 0 to 100 range. */
export function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export function percentLabel(value: number): string {
  return `${clampPercent(value)}%`;
}
