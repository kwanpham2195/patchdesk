import type { WorkspaceProfileId } from "../domain/ids";

/** Serializes durable review lifecycle mutations per workspace profile. */
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
