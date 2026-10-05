/**
 * Runs operations in order per key, releasing even if one throws or rejects.
 * Different keys do not wait. Enqueuing before the first `await` orders
 * same-tick calls.
 *
 * This mutex is not reentrant: nesting the same key waits forever. Locks span
 * `await`s, so callers take the Review lock before the profile lock; allowing
 * a nested take would corrupt state protected by the outer lock.
 * `tests/services/review-lock-order.test.ts` and
 * `tests/domain/keyed-mutex.test.ts` pin these contracts.
 */
export class KeyedMutex {
  /** The tail of each key's queue: resolves when that last run releases. */
  private readonly latest = new Map<string, Promise<void>>();

  /** Run `operation` after every operation already queued for `key`. */
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.latest.get(key);
    const release = this.enqueue(key);
    if (predecessor !== undefined) await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Take `key` only when it is free, without waiting. Returns the release
   * function on success and `undefined` when the key is already held or
   * queued, so a caller can report "in progress" instead of waiting behind
   * another user action. The caller owns the release.
   */
  tryEnter(key: string): (() => void) | undefined {
    if (this.latest.has(key)) return undefined;
    return this.enqueue(key);
  }

  /** Publish a new queue tail for `key` and return its idempotent release. */
  private enqueue(key: string): () => void {
    let resolve: () => void = () => undefined;
    const current = new Promise<void>((settle) => {
      resolve = settle;
    });
    this.latest.set(key, current);
    return () => {
      resolve();
      if (this.latest.get(key) === current) this.latest.delete(key);
    };
  }
}
