import { describe, expect, it } from "vitest";

import {
  RECOVERY_ACTION_KEYS,
  RECOVERY_NOTICE_KEYS,
  cleanupCopy,
  recoveryActionLabel,
  recoveryCopy,
} from "../../src/renderer/src/review-copy";

describe("review copy contract", () => {
  it("maps every recovery notice to friendly copy and at most one action", () => {
    for (const key of RECOVERY_NOTICE_KEYS) {
      const copy = recoveryCopy(key);
      expect(copy.notice).not.toMatch(/session|attempt|quarantine|worktree|runtime|storage|error/i);
      expect(copy.reassurance).not.toMatch(/session|attempt|quarantine|worktree|runtime|storage|error/i);
      if (copy.actionKey !== undefined) {
        expect(copy.actionLabel).toBe(recoveryActionLabel(copy.actionKey));
      }
    }
  });

  it("keeps action labels stable regardless of persisted display labels", () => {
    expect(RECOVERY_ACTION_KEYS.map(recoveryActionLabel)).toEqual([
      "Run review",
      "Reconnect",
      "Start again",
      "Try again",
      "Prepare again",
    ]);
  });

  it("defines exact cleanup retention copy", () => {
    expect(cleanupCopy("clear_cache")).toEqual({
      title: "Clear cache?",
      body: "This removes rebuildable local files. Your saved reviews and diagnostic reports stay.",
      confirmLabel: "Clear cache",
    });
    expect(cleanupCopy("clear_local_review_data")).toEqual({
      title: "Clear local review data?",
      body: "This removes discarded and unusable local review data. Reviews you can still open or resume, and diagnostic reports, stay.",
      confirmLabel: "Clear local data",
    });
  });
});
