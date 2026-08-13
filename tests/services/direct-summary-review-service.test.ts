import { describe, expect, it, vi } from "vitest";

import { err, ok } from "../../src/domain/result";
import type { ReviewSession } from "../../src/domain/review-session";
import { DirectSummaryReviewService } from "../../src/services/direct-summary-review-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

const profileId = "cfw" as never;
const reviewId = "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa" as never;
const headSha = "a".repeat(40) as never;
const sessionId = "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__b48f8e2e76ca" as never;
const now = "2026-08-09T11:35:00.000Z" as never;
const expected = { sessionId, headSha, patchHash: "b".repeat(64) as never };
function session(directSummaryReview?: unknown, pendingReview?: unknown): ReviewSession { return { schemaVersion: 5, id: sessionId, key: { profileId, host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha }, pr: { headSha, isDraft: false, isOpen: true }, patchPath: "/tmp/patch" as never, worktree: { path: "/tmp/worktree" as never, headSha }, createdAt: now, updatedAt: now, ...(directSummaryReview === undefined ? {} : { directSummaryReview }), ...(pendingReview === undefined ? {} : { pendingReview }) } as unknown as ReviewSession; }
function fixture(state?: unknown, overrides: Record<string, unknown> = {}) {
  let stored = session(state);
  const saves: unknown[] = [];
  const sessions = { load: vi.fn(async () => ok(stored)), save: vi.fn(async (next: ReviewSession) => { stored = next; saves.push(next); return ok(undefined); }) };
  const gate = { requireFresh: vi.fn(async () => ok({ profile: { ghAccount: "fixture" }, session: stored })), requireCurrentSession: vi.fn(async () => ok({ profile: { ghAccount: "fixture" }, session: stored })) };
  const github = { getPullRequest: vi.fn(async () => ok({ headSha, author: "other" })), resolveAuthenticatedAccount: vi.fn(async () => ok({ account: "fixture" })), getViewerPendingReview: vi.fn(async () => ok({ _tag: "None" })), getViewerDirectSummaryReviews: vi.fn(async () => ok({ complete: true, reviews: [] })), createDirectSummaryReview: vi.fn(async () => ok({ reviewId: "9001", event: "COMMENT", headSha, submittedAt: now })), ...overrides };
  const coordinator = new ReviewOperationCoordinator();
  return { service: new DirectSummaryReviewService(gate as never, sessions as never, github as never, () => now, coordinator), github, coordinator, saves, current: () => stored };
}
const submit = (service: DirectSummaryReviewService) => service.submit({ profileId, reviewId, expected, event: "COMMENT", body: "summary" });

describe("DirectSummaryReviewService", () => {
  it("persists a confirmed direct-summary receipt before success", async () => {
    const value = fixture();
    await expect(submit(value.service)).resolves.toMatchObject({ _tag: "ok", value: { _tag: "Confirmed", receipt: { reviewId: "9001" } } });
    expect(value.saves).toHaveLength(2);
    expect(value.saves[0]).toMatchObject({ directSummaryReview: { _tag: "WriteInFlight" } });
    expect(value.saves[1]).toMatchObject({ directSummaryReview: { _tag: "Confirmed" } });
  });

  it("blocks author approval before intent or GitHub write", async () => {
    const value = fixture(undefined, { getPullRequest: vi.fn(async () => ok({ headSha, author: "fixture" })) });
    await expect(value.service.submit({ profileId, reviewId, expected, event: "APPROVE", body: "summary" })).resolves.toEqual({ _tag: "err", error: "self_approval_not_allowed" });
    expect(value.saves).toHaveLength(0);
    expect(value.github.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("blocks a confirmed pending review before intent or direct write", async () => {
    const value = fixture(undefined, { getViewerPendingReview: vi.fn(async () => ok({ _tag: "Pending" })) });
    await expect(submit(value.service)).resolves.toEqual({ _tag: "err", error: "pending_review_exists" });
    expect(value.saves).toHaveLength(0);
    expect(value.github.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("retains uncertainty and never replays its direct write", async () => {
    const value = fixture(undefined, { createDirectSummaryReview: vi.fn(async () => err({ category: "unavailable" })) });
    await expect(submit(value.service)).resolves.toEqual({ _tag: "err", error: "outcome_unknown" });
    expect(value.current()).toMatchObject({ directSummaryReview: { _tag: "OutcomeUnknown" } });
    await expect(submit(value.service)).resolves.toEqual({ _tag: "err", error: "outcome_unknown" });
    expect(value.github.createDirectSummaryReview).toHaveBeenCalledTimes(1);
  });

  it("reconciles a matching lost response to a confirmed receipt", async () => {
    const operation = { requestId: "request", event: "COMMENT", bodyDigest: "a".repeat(64), headSha, baselineReviewIds: [], startedAt: now };
    const value = fixture({ _tag: "OutcomeUnknown", operation, resolution: "check_required" }, { getViewerDirectSummaryReviews: vi.fn(async () => ok({ complete: true, reviews: [{ reviewId: "9001", event: "COMMENT", bodyDigest: operation.bodyDigest, headSha, submittedAt: now }] })) });
    await expect(value.service.reconcile({ profileId, reviewId })).resolves.toMatchObject({ _tag: "ok", value: { _tag: "Confirmed", receipt: { reviewId: "9001" } } });
    expect(value.github.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("uses the shared review coordinator for concurrent submissions", async () => {
    const value = fixture();
    const key = `${profileId}:${reviewId}`;
    expect(value.coordinator.acquire(key)).toBe(true);
    await expect(submit(value.service)).resolves.toEqual({ _tag: "err", error: "review_write_in_progress" });
    value.coordinator.release(key);
  });

  it("preserves a concurrent session field when persisting direct-summary state", async () => {
    const value = fixture();
    let first = true;
    const original = value.github.createDirectSummaryReview;
    value.github.createDirectSummaryReview = vi.fn(async (...args: never[]) => { void args; if (first) { first = false; } return await original(); });
    await expect(submit(value.service)).resolves.toMatchObject({ _tag: "ok" });
    expect(value.current()).toMatchObject({ directSummaryReview: { _tag: "Confirmed" } });
  });
});
