import { KeyedMutex } from "../domain/keyed-mutex";

/**
 * One in-process owner for every operation that can change or reconcile one
 * Review. `withReviewLock` queues read reconciliation after an active write;
 * command callers use the non-waiting acquire/release pair to return an
 * immediate in-progress result instead of waiting behind another user action.
 */
/** Serializes every mutation or reconciliation for one Review. */
export class ReviewOperationCoordinator {
  private readonly locks = new KeyedMutex();
  private readonly acquired = new Map<string, () => void>();

  /** Run after any existing operation for the same Review completes. */
  async withReviewLock<T>(
    profileId: string,
    reviewId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.locks.run(`${profileId}:${reviewId}`, operation);
  }

  /**
   * Command callers must not wait behind another remote mutation. This retains
   * an immediate typed in-progress result while sharing the same lock with
   * refresh, observation, and recovery.
   */
  acquire(key: string): boolean {
    const release = this.locks.tryEnter(key);
    if (release === undefined) return false;
    this.acquired.set(key, release);
    return true;
  }

  release(key: string): void {
    const release = this.acquired.get(key);
    if (release === undefined) return;
    this.acquired.delete(key);
    release();
  }
}
