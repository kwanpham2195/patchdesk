/**
 * One in-process owner for every operation that can change or reconcile one
 * Review. `withReviewLock` queues read reconciliation after an active write;
 * command callers use the non-waiting acquire/release pair to return an
 * immediate in-progress result instead of waiting behind another user action.
 */
/** Serializes every mutation or reconciliation for one Review. */
export class ReviewOperationCoordinator {
  private readonly latest = new Map<string, LockEntry>();
  private readonly acquired = new Map<string, LockEntry>();

  /** Run after any existing operation for the same Review completes. */
  async withReviewLock<T>(
    profileId: string,
    reviewId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${profileId}:${reviewId}`;
    const predecessor = this.latest.get(key);
    const current = deferred();
    this.latest.set(key, current);
    if (predecessor !== undefined) await predecessor.done;
    try {
      return await operation();
    } finally {
      current.release();
      if (this.latest.get(key) === current) this.latest.delete(key);
    }
  }

  /**
   * Command callers must not wait behind another remote mutation. This retains
   * an immediate typed in-progress result while sharing the same lock with
   * refresh, observation, and recovery.
   */
  acquire(key: string): boolean {
    if (this.latest.has(key)) return false;
    const entry = deferred();
    this.latest.set(key, entry);
    this.acquired.set(key, entry);
    return true;
  }

  release(key: string): void {
    const entry = this.acquired.get(key);
    if (entry === undefined) return;
    this.acquired.delete(key);
    entry.release();
    if (this.latest.get(key) === entry) this.latest.delete(key);
  }
}

type LockEntry = {
  readonly done: Promise<void>;
  release(): void;
};

function deferred(): LockEntry {
  let release: (() => void) | undefined;
  const done = new Promise<void>((complete) => {
    release = complete;
  });
  return {
    done,
    release: () => release?.(),
  };
}
