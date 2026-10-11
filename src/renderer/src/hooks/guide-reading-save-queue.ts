import type {
  GuideReadingContent,
  GuideReadingState,
} from "#src/domain/guide-reading-state";
import { isApiErrorCode } from "#src/renderer/src/api-client";

/** Stable subscription snapshot includes optimistic edits and a persistence refusal. */
export type GuideReadingSaveSnapshot = {
  readonly progress: GuideReadingState;
  readonly saveFailed: boolean;
};

/** One retained result serializes saves and keeps unsaved edits after a refusal. */
export class GuideReadingSaveQueue {
  private confirmed: GuideReadingState;
  private dirty = false;
  private inFlight: Promise<boolean> | undefined;
  private reloadNeeded = false;
  private retired = false;
  private snapshot: GuideReadingSaveSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(
    initial: GuideReadingState,
    private readonly save: (
      state: GuideReadingContent,
      version: number,
    ) => Promise<GuideReadingState | undefined>,
    private readonly reload: () => Promise<GuideReadingState>,
    private readonly onConfirmed: (state: GuideReadingState) => void,
  ) {
    this.confirmed = initial;
    this.snapshot = { progress: initial, saveFailed: false };
  }

  /** Returns the same snapshot until an observable queue change occurs. */
  readonly read = (): GuideReadingSaveSnapshot => this.snapshot;
  /** Unsubscription never interrupts persistence already in flight. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(progress: GuideReadingState, saveFailed: boolean): void {
    this.snapshot = { progress, saveFailed };
    for (const listener of this.listeners) listener();
  }

  /** Coalesces optimistic edits; a failed save requires explicit Retry. */
  edit(content: GuideReadingContent): void {
    if (this.retired) return;
    if (
      JSON.stringify(content) ===
      JSON.stringify({
        reviewedGroupIds: this.snapshot.progress.reviewedGroupIds,
        expandedAppearances: this.snapshot.progress.expandedAppearances,
        anchor: this.snapshot.progress.anchor,
      })
    )
      return;
    this.dirty = true;
    this.publish(
      { ...this.snapshot.progress, ...content },
      this.snapshot.saveFailed,
    );
    if (!this.snapshot.saveFailed) void this.flush();
  }

  /** Adopts newer confirmation without overwriting an unsaved local edit. */
  acceptCanonical(state: GuideReadingState): void {
    if (state.version <= this.confirmed.version || this.inFlight !== undefined)
      return;
    this.confirmed = state;
    if (!this.dirty) this.publish(state, false);
  }

  /** Resolves true only after edits are saved or their retained result was replaced. */
  readonly flush = (): Promise<boolean> => {
    if (this.inFlight !== undefined) return this.inFlight;
    if (this.snapshot.saveFailed) return Promise.resolve(false);
    if (!this.dirty) return Promise.resolve(true);
    const saving = this.drain();
    this.inFlight = saving;
    void saving.finally(() => {
      if (this.inFlight === saving) this.inFlight = undefined;
    });
    return saving;
  };

  /** Reestablishes a conflicted version before retrying the preserved local content. */
  readonly retry = async (): Promise<boolean> => {
    if (this.inFlight !== undefined) await this.inFlight;
    if (this.reloadNeeded) {
      try {
        this.confirmed = await this.reload();
        this.reloadNeeded = false;
      } catch {
        return false;
      }
    }
    this.publish(this.snapshot.progress, false);
    return this.flush();
  };

  private async drain(): Promise<boolean> {
    if (!this.dirty) return true;
    const pending = this.snapshot.progress;
    const content: GuideReadingContent = {
      reviewedGroupIds: pending.reviewedGroupIds,
      expandedAppearances: pending.expandedAppearances,
      anchor: pending.anchor,
    };
    try {
      const saved = await this.save(content, this.confirmed.version);
      // A validated replacement retires this result; its progress cannot transfer to new groups.
      if (saved === undefined) {
        this.retired = true;
        this.dirty = false;
        this.publish(this.snapshot.progress, false);
        return true;
      }
      this.confirmed = saved;
      this.dirty = this.snapshot.progress !== pending;
      this.publish(
        this.dirty
          ? { ...this.snapshot.progress, version: saved.version }
          : saved,
        false,
      );
      this.onConfirmed(saved);
      return this.dirty ? this.drain() : true;
    } catch (cause) {
      this.reloadNeeded = isApiErrorCode(cause, "guide_version_conflict");
      if (this.reloadNeeded) {
        try {
          this.confirmed = await this.reload();
          this.reloadNeeded = false;
        } catch {
          /* Retry must establish the canonical version before another save. */
        }
      }
      this.publish(this.snapshot.progress, true);
      return false;
    }
  }
}
