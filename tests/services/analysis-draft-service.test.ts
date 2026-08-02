import { describe, expect, it } from "vitest";

import { AnalysisDraftService, createAnalysisFindingItem } from "../../src/services/analysis-draft-service";
import { parseFindingId, parseInsightRunId, parseIsoTimestamp, parseLocalReviewItemId, parseReviewSessionId, type FindingId, type InsightRunId, type IsoTimestamp, type LocalReviewItemId, type ReviewSessionId } from "../../src/domain/ids";
import type { ReviewBatch, ReviewBatchItem } from "../../src/domain/review-batch";
import { parseUnifiedPatch } from "../../src/domain/patch";
import type { ReviewResult } from "../../src/domain/review-result";
import type { Result } from "../../src/domain/result";

const must = <T>(value: Result<T, unknown>): T => {
  if (value._tag === "ok") return value.value;
  throw new Error("fixture parse failed");
};
const sessionId: ReviewSessionId = must(parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__abcdef123456"));
const runId: InsightRunId = must(parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-review-42"));
const now: IsoTimestamp = must(parseIsoTimestamp("2026-08-02T00:00:00.000Z"));
const findingId: FindingId = must(parseFindingId("finding-1"));
const patch = "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,2 @@\n old\n+new\n";
const scope = { baseShort: "base", headShort: "head", commitCount: 2, fileCount: 1, additions: 1, deletions: 0, changedFiles: [{ path: "src/a.ts", additions: 1, deletions: 0 }] };
const result: ReviewResult = {
  changeSummary: "Adds a guard",
  verdict: "request_changes",
  summary: "The guard needs review.",
  findings: [
    { id: findingId, severity: "P1", title: "Missing guard", explanation: "Guard the write.", confidence: "high", mappingStatus: "mapped", file: "src/a.ts" as never, lineStart: 2, diffSide: "new" },
    { id: must(parseFindingId("finding-2")), severity: "P2", title: "General note", explanation: "Review the rollout.", confidence: "medium", mappingStatus: "unmapped" },
  ],
  validationPlan: ["pnpm test"],
  assumptions: [],
  callouts: [],
  unresolvedItems: [],
};

function emptyBatch(): ReviewBatch {
  return { sessionId, state: { _tag: "Local" }, summaryBody: "", suggestedEvent: "COMMENT", items: [], receipts: [], createdAt: now, updatedAt: now };
}

describe("AnalysisDraftService", () => {
  const service = new AnalysisDraftService();
  const input = { sessionId, analysisRunId: runId, result, scope, patch, now };

  it("seeds deterministic body and only mapped findings as included insight items", () => {
    const seeded = service.seed({ ...input, current: emptyBatch() });
    expect(seeded._tag).toBe("ok");
    if (seeded._tag === "err") return;
    expect(seeded.value.summaryBody).toContain("# Review Scope");
    expect(seeded.value.summaryBody).toContain("# Findings");
    expect(seeded.value.summaryBody).toContain("General note");
    expect(seeded.value.suggestedEvent).toBe("REQUEST_CHANGES");
    expect(seeded.value.items).toHaveLength(1);
    expect(seeded.value.items[0]).toMatchObject({ _tag: "InlineComment", findingId, include: true, provenance: { _tag: "insight", runId }, postability: "postable" });
  });

  it("returns no-loss merge and replacement previews for non-empty drafts", () => {
    const manualItem: ReviewBatchItem = { _tag: "GeneralComment", id: "manual-1" as never, provenance: { _tag: "human" }, source: "manual", body: "Keep this", include: true };
    const current: ReviewBatch = { ...emptyBatch(), summaryBody: "Human notes", items: [manualItem] };
    const seeded = service.seed({ ...input, current });
    expect(seeded).toMatchObject({ _tag: "err", error: { reason: "draft_not_empty" } });
    if (seeded._tag === "ok" || seeded.error.reason !== "draft_not_empty") return;
    expect(seeded.error.merge.preservedItems).toHaveLength(1);
    expect(seeded.error.replacement.removedItems).toHaveLength(1);
  });

  it("counts only added and deleted lines, not unchanged patch context", () => {
    const files = parseUnifiedPatch("diff --git a/src/a.ts b/src/a.ts\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n context\n");
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it("allocates a suffix when the same Finding is added from a later Analysis run", () => {
    const finding = result.findings[0];
    if (finding === undefined) throw new Error("fixture finding missing");
    const priorId: LocalReviewItemId = must(parseLocalReviewItemId("finding-1"));
    const item = createAnalysisFindingItem(finding, must(parseInsightRunId("insight-analysis-2-aaaaaaaaaaaa-review-42")), patch, new Set([priorId]));
    expect(item.id).toBe("finding-1-2");
  });

  it("merges only new insight findings and enforces CAS plus replacement acknowledgement", () => {
    const existingItem: ReviewBatchItem = { _tag: "InlineComment", id: "finding-1" as never, provenance: { _tag: "insight", runId }, source: "finding", findingId, anchor: { path: "src/a.ts" as never, startLine: 2, line: 2, side: "new" }, body: "Existing", include: true, postability: "postable" };
    const current: ReviewBatch = { ...emptyBatch(), summaryBody: "Human notes", items: [existingItem] };
    const merged = service.merge({ ...input, current, expectedRevision: now });
    expect(merged).toMatchObject({ _tag: "ok", value: { items: [{ id: "finding-1" }] } });
    if (merged._tag === "err") return;
    expect(merged.value.items).toHaveLength(1);
    expect(service.replace({ ...input, current, expectedRevision: now, acknowledgement: false })).toEqual({ _tag: "err", error: { reason: "replacement_acknowledgement_required" } });
    expect(service.merge({ ...input, current, expectedRevision: must(parseIsoTimestamp("2026-08-02T00:01:00.000Z")) })).toEqual({ _tag: "err", error: { reason: "revision_conflict" } });
  });
});
