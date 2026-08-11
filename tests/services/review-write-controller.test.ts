import { describe, expect, it, vi } from "vitest";

import { ReviewWriteController } from "../../src/services/review-write-controller";
import { err, ok } from "../../src/domain/result";
import type { ReviewWriteGate } from "../../src/services/review-write-gate";

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

});
