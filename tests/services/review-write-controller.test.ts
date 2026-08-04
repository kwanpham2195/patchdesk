import { describe, expect, it, vi } from "vitest";

import { ReviewWriteController } from "../../src/services/review-write-controller";
import { err, ok } from "../../src/domain/result";
import type { ReviewWriteGate } from "../../src/services/review-write-gate";
import { AnalysisCompletionService } from "../../src/services/analysis-completion-service";
import { createPublicationAuthorization } from "../../src/domain/publication-authorization";
import { AnalysisDraftService } from "../../src/services/analysis-draft-service";

const profileId = "cfw";
const reviewId = "github.com__centraldigital__patchdesk__pr-42__review-abcdef123456";
const sessionId = "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__abcdef123456";
const headSha = "abcdef1234567890abcdef1234567890abcdef12";
const patchHash = "a".repeat(64);
const revision = "2026-08-01T00:00:00.000Z";

function controller(gate: ReviewWriteGate, write = vi.fn()) {
  return new ReviewWriteController(
    {} as never,
    {} as never,
    { getPullRequest: write } as never,
    () => revision as never,
    undefined,
    gate,
  );
}

const request = {
  profileId,
  reviewId,
  sessionId,
  expectedHeadSha: headSha,
  expectedPatchHash: patchHash,
  expectedRevision: revision,
  acknowledgement: true,
};

