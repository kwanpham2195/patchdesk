import { describe, expect, it } from "vitest";

import { parseWorkspaceProfileId } from "../../src/domain/ids";
import { ReviewLifecycleGate } from "../../src/services/review-lifecycle-gate";

describe("ReviewLifecycleGate", () => {
  it("serializes profile mutations while allowing other profiles to proceed", async () => {
    const profile = parseWorkspaceProfileId("cfw");
    if (profile._tag === "err") throw new Error("fixture");
    const otherProfile = parseWorkspaceProfileId("other");
    if (otherProfile._tag === "err") throw new Error("fixture");
    const gate = new ReviewLifecycleGate();
    const events: string[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = gate.withProfileLock(profile.value, async () => {
      events.push("first-start");
      await held;
      events.push("first-end");
    });
    await Promise.resolve();
    const second = gate.withProfileLock(profile.value, async () => events.push("second"));
    const other = gate.withProfileLock(otherProfile.value, async () => events.push("other"));
    await Promise.resolve();
    expect(events).toEqual(["first-start", "other"]);
    release?.();
    await Promise.all([first, second, other]);
    expect(events).toEqual(["first-start", "other", "first-end", "second"]);
  });
});
