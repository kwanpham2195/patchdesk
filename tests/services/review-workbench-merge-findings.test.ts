import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AnalysisMergePolicy } from "../../src/domain/workspace-profile";
import { ok } from "../../src/domain/result";
import {
  at,
  fixture,
  headSha,
  profileId,
  review,
  reviewId,
  session,
  sessionId,
  snapshot,
} from "./review-workbench-projection-fixture";

/**
 * The merge badge's Analysis half. `mergeGateFindings` decides which Findings
 * a merge must answer for, and the merge gate in `merge-write-controller.ts`
 * reads the same function, so what the badge shows and what the merge allows
 * cannot drift apart -- above all on a dismissed Finding, which the reader has
 * already been told is gone.
 *
 * Like `review-workbench-insight-currency.test.ts`, these tests write a real
 * patch file: without one the projection's `patchHash` is `undefined`, no
 * stored Analysis can be current, and the rule under test never runs.
 */
describe("ReviewWorkbenchProjectionService merge badge Analysis findings", () => {
  const analysisRunId = "insight-analysis-1-aaaaaaaaaaaa-x";
  const patch =
    "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const patchHash = createHash("sha256").update(patch).digest("hex");
  const findingId = "finding-1";
  let patchPath = "";
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-merge-findings-"));
    patchPath = join(root, "session.patch");
    await writeFile(patchPath, patch, "utf8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function badge(options: {
    readonly severity: "P0" | "P1" | "P2" | "P3";
    readonly dismissed?: boolean;
    readonly addedToReview?: boolean;
    readonly patchHash?: string;
    readonly policy?: AnalysisMergePolicy;
  }) {
    const fx = fixture(review(), undefined, patchPath);
    if (options.addedToReview === true)
      fx.sessions.load.mockImplementation(
        // SAFETY: cast `as never` for the same reason as the profile mock
        // above; the session is the fixture's plus the one receipt this rule
        // reads.
        (async () =>
          ok(
            Object.assign({}, session(undefined, patchPath), {
              findingReviewReceipts: [
                {
                  analysisRunId,
                  findingId,
                  sessionId,
                  headSha,
                  patchHash,
                  threadId: "thread-1",
                  pendingReviewNodeId: "node",
                  state: "pending",
                },
              ],
            }),
          )) as never,
      );
    if (options.policy !== undefined)
      fx.profiles.load.mockImplementation(
        // SAFETY: cast `as never` because the fixture's default
        // implementation fixes the mock's inferred return type; the profile
        // below carries the one extra field this rule reads.
        (async () =>
          ok({
            ghAccount: "fixture",
            analysisMergePolicy: options.policy,
          })) as never,
      );
    const record = {
      schemaVersion: 2,
      reviewId,
      type: "analysis",
      nextToken: 1,
      retained: {
        runId: analysisRunId,
        revision: {
          sessionId,
          headSha,
          patchHash: options.patchHash ?? patchHash,
        },
        generatedAt: at,
        provenance: {
          provider: "pi",
          model: "test-model",
          reasoning: "medium",
        },
        value: {
          changeSummary: "Adds one guarded change.",
          verdict: "comment",
          summary: "One finding.",
          findings: [
            {
              id: findingId,
              severity: options.severity,
              title: "A finding",
              explanation: "why",
              confidence: "high",
              mappingStatus: "mapped",
            },
          ],
          validationPlan: [],
          assumptions: [],
        },
      },
      updatedAt: at,
    };
    const dismissals = [
      { findingId, reason: "not a real problem", dismissedAt: at },
    ];
    fx.insights.loadTyped.mockImplementationOnce(
      // SAFETY: cast `as never` because the mock's inferred signature (from
      // the fixture's default zero-argument implementation) doesn't describe
      // the real 4-argument `InsightStore.loadTyped`; the record below is
      // exactly what that method yields once the envelope has parsed.
      (async () =>
        ok(
          options.dismissed === true ? { ...record, dismissals } : record,
        )) as never,
    );
    const result = await fx.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    return result._tag === "ok" ? result.value.mergeReadiness : result;
  }

  // The ids travel with the warning so the drawer's findings card can lead
  // to the exact Findings it counts.
  it("asks the maintainer to acknowledge an open high-severity Finding, naming it", async () => {
    await expect(badge({ severity: "P0" })).resolves.toEqual({
      _tag: "NeedsAcknowledgement",
      blockers: [],
      warnings: [
        { code: "findings_need_acknowledgement", findingIds: [findingId] },
      ],
    });
  });

  it("blocks when the profile's Analysis merge policy blocks", async () => {
    await expect(
      badge({ severity: "P0", policy: "block" }),
    ).resolves.toMatchObject({
      _tag: "Blocked",
      blockers: ["analysis_finding"],
    });
  });

  // The reader was told this Finding is gone. The badge must say so too, and
  // the merge gate counts it the same way -- see the dismissal test in
  // `merge-write-controller.test.ts`.
  it("reads Ready when the only high-severity Finding was dismissed", async () => {
    await expect(
      badge({ severity: "P0", dismissed: true, policy: "block" }),
    ).resolves.toEqual({ _tag: "Ready", blockers: [], warnings: [] });
  });

  // Adding a Finding to the review handles it the same as dismissing it: the
  // review already carries the thread, so readiness has nothing left to ask.
  it("reads Ready when the only high-severity Finding was added to the review", async () => {
    await expect(
      badge({ severity: "P0", addedToReview: true, policy: "block" }),
    ).resolves.toEqual({ _tag: "Ready", blockers: [], warnings: [] });
  });

  // Controls: neither rule above may fire for a reason it does not own.
  it("reads Ready when the only open Finding is below high severity", async () => {
    await expect(badge({ severity: "P2", policy: "block" })).resolves.toEqual({
      _tag: "Ready",
      blockers: [],
      warnings: [],
    });
  });

  it("reads Ready when the high-severity Finding describes another patch", async () => {
    await expect(
      badge({ severity: "P0", patchHash: "c".repeat(64), policy: "block" }),
    ).resolves.toEqual({ _tag: "Ready", blockers: [], warnings: [] });
  });
});
