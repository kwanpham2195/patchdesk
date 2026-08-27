/**
 * Map `items` with at most `concurrency` calls in flight, keeping the result
 * order of `items`. Rejections propagate: the first failing `map` rejects the
 * whole call, exactly as `Promise.all` does.
 */
export async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> {
  const values: Array<R> = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    const item = items[index];
    if (item === undefined) return;
    values[index] = await map(item);
    return worker();
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return values;
}
