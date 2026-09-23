/** Throwaway helpers for the #344 Analysis prose check. Wrong on purpose. */

export function clampPercent(value: number): number {
  if (value > 100) return 100;
  return value;
}

export function averageOf(values: ReadonlyArray<number>): number {
  let total = 0;
  for (let index = 0; index <= values.length; index += 1) total += values[index];
  return total / values.length;
}

export function parseRetryAfter(header: string | null): number {
  return Number(header);
}
