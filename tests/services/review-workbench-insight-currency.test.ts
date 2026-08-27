import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ok } from "../../src/domain/result";
import {
  at,
  fixture,
  headSha,
  profileId,
  review,
  reviewId,
  sessionId,
  snapshot,
} from "./review-workbench-projection-fixture";

/**
 * The `current` / `outdated` badge on a stored Insight is `sameInsightRevision`
 * and nothing else: `projectStoredInsight` reaches it once `patchHash` is
 * known, and the answer decides whether the workbench presents a stored
 * analysis as describing the diff on screen. A predicate that answered `true`
 * too often would label an Insight generated against an older Session, an
 * older head, or a different patch as `current`, and the reader would take
 * findings about code they are not looking at as findings about code they are.
 *
 * Every fixture in `review-workbench-projection.test.ts` leaves
 * `session.patchPath` unreadable, so `patchHash` is `undefined` there and the
 * guard in front of the call short-circuits before it. These tests write a
 * real patch file so the comparison actually runs, which is why they live in
 * their own file rather than beside the rest of the projection suite.
 */
describe("ReviewWorkbenchProjectionService retained revision currency", () => {
  const analysisRunId = "insight-analysis-1-aaaaaaaaaaaa-x";
  const patch =
    "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const patchHash = createHash("sha256").update(patch).digest("hex");
  const retainedValue = {
    changeSummary: "Adds one guarded change.",
    verdict: "approve",
    summary: "Looks fine.",
    findings: [],
    validationPlan: [],
    assumptions: [],
  };
  let patchPath = "";
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-projection-patch-"));
    patchPath = join(root, "session.patch");
    await writeFile(patchPath, patch, "utf8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function analysisStatus(revision: {
    readonly sessionId: string;
    readonly headSha: string;
    readonly patchHash: string;
  }) {
    const fx = fixture(review(), undefined, patchPath);
    fx.insights.loadTyped.mockImplementationOnce(
      // SAFETY: cast `as never` because the mock's inferred signature (from
      // the fixture's default zero-argument implementation) doesn't describe
      // the real 4-argument `InsightStore.loadTyped`; the record below is
      // exactly what that method yields once the envelope has parsed.
      (async () =>
        ok({
          schemaVersion: 2,
          reviewId,
          type: "analysis",
          nextToken: 1,
          retained: {
            runId: analysisRunId,
            revision,
            generatedAt: at,
            provenance: {
              provider: "pi",
              model: "test-model",
              reasoning: "medium",
            },
            value: retainedValue,
          },
          updatedAt: at,
        })) as never,
    );
    const result = await fx.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    if (result._tag !== "ok") throw new Error("expected an ok projection");
    return result.value.insights.analysis.status;
  }

  it("marks a retained analysis current only when all three revision fields match", async () => {
    await expect(
      analysisStatus({ sessionId, headSha, patchHash }),
    ).resolves.toBe("current");
    await expect(
      analysisStatus({ sessionId: `${sessionId}-older`, headSha, patchHash }),
    ).resolves.toBe("outdated");
    await expect(
      analysisStatus({ sessionId, headSha: "d".repeat(40), patchHash }),
    ).resolves.toBe("outdated");
    await expect(
      analysisStatus({ sessionId, headSha, patchHash: "e".repeat(64) }),
    ).resolves.toBe("outdated");
  });
});
