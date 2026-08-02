import { describe, expect, it } from "vitest";

import { beginInsightRun, completeInsightRun, createInsightRecord, failInsightRun, requestInsightCancellation, type InsightRecord } from "../../src/domain/insight-record";
import { createReviewId, parseContentHash, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseInsightRunId, parseIsoTimestamp, parsePullRequestNumber, parseReviewSessionId, parseWorkspaceProfileId } from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const reviewId = createReviewId({ profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)) });
const sessionId = must(parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__abcdef123456"));
const headSha = must(parseGitSha("a".repeat(40)));
const patchHash = must(parseContentHash("b".repeat(64)));
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const later = must(parseIsoTimestamp("2026-08-01T00:01:00.000Z"));

function record(): InsightRecord<unknown> { return createInsightRecord({ reviewId, type: "analysis", updatedAt: now }); }
function runInput(recordValue: InsightRecord<unknown>) { return { id: must(parseInsightRunId(`insight-analysis-${recordValue.nextToken}-${headSha.slice(0, 12)}-${reviewId}`)), revision: { sessionId, headSha, patchHash }, model: "fixture-model", reasoning: "medium" as const, startedAt: now }; }

describe("InsightRecord", () => {
  it("begins one run and rejects a concurrent run", () => {
    const started = beginInsightRun(record(), runInput(record()));
    expect(started._tag).toBe("ok");
    if (started._tag === "err") return;
    expect(started.value.activeRun?.status).toBe("queued");
    expect(beginInsightRun(started.value, runInput(started.value))).toEqual({ _tag: "err", error: "already_running" });
  });

  it("preserves retained output while replacing, failing, or cancelling a run", () => {
    const retained = { runId: "old", revision: { sessionId, headSha, patchHash }, generatedAt: now, value: { summary: "old" } };
    const withRetained = { ...record(), retained };
    const started = beginInsightRun(withRetained, runInput(withRetained));
    if (started._tag === "err") throw new Error("expected run");
    const activeRun = started.value.activeRun;
    if (activeRun === undefined) throw new Error("expected active run");
    const runId = activeRun.id;
    const failed = failInsightRun(started.value, runId, { runId, reason: "failed", retryable: true, failedAt: later }, later);
    expect(failed._tag).toBe("ok");
    if (failed._tag === "ok") expect(failed.value.retained).toEqual(retained);
    const startedAgain = beginInsightRun(withRetained, runInput(withRetained));
    if (startedAgain._tag === "err") throw new Error("expected run");
    const activeRunAgain = startedAgain.value.activeRun;
    if (activeRunAgain === undefined) throw new Error("expected active run");
    const cancelled = requestInsightCancellation(startedAgain.value, activeRunAgain.id, later);
    expect(cancelled._tag).toBe("ok");
    if (cancelled._tag === "ok") expect(cancelled.value.activeRun?.status).toBe("cancelling");
  });

  it("accepts only the active token and replaces retained output on completion", () => {
    const started = beginInsightRun(record(), runInput(record()));
    if (started._tag === "err") throw new Error("expected run");
    const activeRun = started.value.activeRun;
    if (activeRun === undefined) throw new Error("expected active run");
    const runId = activeRun.id;
    const otherRunId = must(parseInsightRunId(`insight-analysis-2-${headSha.slice(0, 12)}-${reviewId}`));
    expect(completeInsightRun(started.value, otherRunId, { runId, revision: { sessionId, headSha, patchHash }, generatedAt: later, value: { summary: "new" } }, later)).toEqual({ _tag: "err", error: "superseded" });
    const completed = completeInsightRun(started.value, runId, { runId, revision: { sessionId, headSha, patchHash }, generatedAt: later, value: { summary: "new" } }, later);
    expect(completed._tag).toBe("ok");
    if (completed._tag === "ok") expect(completed.value.retained?.value).toEqual({ summary: "new" });
  });
});
