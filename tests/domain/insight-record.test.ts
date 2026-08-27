import { describe, expect, it } from "vitest";

import {
  beginInsightRun,
  completeInsightRun,
  createInsightRecord,
  dismissInsightFinding,
  failInsightRun,
  parseRetainedInsight,
  requestInsightCancellation,
  sameInsightRevision,
  updateWalkthroughProgress,
  type InsightRecord,
} from "../../src/domain/insight-record";
import {
  createReviewId,
  parseContentHash,
  parseFindingId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const reviewId = createReviewId({
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
});
const sessionId = must(
  parseReviewSessionId(
    "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-12345678__abcdef123456",
  ),
);
const headSha = must(parseGitSha("a".repeat(40)));
const patchHash = must(parseContentHash("b".repeat(64)));
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const later = must(parseIsoTimestamp("2026-08-01T00:01:00.000Z"));
const provenance = {
  provider: "pi" as const,
  model: "fixture-model",
  reasoning: "medium" as const,
};

function record(): InsightRecord<unknown> {
  return createInsightRecord({ reviewId, type: "analysis", updatedAt: now });
}
function runInput(recordValue: InsightRecord<unknown>) {
  return {
    id: must(
      parseInsightRunId(
        `insight-analysis-${recordValue.nextToken}-${headSha.slice(0, 12)}-${reviewId}`,
      ),
    ),
    revision: { sessionId, headSha, patchHash },
    provider: "pi" as const,
    model: "fixture-model",
    reasoning: "medium" as const,
    startedAt: now,
  };
}

describe("InsightRecord", () => {
  it("begins one run and rejects a concurrent run", () => {
    const started = beginInsightRun(record(), runInput(record()));
    expect(started._tag).toBe("ok");
    if (started._tag === "err") return;
    expect(started.value.activeRun?.status).toBe("queued");
    expect(beginInsightRun(started.value, runInput(started.value))).toEqual({
      _tag: "err",
      error: "already_running",
    });
  });

  it("preserves retained output while replacing, failing, or cancelling a run", () => {
    const retained = {
      // SAFETY: This test-only run ID is an opaque fixture value for retained-output behavior.
      runId: "old" as never,
      revision: { sessionId, headSha, patchHash },
      generatedAt: now,
      provenance,
      value: { summary: "old" },
    };
    const withRetained = { ...record(), retained };
    const started = beginInsightRun(withRetained, runInput(withRetained));
    if (started._tag === "err") throw new Error("expected run");
    const activeRun = started.value.activeRun;
    if (activeRun === undefined) throw new Error("expected active run");
    const runId = activeRun.id;
    const failed = failInsightRun(
      started.value,
      runId,
      { runId, reason: "failed", retryable: true, failedAt: later },
      later,
    );
    expect(failed._tag).toBe("ok");
    if (failed._tag === "ok") {
      expect(failed.value.retained).toEqual(retained);
      expect(failed.value.replacementFailure).toMatchObject({
        model: "fixture-model",
        reasoning: "medium",
      });
    }
    const startedAgain = beginInsightRun(withRetained, runInput(withRetained));
    if (startedAgain._tag === "err") throw new Error("expected run");
    const activeRunAgain = startedAgain.value.activeRun;
    if (activeRunAgain === undefined) throw new Error("expected active run");
    const cancelled = requestInsightCancellation(
      startedAgain.value,
      activeRunAgain.id,
      later,
    );
    expect(cancelled._tag).toBe("ok");
    if (cancelled._tag === "ok")
      expect(cancelled.value.activeRun?.status).toBe("cancelling");
  });

  it("trims valid dismissal reasons and rejects blank or oversized reasons", () => {
    const findingId = must(parseFindingId("finding-1"));
    const runId = must(
      parseInsightRunId(
        `insight-analysis-1-${headSha.slice(0, 12)}-${reviewId}`,
      ),
    );
    const withRetained: InsightRecord<unknown> = {
      ...record(),
      retained: {
        runId,
        revision: { sessionId, headSha, patchHash },
        generatedAt: now,
        provenance,
        value: {},
      },
    };
    const dismissed = dismissInsightFinding(
      withRetained,
      findingId,
      "  Not applicable.  ",
      later,
    );
    expect(dismissed).toMatchObject({
      _tag: "ok",
      value: { dismissals: [{ findingId, reason: "Not applicable." }] },
    });
    expect(
      dismissInsightFinding(withRetained, findingId, "   ", later),
    ).toEqual({ _tag: "err", error: "invalid_reason" });
    expect(
      dismissInsightFinding(withRetained, findingId, "x".repeat(501), later),
    ).toEqual({ _tag: "err", error: "invalid_reason" });
  });

  it("starts a replacement with a fresh dismissal set on successful completion", () => {
    const findingId = must(parseFindingId("finding-1"));
    const runId = must(
      parseInsightRunId(
        `insight-analysis-1-${headSha.slice(0, 12)}-${reviewId}`,
      ),
    );
    const withRetained: InsightRecord<unknown> = {
      ...record(),
      retained: {
        runId,
        revision: { sessionId, headSha, patchHash },
        generatedAt: now,
        provenance,
        value: {},
      },
    };
    const dismissed = dismissInsightFinding(
      withRetained,
      findingId,
      "Not applicable.",
      now,
    );
    if (dismissed._tag === "err") throw new Error("expected dismissal");
    const started = beginInsightRun(dismissed.value, runInput(dismissed.value));
    if (started._tag === "err" || started.value.activeRun === undefined)
      throw new Error("expected run");
    const completed = completeInsightRun(
      started.value,
      started.value.activeRun.id,
      {
        runId: started.value.activeRun.id,
        revision: { sessionId, headSha, patchHash },
        generatedAt: later,
        provenance,
        value: {},
      },
      later,
    );
    expect(completed).toMatchObject({
      _tag: "ok",
      value: { retained: { value: {} } },
    });
    if (completed._tag === "ok")
      expect(completed.value.dismissals).toBeUndefined();
  });

  it("persists walkthrough progress and clears it for a replacement run", () => {
    const walkthrough = createInsightRecord({
      reviewId,
      type: "walkthrough",
      updatedAt: now,
    });
    const runId = must(
      parseInsightRunId(
        `insight-walkthrough-1-${headSha.slice(0, 12)}-${reviewId}`,
      ),
    );
    const started = beginInsightRun(walkthrough, {
      id: runId,
      revision: { sessionId, headSha, patchHash },
      provider: "pi",
      model: "fixture-model",
      reasoning: "medium",
      startedAt: now,
    });
    if (started._tag === "err") throw new Error("expected run");
    const retained = completeInsightRun(
      started.value,
      runId,
      {
        runId,
        revision: { sessionId, headSha, patchHash },
        generatedAt: now,
        provenance,
        value: {},
      },
      now,
    );
    if (retained._tag === "err")
      throw new Error("expected retained walkthrough");
    const progress = updateWalkthroughProgress(
      retained.value,
      {
        reviewedSectionIds: ["section-a", "section-a"],
        supportReviewed: true,
        currentSectionId: "section-a",
      },
      later,
    );
    expect(progress).toMatchObject({
      _tag: "ok",
      value: {
        walkthroughProgress: {
          reviewedSectionIds: ["section-a"],
          supportReviewed: true,
        },
      },
    });
    if (progress._tag === "err") return;
    const activeRun = started.value.activeRun;
    if (activeRun === undefined) throw new Error("expected active run");
    const replacementId = must(
      parseInsightRunId(
        `insight-walkthrough-2-${headSha.slice(0, 12)}-${reviewId}`,
      ),
    );
    const next = beginInsightRun(progress.value, {
      ...activeRun,
      id: replacementId,
      startedAt: later,
    });
    if (next._tag === "err" || next.value.activeRun === undefined)
      throw new Error("expected replacement run");
    expect(next.value.walkthroughProgress).toMatchObject({
      reviewedSectionIds: ["section-a"],
      supportReviewed: true,
    });
    const failed = failInsightRun(
      next.value,
      replacementId,
      {
        runId: replacementId,
        reason: "failed",
        retryable: true,
        failedAt: later,
      },
      later,
    );
    if (failed._tag === "err") throw new Error("expected failed replacement");
    expect(failed.value.walkthroughProgress).toMatchObject({
      reviewedSectionIds: ["section-a"],
      supportReviewed: true,
    });
    const retry = beginInsightRun(failed.value, {
      ...activeRun,
      id: must(
        parseInsightRunId(
          `insight-walkthrough-3-${headSha.slice(0, 12)}-${reviewId}`,
        ),
      ),
      startedAt: later,
    });
    if (retry._tag === "err" || retry.value.activeRun === undefined)
      throw new Error("expected retry run");
    const cancelled = requestInsightCancellation(
      retry.value,
      retry.value.activeRun.id,
      later,
    );
    if (cancelled._tag === "err") throw new Error("expected cancellation");
    expect(cancelled.value.walkthroughProgress).toMatchObject({
      reviewedSectionIds: ["section-a"],
      supportReviewed: true,
    });
    const completed = completeInsightRun(
      retry.value,
      retry.value.activeRun.id,
      {
        runId: retry.value.activeRun.id,
        revision: { sessionId, headSha, patchHash },
        generatedAt: later,
        provenance,
        value: {},
      },
      later,
    );
    if (completed._tag === "err")
      throw new Error("expected successful replacement");
    expect(completed.value.walkthroughProgress).toBeUndefined();
  });

  it("accepts only the active token and replaces retained output on completion", () => {
    const started = beginInsightRun(record(), runInput(record()));
    if (started._tag === "err") throw new Error("expected run");
    const activeRun = started.value.activeRun;
    if (activeRun === undefined) throw new Error("expected active run");
    const runId = activeRun.id;
    const otherRunId = must(
      parseInsightRunId(
        `insight-analysis-2-${headSha.slice(0, 12)}-${reviewId}`,
      ),
    );
    expect(
      completeInsightRun(
        started.value,
        otherRunId,
        {
          runId,
          revision: { sessionId, headSha, patchHash },
          generatedAt: later,
          provenance,
          value: { summary: "new" },
        },
        later,
      ),
    ).toEqual({ _tag: "err", error: "superseded" });
    const completed = completeInsightRun(
      started.value,
      runId,
      {
        runId,
        revision: { sessionId, headSha, patchHash },
        generatedAt: later,
        provenance,
        value: { summary: "new" },
      },
      later,
    );
    expect(completed._tag).toBe("ok");
    if (completed._tag === "ok")
      expect(completed.value.retained?.value).toEqual({ summary: "new" });
  });
});

describe("sameInsightRevision", () => {
  const revision = { sessionId, headSha, patchHash };

  it("is true only when the session, head, and patch hash all match", () => {
    expect(sameInsightRevision(revision, { ...revision })).toBe(true);
    expect(
      sameInsightRevision(revision, {
        ...revision,
        headSha: must(parseGitSha("c".repeat(40))),
      }),
    ).toBe(false);
    expect(
      sameInsightRevision(revision, {
        ...revision,
        patchHash: must(parseContentHash("d".repeat(64))),
      }),
    ).toBe(false);
  });
});

describe("parseRetainedInsight", () => {
  const runId = must(
    parseInsightRunId(`insight-analysis-1-${headSha.slice(0, 12)}-${reviewId}`),
  );
  const stored = {
    runId,
    revision: { sessionId, headSha, patchHash },
    generatedAt: now,
    provenance,
    value: { summary: "stored" },
  };

  it("parses the envelope and delegates only the value", () => {
    const seen: Array<unknown> = [];
    const parsed = parseRetainedInsight(stored, (input) => {
      seen.push(input);
      return ok("parsed");
    });
    expect(seen).toEqual([{ summary: "stored" }]);
    expect(parsed).toEqual({
      _tag: "ok",
      value: {
        runId,
        revision: { sessionId, headSha, patchHash },
        generatedAt: now,
        provenance,
        value: "parsed",
      },
    });
  });

  it("rejects a value its caller's parser rejects", () => {
    expect(parseRetainedInsight(stored, () => err("no"))._tag).toBe("err");
  });

  it("rejects a missing field, a blank provenance model, and an extra key", () => {
    const { runId: _runId, ...withoutRunId } = stored;
    void _runId;
    expect(parseRetainedInsight(withoutRunId, ok)._tag).toBe("err");
    expect(
      parseRetainedInsight(
        { ...stored, provenance: { ...provenance, model: "   " } },
        ok,
      )._tag,
    ).toBe("err");
    expect(parseRetainedInsight({ ...stored, extra: 1 }, ok)._tag).toBe("err");
    expect(parseRetainedInsight(undefined, ok)._tag).toBe("err");
  });
});
