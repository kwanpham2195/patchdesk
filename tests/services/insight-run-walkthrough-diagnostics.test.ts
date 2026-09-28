import { afterEach, describe, expect, it, vi } from "vitest";

import { ok } from "../../src/domain/result";
import {
  cleanupRoots,
  fixture,
  profileId,
  settled,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

describe("Walkthrough invalid-result diagnostics", () => {
  it("rejects prose beyond the producer limit on the Codex result path", async () => {
    const value = await fixture({
      async invoke() {
        return ok({
          citationVersion: 2,
          title: "Recovery",
          focus: "Read the recovery change.",
          chapters: [
            {
              title: "Recovery",
              sections: [
                {
                  title: "Decision",
                  prose: `a.ts ${"detail ".repeat(46)}`,
                  hunkIds: ["h1"],
                },
              ],
            },
          ],
        });
      },
    });
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "walkthrough",
      model: "model",
      reasoning: "medium",
      language: "en",
    });
    if (started._tag === "err") throw new Error("Expected Walkthrough run");
    expect(
      await settled(
        value.coordinator,
        value.review.id,
        started.value.runId,
        "walkthrough",
      ),
    ).toMatchObject({ status: "failed", failureReason: "invalid_result" });
  });

  it("records only violated output limits when a generated section exceeds them", async () => {
    const value = await fixture(
      {
        async invoke() {
          return ok({
            citationVersion: 2,
            title: "Recovery",
            focus: "Read the recovery change.",
            chapters: [
              {
                title: "Recovery",
                sections: [
                  {
                    title: "Decision",
                    prose: "private prose ".repeat(27),
                    hunkIds: Array.from({ length: 127 }, () => "h1"),
                  },
                ],
              },
            ],
          });
        },
      },
      { recordDiagnostics: true },
    );
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "walkthrough",
      model: "model",
      reasoning: "medium",
      language: "en",
    });
    if (started._tag === "err") throw new Error("Expected Walkthrough run");
    expect(
      await settled(
        value.coordinator,
        value.review.id,
        started.value.runId,
        "walkthrough",
      ),
    ).toMatchObject({ status: "failed", failureReason: "invalid_result" });
    await vi.waitFor(async () => {
      const events = await value.diagnostics?.recent(profileId);
      if (events?._tag !== "ok") throw new Error("Expected diagnostics");
      const details = events.value.map((event) => event.detail);
      expect(details).toContain("insight_walkthrough_invalid_result_malformed");
      expect(details).toContain(
        "insight_walkthrough_chapters[0].sections[0].prose_378_gt_320,chapters[0].sections[0].hunkIds_127_gt_32",
      );
      expect(JSON.stringify(details)).not.toContain("private prose");
    });
  });
});
