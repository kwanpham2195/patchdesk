import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseFindingId,
  parseInsightRunId,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { beginInsightRun } from "../../src/domain/insight-record";
import { err, ok } from "../../src/domain/result";
import {
  analysisResult,
  cleanupRoots,
  fixture,
  must,
  now,
  profileId,
  seedRetainedAnalysis,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

const findingId = must(parseFindingId("finding-1"));
const finding = {
  id: findingId,
  severity: "P2",
  title: "Guard the added branch",
  file: must(parseRepoRelativePath("a.ts")),
  lineStart: 1,
  lineEnd: 1,
  diffSide: "new",
  explanation: "The added line accepts an invalid value.",
  confidence: "high",
  mappingStatus: "mapped",
} as const;

/** A retained Analysis with its one Finding dismissed. */
async function dismissedFinding() {
  const value = await fixture({
    async invoke() {
      return ok(analysisResult);
    },
  });
  const runId = await seedRetainedAnalysis(value, [finding]);
  const ref = { profileId, reviewId: value.review.id, runId, findingId };
  const dismissed = await value.coordinator.dismissFinding({
    ...ref,
    reason: "Covered by the API contract",
  });
  if (dismissed._tag === "err") throw new Error("could not dismiss");
  const storedDismissals = async () => {
    const record = await value.insights.load(
      profileId,
      value.review.id,
      "analysis",
    );
    if (record._tag === "err") throw new Error("could not load Analysis");
    return record.value.dismissals ?? [];
  };
  return { value, ref, storedDismissals };
}

describe("InsightRunCoordinator.restoreFinding", () => {
  it("removes the dismissal and its reason", async () => {
    const { value, ref, storedDismissals } = await dismissedFinding();

    expect(await value.coordinator.restoreFinding(ref)).toEqual(
      ok({ findingId, status: "open" }),
    );
    expect(await storedDismissals()).toEqual([]);
  });

  it("refuses a restore after the represented patch moved", async () => {
    const { value, ref, storedDismissals } = await dismissedFinding();
    await writeFile(
      value.session.patchPath,
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+other\n",
      "utf8",
    );

    expect(await value.coordinator.restoreFinding(ref)).toEqual(
      err("stale_request"),
    );
    expect(await storedDismissals()).toMatchObject([{ findingId }]);
  });

  it("refuses a restore while an Analysis run is active", async () => {
    const { value, ref, storedDismissals } = await dismissedFinding();
    const started = await value.insights.mutate({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      now,
      operation: (record) => {
        const revision = record.retained?.revision;
        if (revision === undefined) throw new Error("expected an Analysis");
        return beginInsightRun(record, {
          id: must(
            parseInsightRunId(
              `insight-analysis-2-aaaaaaaaaaaa-${value.review.id}`,
            ),
          ),
          revision,
          provider: "pi",
          model: "model",
          reasoning: "medium",
          language: "en",
          startedAt: now,
        });
      },
    });
    if (started._tag === "err") throw new Error("could not start a run");

    expect(await value.coordinator.restoreFinding(ref)).toEqual(
      err("not_available"),
    );
    expect(await storedDismissals()).toMatchObject([{ findingId }]);
  });
});
