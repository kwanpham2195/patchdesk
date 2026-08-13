import { describe, expect, it, vi } from "vitest";

import { createReviewId } from "../../src/domain/ids";
import type { Review } from "../../src/domain/review";
import { err, ok } from "../../src/domain/result";
import { ReviewWorkbenchController } from "../../src/services/review-workbench-controller";

const profileId = "cfw" as never;
const headSha = "a".repeat(40) as never;
const at = "2026-08-09T11:35:00.000Z" as never;
const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__b48f8e2e76ca" as never;
const identity = {
  profileId,
  host: "github.com" as never,
  owner: "centraldigital" as never,
  repo: "patchdesk" as never,
  prNumber: 42 as never,
};
const reviewId = createReviewId(identity);
const snapshotHash = "b".repeat(64) as never;
const review: Review = {
  schemaVersion: 2,
  id: reviewId,
  identity,
  currentSessionId: sessionId,
  currentHeadSha: headSha,
  representedRemote: {
    headSha,
    pullRequestUpdatedAt: at,
    snapshotHash,
    refreshedAt: at,
  },
  freshness: { _tag: "Fresh" },
  status: { _tag: "Open" },
  createdAt: at,
  updatedAt: at,
};
const snapshot = { pullRequest: { title: "represented" } } as never;
const projection = {
  state: "review",
  review: { id: reviewId, status: "open" },
  session: { id: sessionId },
  revision: { reviewedHeadSha: headSha, freshness: "fresh", refreshedAt: at },
  commits: [],
  insights: {},
  analysisReviewActions: {},
  conversation: {},
  checks: {},
  mergeReadiness: {},
  mergeReasons: [],
  directSummaryDecision: "unknown",
} as never;
function fixture(overrides: Record<string, unknown> = {}) {
  const preparation = {
    prepare: vi.fn(async () =>
      ok({ session: { id: sessionId, key: { headSha }, createdAt: at } }),
    ),
  };
  const project = { loadRepresented: vi.fn(async () => ok(projection)) };
  const lifecycle = {
    reviews: {
      load: vi.fn(async () => ok(review)),
      save: vi.fn(async () => ok(undefined)),
    },
    remote: { load: vi.fn(async () => ok(snapshot)) },
    journals: { load: vi.fn(async () => ok(undefined)) },
    refresh: { refresh: vi.fn(async () => ok(projection)) },
    observation: {
      recover: vi.fn(async () => ok(undefined)),
      observe: vi.fn(async () => ok(undefined)),
    },
    coordinator: {
      withReviewLock: vi.fn(
        async (_profile, _review, action) => await action(),
      ),
    },
    commits: { diff: vi.fn(async () => ok({})) },
    ...overrides,
  };
  return {
    controller: new ReviewWorkbenchController(
      preparation as never,
      project as never,
      lifecycle as never,
    ),
    preparation,
    project,
    lifecycle,
  };
}

describe("ReviewWorkbenchController", () => {
  it("loads only by reviewId and projects the durable represented snapshot", async () => {
    const value = fixture();
    await expect(
      value.controller.load({ profileId, reviewId }),
    ).resolves.toEqual({ _tag: "ok", value: projection });
    expect(value.lifecycle.reviews.load).toHaveBeenCalledWith(
      profileId,
      reviewId,
    );
    expect(value.lifecycle.remote.load).toHaveBeenCalledWith({
      profileId,
      reviewId,
      snapshotHash,
    });
    expect(value.project.loadRepresented).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: review.freshness,
      }),
    );
    expect(value.preparation.prepare).not.toHaveBeenCalled();
  });

  it("recovers an observation journal before projection", async () => {
    const journals = {
      load: vi
        .fn()
        .mockResolvedValueOnce(ok({ operation: "observe" }))
        .mockResolvedValueOnce(ok(undefined)),
    };
    const value = fixture({ journals });
    await expect(
      value.controller.load({ profileId, reviewId }),
    ).resolves.toMatchObject({ _tag: "ok" });
    expect(value.lifecycle.observation.recover).toHaveBeenCalledWith({
      profileId,
      reviewId,
    });
    expect(value.project.loadRepresented).toHaveBeenCalledOnce();
  });

  it("fails closed when an unreadable saved Review exists and never re-prepares", async () => {
    const value = fixture({
      reviews: {
        load: vi.fn(async () => err({ reason: "storage" })),
        save: vi.fn(),
      },
    });
    await expect(
      value.controller.open({
        profileId,
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "storage" } });
    expect(value.preparation.prepare).not.toHaveBeenCalled();
  });

  it("opens an already represented Review without a GitHub preparation or refresh", async () => {
    const value = fixture();
    await expect(
      value.controller.open({
        profileId,
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      }),
    ).resolves.toEqual({ _tag: "ok", value: projection });
    expect(value.preparation.prepare).not.toHaveBeenCalled();
    expect(value.lifecycle.refresh.refresh).not.toHaveBeenCalled();
  });

  it("delegates Refresh and observation by reviewId", async () => {
    const value = fixture();
    await expect(
      value.controller.refresh({ profileId, reviewId }),
    ).resolves.toEqual({ _tag: "ok", value: projection });
    await expect(
      value.controller.detectUpdates({ profileId, reviewId }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    expect(value.lifecycle.refresh.refresh).toHaveBeenCalledWith({
      profileId,
      reviewId,
    });
    expect(value.lifecycle.observation.observe).toHaveBeenCalledWith({
      profileId,
      reviewId,
    });
  });

  it("rejects malformed input before any lifecycle work", async () => {
    const value = fixture();
    await expect(value.controller.load({ profileId })).resolves.toEqual({
      _tag: "err",
      error: { reason: "invalid_input" },
    });
    await expect(value.controller.open({})).resolves.toEqual({
      _tag: "err",
      error: { reason: "invalid_input" },
    });
    expect(value.lifecycle.reviews.load).not.toHaveBeenCalled();
  });
});
