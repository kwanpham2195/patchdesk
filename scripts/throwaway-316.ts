// Throwaway file for the issue #316 live check. It is deleted with its pull request.

export function clampPercent(value: number): number {
  if (value > 100) return 100;
  return value;
}

export function averageOf(values: ReadonlyArray<number>): number {
  let total = 0;
  for (let index = 0; index <= values.length; index += 1) {
    total += values[index] ?? 0;
  }
  return total / values.length;
}
