const locks = new Map<string, Promise<void>>();

/** Serializes every durable mutation for one profile/session, including draft edits and Analysis transitions. */
export async function withReviewSessionMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}
