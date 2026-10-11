import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { buildGuideInventory, retainGuide } from "#src/domain/guide";
import { markReviewTerminal } from "#src/domain/review";
import {
  parseInsightRunId,
  parseContentHash,
  parseIsoTimestamp,
  parseWorkspaceProfileId,
} from "#src/domain/ids";
import { parseInsightRecord } from "#src/adapters/storage/insight-store";
import { contentHash } from "#src/services/review-artifact-hash";
import {
  fixture,
  cleanupRoots,
  must,
  now,
  profileId,
  headSha,
} from "./insight-run-fixture";

afterEach(cleanupRoots);
async function retainedGuide() {
  const setup = await fixture({
    invoke: async () => {
      throw new Error("Unexpected provider run");
    },
  });
  const patchText = await readFile(setup.session.patchPath, "utf8");
  const guide = must(
    retainGuide(
      {
        groups: [
          {
            title: "Guard",
            explanation: "Preserves recovery.",
            files: [{ fileId: "f1", relevance: "Guard owner." }],
          },
        ],
      },
      { patchText, inventory: must(buildGuideInventory(patchText)) },
    ),
  );
  const runId = must(
    parseInsightRunId(`insight-guide-1-aaaaaaaaaaaa-${setup.review.id}`),
  );
  must(
    await setup.insights.save(
      profileId,
      must(
        parseInsightRecord({
          schemaVersion: 2,
          reviewId: setup.review.id,
          type: "guide",
          nextToken: 2,
          updatedAt: now,
          retained: {
            runId,
            revision: {
              sessionId: setup.session.id,
              headSha,
              patchHash: must(
                parseContentHash(await contentHash(setup.session.patchPath)),
              ),
            },
            generatedAt: now,
            provenance: {
              provider: "pi",
              model: "model",
              reasoning: "medium",
              language: "en",
            },
            value: guide,
          },
        }),
      ),
    ),
  );
  return { ...setup, runId };
}
describe("Guide reading admission", () => {
  it.each(["closed", "merged"] as const)(
    "persists local reading on a %s Review without reopening it",
    async (status) => {
      const setup = await retainedGuide();
      must(
        await setup.reviews.save(
          markReviewTerminal(
            setup.review,
            status,
            must(parseIsoTimestamp("2026-08-01T00:01:00.000Z")),
          ),
          setup.review.updatedAt,
        ),
      );
      const saved = await setup.coordinator.updateGuideReadingState({
        profileId,
        reviewId: setup.review.id,
        runId: setup.runId,
        sessionId: setup.session.id,
        expectedStateVersion: 0,
        state: {
          reviewedGroupIds: ["g1"],
          expandedAppearances: [{ groupId: "g1", fileId: "f1" }],
          anchor: { kind: "file", groupId: "g1", fileId: "f1", offset: 18 },
        },
      });
      expect(saved).toMatchObject({ _tag: "ok", value: { version: 1 } });
      const stored = must(
        await setup.insights.load(profileId, setup.review.id, "guide"),
      );
      expect(stored.guideReadingState?.expandedAppearances).toEqual([
        { groupId: "g1", fileId: "f1" },
      ]);
      expect(
        must(await setup.reviews.load(profileId, setup.review.id)).status,
      ).toMatchObject({ _tag: "Terminal", state: status });
    },
  );
  it("refuses another profile's Review before changing retained progress", async () => {
    const setup = await retainedGuide();
    const refused = await setup.coordinator.updateGuideReadingState({
      profileId: must(parseWorkspaceProfileId("other")),
      reviewId: setup.review.id,
      runId: setup.runId,
      sessionId: setup.session.id,
      expectedStateVersion: 0,
      state: {
        reviewedGroupIds: ["g1"],
        expandedAppearances: [],
        anchor: { kind: "top" },
      },
    });
    expect(refused).toEqual({ _tag: "err", error: "ownership_mismatch" });
    expect(
      must(await setup.insights.load(profileId, setup.review.id, "guide"))
        .guideReadingState,
    ).toBeUndefined();
  });
});
