import { describe, expect, it } from "vitest";

import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

describe("ReviewOperationCoordinator", () => {
  it("queues reconciliation behind an active Review operation", async () => {
    const coordinator = new ReviewOperationCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = coordinator.withReviewLock("cfw", "review", async () => {
      events.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first-end");
    });
    const second = coordinator.withReviewLock("cfw", "review", async () => {
      events.push("second");
    });

    expect(events).toEqual(["first-start"]);
    expect(coordinator.acquire("cfw:review")).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("releases a command lock for the next operation", async () => {
    const coordinator = new ReviewOperationCoordinator();

    expect(coordinator.acquire("cfw:review")).toBe(true);
    expect(coordinator.acquire("cfw:review")).toBe(false);
    coordinator.release("cfw:review");
    expect(coordinator.acquire("cfw:review")).toBe(true);
  });
});
