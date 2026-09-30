import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  parseAgentRunRequestId,
  parseFindingId,
  parseRepoRelativePath,
  parseReviewId,
} from "../../src/domain/ids";
import { ok } from "../../src/domain/result";
import { isLocalReview, setAgentRunRequests } from "../../src/domain/review";
import { markLocalDraftsApplied } from "../../src/domain/review-local-drafts";
import { ReviewInsightReader } from "../../src/services/review-insight-reading";
import { readReviewStatus } from "../../src/services/review-status-reading";
import type { ReviewWorkbenchProjection } from "../../src/services/review-workbench-projection";
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

const path = value(parseRepoRelativePath("probe.ts"));

/** `probe.ts` with ten lines, the last one set to `last`; the lines before it stay the same. */
function probeContent(last: number): string {
  return Array.from({ length: 10 }, (_, index) =>
    index === 9
      ? `const v10 = ${String(last)};\n`
      : `const v${String(index + 1)} = 0;\n`,
  ).join("");
}

describe("readReviewStatus", () => {
  it("reads the prepared session, each Insight's status, the draft counts, and the applied Findings, and drops the prepared session once the Review moves to it", async () => {
    const harness = await localApplyHarness();
    const probe = join(harness.repositoryPath, "probe.ts");
    await writeFile(probe, probeContent(0));
    const first = await harness.open();
    const reviewId = value(parseReviewId(first.review.id));
    const note = (sessionId: typeof first.session.id, line: number) =>
      harness.drafts.addNote({
        view: "combined",
        profileId,
        reviewId,
        sessionId,
        anchor: { path, side: "new", startLine: line, line },
        text: `Look at line ${String(line)}.`,
      });
    value(await note(first.session.id, 2));
    await writeFile(probe, probeContent(1));
    // The maintainer's Refresh carries the line 2 note as unchanged.
    const second = value(await harness.opening.refresh(profileId, reviewId));
    value(await note(second.session.id, 5));
    const fix = suggestionFinding(
      "finding-bound",
      "probe.ts",
      { start: 3, end: 3 },
      "const v3 = 1;",
    );
    const runId = await retainAnalysis(harness.insights, second, [fix]);
    value(
      await harness.drafts.add({
        profileId,
        reviewId,
        sessionId: second.session.id,
        runId,
        findingId: fix.id,
      }),
    );
    const drafted = value(await harness.reviews.load(profileId, reviewId));
    if (!isLocalReview(drafted)) throw new Error("expected a local Review");
    const requestId = value(parseAgentRunRequestId("request-brief"));
    const applied = markLocalDraftsApplied(drafted, {
      runId,
      findingIds: [fix.id],
      appliedAt: now,
    });
    value(
      await harness.reviews.save(
        value(
          setAgentRunRequests(
            applied,
            [
              {
                requestId,
                sessionId: second.session.id,
                type: "brief",
                requestedAt: now,
                status: "awaiting_approval",
              },
            ],
            now,
          ),
        ),
        drafted.updatedAt,
      ),
    );
    let shown: ReviewWorkbenchProjection = await harness.open();
    const reader = new ReviewInsightReader(
      { load: async () => ok(shown) },
      new ReviewSessionStore(harness.paths),
      harness.reviews,
    );
    await writeFile(probe, probeContent(2));
    const prepared = value(
      await harness.opening.prepareForAgent(profileId, reviewId),
    );

    const waiting = value(
      await readReviewStatus(reader, { profileId, reviewId }),
    );
    shown = value(await harness.opening.refresh(profileId, reviewId));
    const moved = value(
      await readReviewStatus(reader, { profileId, reviewId }),
    );

    expect(shown.session.id).toBe(prepared.preparedSessionId);
    expect(waiting).toMatchObject({
      reviewId,
      sessionId: second.session.id,
      headSha: second.session.key.headSha,
      patchHash: second.revision.patchHash,
      preparedSessionId: prepared.preparedSessionId,
      insights: {
        analysis: { status: "completed" },
        walkthrough: { status: "none" },
        brief: { status: "awaiting_approval", requestId },
      },
      localDraftCounts: {
        finding: {
          current: 0,
          unchanged: 0,
          changed: 0,
          needs_attention: 0,
          applied: 1,
        },
        note: {
          current: 1,
          unchanged: 1,
          changed: 0,
          needs_attention: 0,
          applied: 0,
        },
      },
      appliedFindings: [
        {
          findingId: value(parseFindingId("finding-bound")),
          title: "Fix finding-bound",
          path,
          startLine: 3,
          line: 3,
          appliedAt: now,
        },
      ],
    });
    expect(waiting.insights.analysis).not.toHaveProperty("requestId");
    expect(moved.sessionId).toBe(prepared.preparedSessionId);
    expect(moved).not.toHaveProperty("preparedSessionId");
    // The move drops the brief request, which was for the earlier session.
    expect(moved.insights.brief).toEqual({ status: "none" });
  });

  it("describes the Review after a Refresh its projection waited behind, with the drafts that Refresh carried", async () => {
    const harness = await localApplyHarness();
    const probe = join(harness.repositoryPath, "probe.ts");
    await writeFile(probe, probeContent(0));
    const first = await harness.open();
    const reviewId = value(parseReviewId(first.review.id));
    value(
      await harness.drafts.addNote({
        view: "combined",
        profileId,
        reviewId,
        sessionId: first.session.id,
        anchor: { path, side: "new", startLine: 2, line: 2 },
        text: "Name v2 after what it counts.",
      }),
    );
    await writeFile(probe, probeContent(1));
    const prepared = value(
      await harness.opening.prepareForAgent(profileId, reviewId),
    );
    // The maintainer's Refresh lands while the workbench load waits for the Review lock.
    const reader = new ReviewInsightReader(
      {
        load: async () =>
          ok(value(await harness.opening.refresh(profileId, reviewId))),
      },
      new ReviewSessionStore(harness.paths),
      harness.reviews,
    );

    const status = value(
      await readReviewStatus(reader, { profileId, reviewId }),
    );

    expect(status.sessionId).toBe(prepared.preparedSessionId);
    expect(status).not.toHaveProperty("preparedSessionId");
    expect(status.localDraftCounts.note).toMatchObject({
      current: 0,
      unchanged: 1,
    });
  });
});
