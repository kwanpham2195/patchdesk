import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseFindingId } from "../../src/domain/ids";
import { dismissInsightFinding } from "../../src/domain/insight-record";
import {
  cleanupLocalApplyRoots,
  localApplyHarness,
  now,
  profileId,
  retainAnalysis,
  suggestionFinding,
  value,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

const probe = [
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (let index = 0; index <= values.length; index += 1) {",
  "    total += values[index] ?? 0;",
  "  }",
  "  return total;",
  "}",
  "",
].join("\n");
const boundFix = suggestionFinding(
  "finding-bound",
  "probe.ts",
  { start: 3, end: 3 },
  "  for (let index = 0; index < values.length; index += 1) {",
);
const findingId = value(parseFindingId("finding-bound"));

async function draftedReview() {
  const harness = await localApplyHarness();
  await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
  const workbench = await harness.open();
  const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);
  const request = {
    profileId,
    reviewId: workbench.review.id,
    runId,
    findingId,
  };
  return { harness, workbench, runId, request };
}

describe("LocalDraftService", () => {
  it("stores one draft per Finding with its anchor fingerprint, comment, suggestion, and provenance", async () => {
    const { harness, workbench, runId, request } = await draftedReview();

    const first = await harness.drafts.add(request);
    const second = await harness.drafts.add(request);

    expect(first).toEqual(second);
    expect(second).toMatchObject({
      _tag: "ok",
      value: {
        localDrafts: [
          {
            findingId: "finding-bound",
            path: "probe.ts",
            startLine: 3,
            line: 3,
            suggests: true,
          },
        ],
      },
    });
    const stored = value(
      await harness.reviews.load(profileId, request.reviewId),
    );
    expect(stored.localDrafts).toEqual([
      {
        findingId: "finding-bound",
        analysisRunId: runId,
        sessionId: workbench.session.id,
        anchor: {
          path: "probe.ts",
          side: "new",
          startLine: 3,
          line: 3,
          selectedLines: [
            "  for (let index = 0; index <= values.length; index += 1) {",
          ],
          before: [
            "export function sum(values: number[]): number {",
            "  let total = 0;",
          ],
          after: ["    total += values[index] ?? 0;", "  }"],
        },
        title: boundFix.title,
        comment: boundFix.explanation,
        suggestion: boundFix.suggestedReplacement,
        addedAt: now,
      },
    ]);
  });

  it("lists drafts after the Review is opened again, and Remove deletes one", async () => {
    const { harness, request } = await draftedReview();
    value(await harness.drafts.add(request));

    const reopened = await harness.open();
    const removed = await harness.drafts.remove(request);

    expect(reopened.localDrafts?.map((entry) => entry.findingId)).toEqual([
      "finding-bound",
    ]);
    expect(removed).toEqual({ _tag: "ok", value: { localDrafts: [] } });
    const stored = value(
      await harness.reviews.load(profileId, request.reviewId),
    );
    expect(stored).not.toHaveProperty("localDrafts");
  });

  it("keeps a draft from an earlier session listed and refuses drafting from the outdated Analysis", async () => {
    const { harness, workbench, request } = await draftedReview();
    value(await harness.drafts.add(request));
    await writeFile(
      join(harness.repositoryPath, "probe.ts"),
      `${probe}export const more = 1;\n`,
    );

    const next = await harness.open();
    const refused = await harness.drafts.add(request);

    expect(next.session.id).not.toBe(workbench.session.id);
    expect(next.localDrafts).toMatchObject([
      { findingId: "finding-bound", sessionId: workbench.session.id },
    ]);
    expect(refused).toEqual({
      _tag: "err",
      error: { reason: "not_applicable" },
    });
  });

  it("refuses a draft change while another operation holds the Review and stores nothing", async () => {
    const { harness, request } = await draftedReview();
    const key = `${profileId}:${request.reviewId}`;
    expect(harness.coordinator.acquire(key)).toBe(true);

    const refused = await harness.drafts.add(request);
    harness.coordinator.release(key);

    expect(refused).toEqual({ _tag: "err", error: { reason: "in_progress" } });
    const stored = value(
      await harness.reviews.load(profileId, request.reviewId),
    );
    expect(stored.localDrafts).toBeUndefined();
  });

  it("refuses a dismissed Finding", async () => {
    const { harness, request } = await draftedReview();
    value(
      await harness.insights.mutate({
        profileId,
        reviewId: request.reviewId,
        type: "analysis",
        now,
        operation: (record) =>
          dismissInsightFinding(record, findingId, "Accepted risk", now),
      }),
    );

    expect(await harness.drafts.add(request)).toEqual({
      _tag: "err",
      error: { reason: "not_applicable" },
    });
  });
});
