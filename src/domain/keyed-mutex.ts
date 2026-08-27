/**
 * Serializes asynchronous operations per key.
 *
 * Every `run` for one key waits for the run queued before it, then executes,
 * then releases — including when the operation throws or rejects. Different
 * keys never wait for each other. The queue entry is published synchronously,
 * before the first `await`, so two callers in the same tick still queue.
 *
 * This mutex is deliberately NOT reentrant: `run(key, () => run(key, fn))`
 * waits forever. Patchdesk holds these locks across `await`s and pins one
 * global lock order (Review lock outer, profile lock inner) precisely because
 * a nested take is a bug. A reentrant mutex would let such a nested take
 * proceed and corrupt the state the outer lock was protecting instead of
 * hanging where a test can see it. `tests/services/review-lock-order.test.ts`
 * pins the order; `tests/domain/keyed-mutex.test.ts` pins this primitive.
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
