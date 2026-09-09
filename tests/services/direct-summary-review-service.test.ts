import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { createReviewSessionId, type IsoTimestamp } from "../../src/domain/ids";
import { err, ok } from "../../src/domain/result";
import type { DirectSummaryReviewState } from "../../src/domain/direct-summary-review";
import type { PendingReviewState } from "../../src/domain/pending-review";
import type { ReviewSession } from "../../src/domain/review-session";
import { DirectSummaryReviewService } from "../../src/services/direct-summary-review-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

// SAFETY: this literal matches parseWorkspaceProfileId's accepted slug shape.
const profileId = "cfw" as never;
// SAFETY: this literal matches parseReviewId's <host>__owner__repo__pr-N__review-<hex> shape.
const reviewId =
  "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa" as never;
// SAFETY: these literals are 40-character hex strings, matching parseGitSha's format.
const headSha = "a".repeat(40) as never;
// SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
const baseSha = "b".repeat(40) as never;
// SAFETY: this literal matches createReviewSessionId's head/base-aware shape.
const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__b48f8e2e76ca" as never;
// SAFETY: this literal is a well-formed ISO 8601 instant, matching parseIsoTimestamp's format.
const now = "2026-08-09T11:35:00.000Z" as never;
// SAFETY: these literals are well-formed ISO 8601 instants, matching parseIsoTimestamp's format.
// Ordered before `now` so a rejected compare-and-swap can only be the
// expectation mismatch, never the store's strictly-increasing updatedAt rule.
const seededAt = "2026-08-09T11:30:00.000Z" as never;
// SAFETY: this literal is a well-formed ISO 8601 instant, matching parseIsoTimestamp's format.
const competingAt = "2026-08-09T11:32:00.000Z" as never;
// SAFETY: this literal is a 64-character hex string, matching parseContentHash's format.
const expected = { sessionId, headSha, patchHash: "b".repeat(64) as never };
function session(
  directSummaryReview?: DirectSummaryReviewState,
  pendingReview?: PendingReviewState,
): ReviewSession {
  const base = {
    schemaVersion: 6 as const,
    id: sessionId,
    // SAFETY: these literals match their branded parsers' accepted formats
    // (a bare hostname, and slug-shaped owner/repo names).
    key: {
      profileId,
      host: "github.com" as never,
      owner: "centraldigital" as never,
      repo: "patchdesk" as never,
      // SAFETY: this literal is a positive integer, matching parsePullRequestNumber's format.
      prNumber: 42 as never,
      headSha,
      baseSha,
    },
    pr: { headSha, baseSha, isDraft: false, isOpen: true },
    // SAFETY: these literals match parseAbsolutePath's format (a leading-slash path).
    patchPath: "/tmp/patch" as never,
    // SAFETY: this literal matches parseAbsolutePath's format (a leading-slash path).
    worktree: { path: "/tmp/worktree" as never, headSha },
    createdAt: now,
    updatedAt: now,
  };
  const withDirectSummary =
    directSummaryReview === undefined ? base : { ...base, directSummaryReview };
  return pendingReview === undefined
    ? withDirectSummary
    : { ...withDirectSummary, pendingReview };
}
function fixture(
  state?: DirectSummaryReviewState,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- each test overrides a differently-shaped github mock method (varying Result payloads); there is no single concrete return type across every possible override.
  overrides: Record<string, (...args: never[]) => unknown> = {},
) {
  let stored = session(state);
  const saves: unknown[] = [];
  const sessions = {
    load: vi.fn(async () => ok(stored)),
    save: vi.fn(async (next: ReviewSession) => {
      stored = next;
      saves.push(next);
      return ok(undefined);
    }),
  };
  const gate = {
    requireFresh: vi.fn(async () =>
      ok({ profile: { ghAccount: "fixture" }, session: stored }),
    ),
    requireCurrentSession: vi.fn(async () =>
      ok({ profile: { ghAccount: "fixture" }, session: stored }),
    ),
  };
  const github = {
    getPullRequest: vi.fn(async () => ok({ headSha, author: "other" })),
    resolveAuthenticatedAccount: vi.fn(async () => ok({ account: "fixture" })),
    getViewerPendingReview: vi.fn(async () => ok({ _tag: "None" })),
    getViewerDirectSummaryReviews: vi.fn(async () =>
      ok({ complete: true, reviews: [] }),
    ),
    createDirectSummaryReview: vi.fn(async () =>
      ok({ reviewId: "9001", event: "COMMENT", headSha, submittedAt: now }),
    ),
    ...overrides,
  };
  const coordinator = new ReviewOperationCoordinator();
  const recentWrites = { append: vi.fn(async () => ok(undefined)) };
  // SAFETY: these fixture mocks implement only the Pick<...> subset each
  // dependency interface requires; the service never calls their other members.
  return {
    service: new DirectSummaryReviewService(
      gate as never,
      sessions as never,
      github as never,
      () => now,
      coordinator,
      recentWrites,
    ),
    github,
    coordinator,
    recentWrites,
    saves,
    current: () => stored,
  };
}
const submit = (service: DirectSummaryReviewService) =>
  service.submit({
    profileId,
    reviewId,
    expected,
    event: "COMMENT",
    body: "summary",
  });

