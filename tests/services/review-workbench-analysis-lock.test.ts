import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PendingReviewState } from "../../src/domain/pending-review";
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
 * Whether an analysis finding offers its review actions is one predicate:
 * `isPendingReviewLocked` over the session's pending-review state. A locked
 * session holds durable recovery evidence — a write whose remote outcome is
 * not yet known — and offering "comment on this finding" against it invites a
 * second write on top of the unresolved one.
 *
 * Nothing else in the suite reaches that line. `projectAnalysisReviewActions`
 * returns empty before it unless the retained analysis is current, artifact-
 * verified, fresh, and hashed against a readable patch, which needs a real
 * patch file on disk — the same reason `review-workbench-insight-currency`
 * lives apart from the rest of the projection suite.
 */
describe("ReviewWorkbenchProjectionService analysis finding lock", () => {
  const analysisRunId = "insight-analysis-1-aaaaaaaaaaaa-x";
  const findingId = "f1";
  const patch =
    "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const patchHash = createHash("sha256").update(patch).digest("hex");
  const retainedValue = {
    changeSummary: "Adds one guarded change.",
    verdict: "comment",
    summary: "One thing to look at.",
    findings: [
      {
        id: findingId,
        severity: "P2",
        title: "Unguarded read",
        explanation: "The read is not guarded.",
        confidence: "high",
        mappingStatus: "mapped",
      },
    ],
    validationPlan: [],
    assumptions: [],
  };
  let patchPath = "";
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-analysis-lock-"));
    patchPath = join(root, "session.patch");
    await writeFile(patchPath, patch, "utf8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function findingState(pendingReview: PendingReviewState) {
    const fx = fixture(review(), undefined, patchPath);
    // SAFETY: `session()` hands its fixture back cast to `never`; widening it
    // to a spreadable object here is that cast in reverse, done only so this
    // suite can vary the one field it is about.
    const stored = {
      ...(session(undefined, patchPath) as object),
      pendingReview,
    } as never;
    fx.sessions.load.mockImplementation(async () => ok(stored));
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
            revision: { sessionId, headSha, patchHash },
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
    return result.value.analysisReviewActions.findings[findingId]?.state;
  }

  const pending: PendingReviewState = {
    _tag: "Pending",
    // SAFETY: the fixture's own pending review, whose branded fields are
    // plain strings that already satisfy their runtime shapes.
    review: {
      nodeId: "node" as never,
      restId: "1" as never,
      headSha,
      comments: [],
      author: "fixture" as never,
      pr: {
        host: "github.com" as never,
        owner: "centraldigital" as never,
        repo: "patchdesk" as never,
        number: 42 as never,
      },
      createdAt: at,
      updatedAt: at,
    },
  };

  it("offers a finding's review actions while no write is in flight", async () => {
    await expect(findingState(pending)).resolves.toBe("actionable");
    await expect(findingState({ _tag: "None" })).resolves.toBe("actionable");
  });

  it("locks a finding's review actions while the session holds unresolved write evidence", async () => {
    // The two lock tags of `PendingReviewState`, against the same analysis,
    // the same patch and the same session as the actionable cases above. A
    // predicate that answers the wrong way for these hands the reader a
    // second write to start on top of one whose outcome is unknown.
    await expect(
      findingState({
        _tag: "WriteInFlight",
        // SAFETY: a plain request-id string already satisfies the branded
        // `PendingReviewRequestId`'s runtime shape.
        operation: { _tag: "Start", requestId: "req-1" as never },
        startedAt: at,
      }),
    ).resolves.toBe("locked");
    await expect(
      findingState({
        _tag: "OutcomeUnknown",
        operation: { _tag: "Start", requestId: "req-1" as never },
        startedAt: at,
      }),
    ).resolves.toBe("locked");
  });
});
