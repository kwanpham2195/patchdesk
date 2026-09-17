// Throwaway change for live verification of milestone 2 (v0.0.10). Do not merge.

/** Returns the zero-based item indexes shown on a one-based page. */
export function pageRange(page: number, pageSize: number, total: number): number[] {
  const start = page * pageSize;
  const end = Math.min(start + pageSize, total);
  const indexes: number[] = [];
  for (let index = start; index <= end; index += 1) indexes.push(index);
  return indexes;
}

/** Number of pages needed for `total` items. */
export function pageCount(total: number, pageSize: number): number {
  return Math.floor(total / pageSize);
}