describe("DirectSummaryReviewService", () => {
  it("refuses a write as stale_head when GitHub reports a moved head", async () => {
    const value = fixture(undefined, {
      // SAFETY: this literal is a 40-character hex string, matching parseGitSha's format.
      getPullRequest: async () =>
        ok({ headSha: "c".repeat(40), author: "other" }),
    });
    await expect(submit(value.service)).resolves.toEqual({
      _tag: "err",
      error: "stale_head",
    });
    expect(value.github.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("persists a confirmed direct-summary receipt before success", async () => {
    const value = fixture();
    await expect(submit(value.service)).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Confirmed", receipt: { reviewId: "9001" } },
    });
    expect(value.saves).toHaveLength(2);
    expect(value.saves[0]).toMatchObject({
      directSummaryReview: { _tag: "WriteInFlight" },
    });
    expect(value.saves[1]).toMatchObject({
      directSummaryReview: { _tag: "Confirmed" },
    });
  });

  it("blocks author approval before intent or GitHub write", async () => {
    const value = fixture(undefined, {
      getPullRequest: vi.fn(async () => ok({ headSha, author: "fixture" })),
    });
    await expect(
      value.service.submit({
        profileId,
        reviewId,
        expected,
        event: "APPROVE",
        body: "summary",
      }),
    ).resolves.toEqual({ _tag: "err", error: "self_approval_not_allowed" });
    expect(value.saves).toHaveLength(0);
    expect(value.github.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("blocks a confirmed pending review before intent or direct write", async () => {
    const value = fixture(undefined, {
      getViewerPendingReview: vi.fn(async () => ok({ _tag: "Pending" })),
    });
    await expect(submit(value.service)).resolves.toEqual({
      _tag: "err",
      error: "pending_review_exists",
    });
    expect(value.saves).toHaveLength(0);
    expect(value.github.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("retains uncertainty and never replays its direct write", async () => {
    const value = fixture(undefined, {
      createDirectSummaryReview: vi.fn(async () =>
        err({ category: "unavailable" }),
      ),
    });
    await expect(submit(value.service)).resolves.toEqual({
      _tag: "err",
      error: "outcome_unknown",
    });
    expect(value.current()).toMatchObject({
      directSummaryReview: { _tag: "OutcomeUnknown" },
    });
    await expect(submit(value.service)).resolves.toEqual({
      _tag: "err",
      error: "outcome_unknown",
    });
    expect(value.github.createDirectSummaryReview).toHaveBeenCalledTimes(1);
  });

  it("surfaces a forbidden write as 'forbidden', not the generic 'rejected' category", async () => {
    const value = fixture(undefined, {
      createDirectSummaryReview: vi.fn(async () =>
        err({ category: "forbidden" }),
      ),
    });
    await expect(submit(value.service)).resolves.toEqual({
      _tag: "err",
      error: "forbidden",
    });
  });

  it("reconciles a matching lost response to a confirmed receipt", async () => {
    const operation = {
      requestId: "request",
      event: "COMMENT" as const,
      bodyDigest: "a".repeat(64),
      headSha,
      baselineReviewIds: [],
      startedAt: now,
    };
    const value = fixture(
      { _tag: "OutcomeUnknown", operation, resolution: "check_required" },
      {
        getViewerDirectSummaryReviews: vi.fn(async () =>
          ok({
            complete: true,
            reviews: [
              {
                reviewId: "9001",
                event: "COMMENT",
                bodyDigest: operation.bodyDigest,
                headSha,
                submittedAt: now,
              },
            ],
          }),
        ),
      },
    );
    await expect(
      value.service.reconcile({ profileId, reviewId }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Confirmed", receipt: { reviewId: "9001" } },
    });
    expect(value.github.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("uses the shared review coordinator for concurrent submissions", async () => {
    const value = fixture();
    const key = `${profileId}:${reviewId}`;
    expect(value.coordinator.acquire(key)).toBe(true);
    await expect(submit(value.service)).resolves.toEqual({
      _tag: "err",
      error: "review_write_in_progress",
    });
    value.coordinator.release(key);
  });

  it("preserves a concurrent session field when persisting direct-summary state", async () => {
    const value = fixture();
    let first = true;
    const original = value.github.createDirectSummaryReview;
    value.github.createDirectSummaryReview = vi.fn(async (...args: never[]) => {
      void args;
      if (first) {
        first = false;
      }
      return await original();
    });
    await expect(submit(value.service)).resolves.toMatchObject({ _tag: "ok" });
    expect(value.current()).toMatchObject({
      directSummaryReview: { _tag: "Confirmed" },
    });
  });
});

describe("DirectSummaryReviewService save compare-and-swap", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("reports unavailable when a competing write lands between the reload and the save", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-summary-cas-"));
    roots.push(root);
    const sessions = new ReviewSessionStore(PatchdeskPaths.forTest(root));
    const operation = {
      requestId: "request",
      event: "COMMENT" as const,
      bodyDigest: "a".repeat(64),
      headSha,
      baselineReviewIds: [],
      startedAt: now,
    };
    // The store rejects any session whose id is not derived from its key, so
    // the literal id the fake-store fixtures use will not round-trip here.
    const base = session({
      _tag: "OutcomeUnknown",
      operation,
      resolution: "check_required",
    } as never);
    const seeded = {
      ...base,
      id: createReviewSessionId(base.key),
      updatedAt: seededAt,
    };
    expect(await sessions.save(seeded)).toMatchObject({ _tag: "ok" });
    let competing = true;
    const store = {
      load: sessions.load.bind(sessions),
      async save(next: ReviewSession, expectedUpdatedAt?: IsoTimestamp) {
        if (competing) {
          competing = false;
          // Another process lands a write in the window the in-process mutex
          // does not cover: after this service's reload, before its write.
          const current = await sessions.load(profileId, seeded.id);
          if (current._tag === "ok")
            await sessions.save(
              { ...current.value, updatedAt: competingAt },
              current.value.updatedAt,
            );
        }
        return sessions.save(next, expectedUpdatedAt);
      },
    };
    const gate = {
      requireCurrentSession: vi.fn(async () => {
        const loaded = await sessions.load(profileId, seeded.id);
        if (loaded._tag === "err") throw new Error("fixture");
        return ok({ profile: { ghAccount: "fixture" }, session: loaded.value });
      }),
    };
    const github = {
      resolveAuthenticatedAccount: vi.fn(async () =>
        ok({ account: "fixture" }),
      ),
      getViewerDirectSummaryReviews: vi.fn(async () =>
        ok({ complete: true, reviews: [] }),
      ),
    };
    const service = new DirectSummaryReviewService(
      // SAFETY: these fixture mocks implement only the Pick<...> subset each
      // dependency interface requires; the service never calls their other members.
      gate as never,
      store as never,
      github as never,
      () => now,
      new ReviewOperationCoordinator(),
      { append: vi.fn(async () => ok(undefined)) },
    );

    await expect(service.reconcile({ profileId, reviewId })).resolves.toEqual({
      _tag: "err",
      error: "unavailable",
    });
    const rejected = await sessions.load(profileId, seeded.id);
    expect(rejected).toMatchObject({
      _tag: "ok",
      value: {
        updatedAt: competingAt,
        directSummaryReview: { _tag: "OutcomeUnknown" },
      },
    });

    // The next reconcile reloads the competitor's session, so its expectation
    // matches and the same clear now lands.
    await expect(service.reconcile({ profileId, reviewId })).resolves.toEqual({
      _tag: "ok",
      value: undefined,
    });
    const cleared = await sessions.load(profileId, seeded.id);
    expect(cleared).toMatchObject({ _tag: "ok", value: { updatedAt: now } });
    if (cleared._tag === "err") throw new Error("fixture");
    expect(cleared.value.directSummaryReview).toBeUndefined();
  });
});
