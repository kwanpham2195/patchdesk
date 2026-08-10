/** Serializes all remote review writes for one profile/review pair. */
export class ReviewWriteCoordinator {
  private readonly active = new Set<string>();

  acquire(key: string): boolean {
    if (this.active.has(key)) return false;
    this.active.add(key);
    return true;
  }

  release(key: string): void {
    this.active.delete(key);
  }
}
