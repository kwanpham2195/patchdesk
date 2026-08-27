import type { WorkspaceProfileId } from "../domain/ids";

/**
 * Serializes durable review lifecycle mutations per workspace profile.
 *
 * This is the INNER lock of the one global lock order. A caller may take it
 * while holding `ReviewOperationCoordinator.withReviewLock`; it must never
 * take that Review lock while holding this one. Neither lock is reentrant and
 * both are held across `await`s, so the opposite order waits forever.
 * `tests/services/review-lock-order.test.ts` asserts the order.
 */
export class ReviewLifecycleGate {
  private readonly locks = new Map<string, Promise<void>>();

  /** Run one profile-scoped mutation after all earlier mutations finish. */
  async withProfileLock<T>(
    profileId: WorkspaceProfileId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = String(profileId);
    const predecessor = this.locks.get(key);
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await predecessor;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}
