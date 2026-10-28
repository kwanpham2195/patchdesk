import { afterEach, describe, expect, it, vi } from "vitest";

import { ok } from "#src/domain/result";
import type { BriefReachRequest } from "#src/services/brief-reach-service";
import {
  cleanupRoots,
  fixture,
  must,
  profileId,
  settled,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

describe("Brief cancellation", () => {
  // #813
  it.each([false, true])(
    "cancels during Brief reach and preserves the previous result (terminal lock held: %s)",
    async (holdTerminalLock) => {
      let enterReach!: (request: BriefReachRequest) => void;
      const enteredReach = new Promise<BriefReachRequest>((resolve) => {
        enterReach = resolve;
      });
      let releaseReach!: () => void;
      const reachReleased = new Promise<void>((resolve) => {
        releaseReach = resolve;
      });
      let reachCalls = 0;
      const value = await fixture(
        { invoke: async () => ok({ reachSymbols: ["guard"] }) },
        {
          reach: async (request) => {
            reachCalls += 1;
            if (reachCalls === 2) {
              enterReach(request);
              await reachReleased;
            }
            return { _tag: "unavailable", reason: "search_failed" };
          },
        },
      );
      const start = () =>
        value.coordinator.start({
          provider: "codex-cli-account",
          profileId,
          reviewId: value.review.id,
          type: "brief",
          model: "model",
          reasoning: "medium",
          language: "en",
        });
      const previous = must(await start());
      await settled(
        value.coordinator,
        value.review.id,
        previous.runId,
        "brief",
      );
      const retained = must(
        await value.insights.load(profileId, value.review.id, "brief"),
      ).retained;
      const started = must(await start());
      const request = await enteredReach;
      let enterLock!: () => void;
      const lockEntered = new Promise<void>((resolve) => {
        enterLock = resolve;
      });
      let releaseLock!: () => void;
      const lockReleased = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const held = holdTerminalLock
        ? value.operations.withReviewLock(
            profileId,
            value.review.id,
            async () => {
              enterLock();
              await lockReleased;
            },
          )
        : Promise.resolve();
      if (holdTerminalLock) await lockEntered;
      // oxlint-disable-next-line patchdesk/no-method-spying -- The fixture builds the operation coordinator internally; counting lock entries orders cancel against terminal persistence.
      const locks = vi.spyOn(value.operations, "withReviewLock");
      const cancelled = value.coordinator.cancel({
        profileId,
        reviewId: value.review.id,
        type: "brief",
        runId: started.runId,
      });
      if (holdTerminalLock) {
        await vi.waitFor(() => expect(locks).toHaveBeenCalledTimes(1));
        releaseReach();
        await vi.waitFor(() => expect(locks).toHaveBeenCalledTimes(2));
        releaseLock();
      }
      await expect(cancelled).resolves.toMatchObject({
        _tag: "ok",
        value: { status: "cancelling" },
      });
      if (!holdTerminalLock) {
        expect(
          must(await value.insights.load(profileId, value.review.id, "brief"))
            .activeRun?.status,
        ).toBe("cancelling");
        releaseReach();
      }
      await held;
      expect(
        await settled(
          value.coordinator,
          value.review.id,
          started.runId,
          "brief",
        ),
      ).toMatchObject({ status: "cancelled", failureReason: "cancelled" });
      const saved = must(
        await value.insights.load(profileId, value.review.id, "brief"),
      );
      expect(saved.retained).toEqual(retained);
      expect(request.signal?.aborted).toBe(true);
      locks.mockRestore();
    },
  );
});