describe("ReviewWriteController Review gate", () => {
  it("rejects a stale represented Review before loading a renderer-selected session or writing", async () => {
    const gate = { requireFresh: vi.fn(async () => err({ reason: "not_fresh" as const })) } as unknown as ReviewWriteGate;
    const githubWrite = vi.fn();

    const result = await controller(gate, githubWrite).applyBatch(request);

    expect(result).toEqual({ _tag: "err", error: { reason: "not_fresh" } });
    expect(gate.requireFresh).toHaveBeenCalledWith(profileId, reviewId, {
      sessionId,
      headSha,
      patchHash,
      draftRevision: revision,
    });
    expect(githubWrite).not.toHaveBeenCalled();
  });

  it("rejects a forged historical session even when the request supplies valid hashes", async () => {
    const gate = { requireFresh: vi.fn(async () => err({ reason: "stale" as const })) } as unknown as ReviewWriteGate;
    const githubWrite = vi.fn();
    const result = await controller(gate, githubWrite).applyBatch(request);
    expect(result).toEqual({ _tag: "err", error: { reason: "stale" } });
    expect(gate.requireFresh).toHaveBeenCalledWith(profileId, reviewId, { sessionId, headSha, patchHash, draftRevision: revision });
    expect(githubWrite).not.toHaveBeenCalled();
  });

  it("rejects an incomplete immutable identity for an existing Review", async () => {
    const gate = { requireFresh: vi.fn(async () => err({ reason: "not_fresh" as const })) } as unknown as ReviewWriteGate;
    const result = await controller(gate).applyBatch({ ...request, expectedHeadSha: undefined });

    expect(result).toEqual({ _tag: "err", error: { reason: "invalid_input" } });
    expect(gate.requireFresh).not.toHaveBeenCalled();
  });

  it.each(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const)("publishes a valid automatic completion for %s", async (event) => {
    let authorization = createPublicationAuthorization({
      id: "publication-completion" as never,
      profileId: profileId as never,
      reviewId: reviewId as never,
      sessionId: sessionId as never,
      headSha: headSha as never,
      patchHash: patchHash as never,
      analysisRunId: "insight-analysis-1-abcdef123456-review" as never,
      expectedDraftRevision: revision as never,
      event,
      createdAt: revision as never,
    });
    const completion = new AnalysisCompletionService({
      async load() { return ok(authorization); },
      async save(next) { authorization = next; return ok(undefined); },
    });
    const batch = { sessionId, state: { _tag: "Local" as const }, summaryBody: "Analysis summary", suggestedEvent: event, items: [], receipts: [], createdAt: revision, updatedAt: revision };
    const session = { key: { profileId, host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha }, batchContent: batch, state: { _tag: "ReviewCompleted", attemptId: "attempt" }, updatedAt: revision };
    const writes: string[] = [];
    const gate = {
      async hasReviewForSession() { return ok(false); },
      async requireFresh() { return ok({ profile: {} as never, session: session as never }); },
    } as unknown as ReviewWriteGate;
    const writesController = new ReviewWriteController(
      {} as never,
      { async save() { return ok(undefined); } } as never,
      {
        async getPullRequest() { return ok({ headSha }); },
        async createPendingReview() { writes.push("create"); return ok({ reviewId: "pending-1", state: "PENDING" as const }); },
        async submitPendingReview(input: { readonly event: typeof event; readonly reviewId: string }) { writes.push(`submit:${input.event}`); return ok({ reviewId: input.reviewId }); },
      } as never,
      () => revision as never,
      completion,
      gate,
    );
    const result = await writesController.confirmPublication({ ...request, analysisRunId: "insight-analysis-1-abcdef123456-review", authorizationId: "publication-completion", event });
    expect(result._tag).toBe("ok");
    expect(writes).toEqual(["create", `submit:${event}`]);
  });

  it("archives submitted receipts only when installing the successor draft", async () => {
    const saves: unknown[] = [];
    const batch = { sessionId, state: { _tag: "Local" as const }, summaryBody: "Summary", suggestedEvent: "COMMENT" as const, items: [], receipts: [], createdAt: revision, updatedAt: revision };
    const session = { key: { profileId, host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha }, batchContent: batch, state: { _tag: "ReviewCompleted", attemptId: "attempt" }, updatedAt: revision };
    let currentSession: unknown = session;
    const gate = { async requireFresh() { return ok({ profile: {} as never, session: currentSession as never }); } } as unknown as ReviewWriteGate;
    const writesController = new ReviewWriteController(
      {} as never,
      { async save(next: unknown) { saves.push(next); currentSession = next; return ok(undefined); } } as never,
      {
        async getPullRequest() { return ok({ headSha }); },
        async createPendingReview() { return ok({ reviewId: "pending-1", state: "PENDING" as const }); },
        async submitPendingReview(input: { readonly reviewId: string; readonly event: "COMMENT" }) { return ok({ reviewId: input.reviewId }); },
      } as never,
      () => revision as never,
      undefined,
      gate,
    );
    const result = await writesController.confirmPublication({ ...request, event: "COMMENT" });
    expect(result._tag).toBe("ok");
    const successor = saves[saves.length - 1];
    expect(successor).toMatchObject({
      batchContent: { state: { _tag: "Local" }, receipts: [] },
      archivedReceipts: [{ _tag: "PendingReviewCreated", reviewId: "pending-1", itemIds: [] }],
      submittedReview: { reviewId: "pending-1", event: "COMMENT" },
    });
  });

  it("binds automatic publication to the advancing seeded draft revision and rejects drift", async () => {
    const seededRevision = "2026-08-01T00:00:01.000Z";
    const authorization = createPublicationAuthorization({
      id: "publication-seeded" as never,
      profileId: profileId as never,
      reviewId: reviewId as never,
      sessionId: sessionId as never,
      headSha: headSha as never,
      patchHash: patchHash as never,
      analysisRunId: "insight-analysis-1-abcdef123456-review" as never,
      expectedDraftRevision: revision as never,
      event: "COMMENT",
      createdAt: revision as never,
    });
    let stored = authorization;
    const completion = new AnalysisCompletionService({
      async load() { return ok(stored); },
      async save(next) { stored = next; return ok(undefined); },
    });
    const rebound = await completion.rebindDraftRevision({
      profileId: profileId as never,
      reviewId: reviewId as never,
      sessionId: sessionId as never,
      headSha: headSha as never,
      patchHash: patchHash as never,
      analysisRunId: "insight-analysis-1-abcdef123456-review" as never,
      expectedDraftRevision: revision as never,
      event: "COMMENT",
      authorizationId: "publication-seeded" as never,
      nextDraftRevision: seededRevision as never,
    });
    expect(rebound).toEqual({ _tag: "ok", value: undefined });
    expect(stored.expectedDraftRevision).toBe(seededRevision);

    const seeded = new AnalysisDraftService().seed({
      sessionId: sessionId as never,
      analysisRunId: "insight-analysis-1-abcdef123456-review" as never,
      result: { changeSummary: "A change", verdict: "comment", summary: "Seeded analysis summary", findings: [], validationPlan: [], assumptions: [] } as never,
      scope: { baseShort: "base", headShort: "head", commitCount: 1, fileCount: 0, additions: 0, deletions: 0, changedFiles: [] },
      now: seededRevision as never,
      current: { sessionId, state: { _tag: "Local" }, summaryBody: "", suggestedEvent: "COMMENT", items: [], receipts: [], createdAt: revision, updatedAt: revision } as never,
    });
    if (seeded._tag === "err") throw new Error("expected the empty draft to seed");
    const batch = seeded.value;
    const session = { key: { profileId, host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha }, batchContent: batch, state: { _tag: "ReviewCompleted", attemptId: "attempt" }, updatedAt: seededRevision };
    const gate = {
      async hasReviewForSession() { return ok(false); },
      async requireFresh() { return ok({ profile: {} as never, session: session as never }); },
    } as unknown as ReviewWriteGate;
    const writes: string[] = [];
    const writesController = new ReviewWriteController(
      {} as never,
      { async save() { return ok(undefined); } } as never,
      {
        async getPullRequest() { return ok({ headSha }); },
        async createPendingReview() { writes.push("create"); return ok({ reviewId: "pending-1", state: "PENDING" as const }); },
        async submitPendingReview() { writes.push("submit"); return ok({ reviewId: "pending-1" }); },
      } as never,
      () => seededRevision as never,
      completion,
      gate,
    );
    await expect(writesController.confirmPublication({ ...request, expectedRevision: seededRevision, authorizationId: "publication-seeded", analysisRunId: "insight-analysis-1-abcdef123456-review", event: "COMMENT" })).resolves.toMatchObject({ _tag: "ok" });
    expect(writes).toEqual(["create", "submit"]);

    const driftAuthorization = createPublicationAuthorization({ ...authorization, id: "publication-drift" as never, expectedDraftRevision: seededRevision as never });
    let driftStored = driftAuthorization;
    const driftCompletion = new AnalysisCompletionService({ async load() { return ok(driftStored); }, async save(next) { driftStored = next; return ok(undefined); } });
    const driftSession = { ...session, batchContent: { ...batch, updatedAt: revision }, updatedAt: revision };
    const driftGate = { async hasReviewForSession() { return ok(false); }, async requireFresh() { return ok({ profile: {} as never, session: driftSession as never }); } } as unknown as ReviewWriteGate;
    const driftWrites = vi.fn();
    const driftController = new ReviewWriteController({} as never, {} as never, { async getPullRequest() { return ok({ headSha }); }, async createPendingReview() { driftWrites(); return ok({ reviewId: "pending-1", state: "PENDING" as const }); }, async submitPendingReview() { driftWrites(); return ok({ reviewId: "pending-1" }); } } as never, () => seededRevision as never, driftCompletion, driftGate);
    await expect(driftController.confirmPublication({ ...request, expectedRevision: revision, authorizationId: "publication-drift", analysisRunId: "insight-analysis-1-abcdef123456-review", event: "COMMENT" })).resolves.toEqual({ _tag: "err", error: { reason: "authorization_mismatch" } });
    expect(driftWrites).not.toHaveBeenCalled();
  });

  it("rejects automatic publication when any immutable completion identity mismatches", async () => {
    const authorization = createPublicationAuthorization({ id: "publication-mismatch" as never, profileId: profileId as never, reviewId: reviewId as never, sessionId: sessionId as never, headSha: headSha as never, patchHash: patchHash as never, analysisRunId: "insight-analysis-1-abcdef123456-review" as never, expectedDraftRevision: revision as never, event: "COMMENT", createdAt: revision as never });
    const completion = new AnalysisCompletionService({ async load() { return ok(authorization); }, async save() { return ok(undefined); } });
    const session = { key: { profileId, host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha }, batchContent: { sessionId, state: { _tag: "Local" }, summaryBody: "Summary", suggestedEvent: "COMMENT", items: [], receipts: [], createdAt: revision, updatedAt: revision }, state: { _tag: "ReviewCompleted", attemptId: "attempt" }, updatedAt: revision };
    const gate = { async hasReviewForSession() { return ok(false); }, async requireFresh() { return ok({ profile: {} as never, session: session as never }); } } as unknown as ReviewWriteGate;
    const writes = vi.fn();
    const writesController = new ReviewWriteController({} as never, {} as never, { async getPullRequest() { return ok({ headSha }); }, async createPendingReview() { writes(); return ok({ reviewId: "pending-1", state: "PENDING" as const }); }, async submitPendingReview() { writes(); return ok({ reviewId: "pending-1" }); } } as never, () => revision as never, completion, gate);
    const result = await writesController.confirmPublication({ ...request, expectedPatchHash: "c".repeat(64), analysisRunId: "insight-analysis-1-abcdef123456-review", authorizationId: "publication-mismatch", event: "COMMENT" });
    expect(result).toEqual({ _tag: "err", error: { reason: "authorization_mismatch" } });
    expect(writes).not.toHaveBeenCalled();
  });
});
