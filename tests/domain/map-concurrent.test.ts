import { describe, expect, it } from "vitest";

import { mapConcurrent } from "../../src/domain/map-concurrent";

/**
 * Yield `ticks` times, so one `map` call can take measurably longer than
 * another without a wall-clock timer. Microtasks drain in FIFO order, so a
 * larger `ticks` deterministically settles later.
 */
async function settleAfterTicks(ticks: number): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
}

describe("mapConcurrent", () => {
  it("keeps input order and never exceeds the concurrency bound", async () => {
    const items = [0, 1, 2, 3, 4, 5, 6];
    let inFlight = 0;
    let peak = 0;
    const completed: Array<number> = [];

    // Per-item latency that falls as the index rises, so completion order is
    // not input order. Without the stagger this test cannot observe order at
    // all: every item would finish in the order it started, and appending
    // results in completion order would look identical to writing each result
    // to its own index.
    const mapped = await mapConcurrent(items, 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await settleAfterTicks((items.length - item) * 3);
      inFlight -= 1;
      completed.push(item);
      return item * 2;
    });

    expect(mapped).toEqual([0, 2, 4, 6, 8, 10, 12]);
    // Guards the guard: if the fixture ever stops staggering, the assertion
    // above stops testing order preservation and nothing else would say so.
    expect(completed).not.toEqual(items);
    expect(peak).toBe(3);
  });

  it("starts no more workers than there are items", async () => {
    let started = 0;

    await mapConcurrent([1, 2], 8, async (item) => {
      started += 1;
      return item;
    });

    expect(started).toBe(2);
  });

  it("returns an empty result for no items", async () => {
    await expect(
      mapConcurrent([], 4, async (item: number) => item),
    ).resolves.toEqual([]);
  });

  it("propagates the first rejection", async () => {
    await expect(
      mapConcurrent([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
  });
});
