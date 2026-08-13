import { describe, expect, it } from "vitest";

import {
  RECOVERY_ACTION_KEYS,
  cleanupCopy,
  recoveryActionLabel,
} from "../../src/renderer/src/review-copy";

describe("review copy contract", () => {
  it("keeps action labels stable regardless of persisted display labels", () => {
    expect(RECOVERY_ACTION_KEYS.map(recoveryActionLabel)).toEqual([
      "Run Analysis",
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
      body: "This removes completed and failed local reviews. An active review and diagnostic reports stay.",
      confirmLabel: "Clear local data",
    });
  });
});
