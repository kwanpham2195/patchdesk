import { describe, expect, it, vi } from "vitest";

import { createReviewId } from "../../src/domain/ids";
import type { Review } from "../../src/domain/review";
import { err, ok } from "../../src/domain/result";
import { ReviewWorkbenchController } from "../../src/services/review-workbench-controller";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

// SAFETY: this literal is a well-formed WorkspaceProfileId slug.
const profileId = "cfw" as never;
// SAFETY: 40 lowercase hex characters is a well-formed GitSha.
const headSha = "a".repeat(40) as never;
// SAFETY: this literal is a well-formed ISO 8601 instant, satisfying the
// branded IsoTimestamp values this fixture's Review/session fields expect.
const at = "2026-08-09T11:35:00.000Z" as never;
// SAFETY: this literal matches the branded ReviewSessionId slug format.
const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__b48f8e2e76ca" as never;
// SAFETY: these literals are well-formed GitHubHost/GitHubOwner/
// GitHubRepoName/PullRequestNumber values, matching their branded shapes.
const identity = {
  profileId,
  host: "github.com" as never,
  owner: "centraldigital" as never,
  repo: "patchdesk" as never,
  prNumber: 42 as never,
};
const reviewId = createReviewId(identity);
// SAFETY: 64 lowercase hex characters is a well-formed ContentHash.
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
// SAFETY: this minimal shape is opaque to the controller under test — it is
// only ever passed through `remote.load`/`project.loadRepresented`'s mocks,
// never inspected field-by-field, so a full ReviewRemoteSnapshot is unneeded.
const snapshot = { pullRequest: { title: "represented" } } as never;
// SAFETY: matches the renderer's ReviewWorkbenchProjection wire shape; the
// controller under test passes it through opaquely, so this suite only
// needs the fields it actually asserts on to be present.
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
function fixture(
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- each test overrides a different, differently-shaped subset of the lifecycle mock bag below (error-shaped Results, plain methods instead of vi.fn(), a real ReviewOperationCoordinator, etc.); the merged result is narrowed to `never` at the constructor call below, same as the base fixture fields it's merged with.
  overrides: Record<string, unknown> = {},
) {
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
    sessions: { load: vi.fn(async () => ok({ id: sessionId })) },
    artifacts: {
      quarantineIfPresent: vi.fn(async () =>
        ok({ entryName: "session.backup" }),
      ),
      quarantineReview: vi.fn(async () => ok({ entryName: "review.backup" })),
    },
    remote: { load: vi.fn(async () => ok(snapshot)) },
    journals: { load: vi.fn(async () => ok(undefined)) },
    recentWrites: { load: vi.fn(async () => ok([])) },
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
      // SAFETY: this fixture only implements the `prepare` method the
      // controller actually calls, a deliberate narrowing of the full
      // ReviewSessionPreparation surface to what this suite exercises.
      preparation as never,
      // SAFETY: same narrowing as `preparation` above, scoped to
      // ReviewWorkbenchProjectionService's single `loadRepresented` method.
      project as never,
      // SAFETY: `lifecycle` implements every member the controller's
      // `lifecycle` dependency bag actually calls in this suite; unused
      // members of the real interfaces are intentionally omitted.
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

  it("starts fresh automatically when an upgrade left the current session unavailable", async () => {
    let storedReview = review;
    let sessionAvailable = false;
    let observedPreflight: (() => void) | undefined;
    const preflight = new Promise<void>((resolve) => {
      observedPreflight = resolve;
    });
    const reviews = {
      async load() {
        return ok(storedReview);
      },
      async save(next: Review) {
        storedReview = next;
        return ok(undefined);
      },
    };
    const sessions = {
      async load() {
        observedPreflight?.();
        return sessionAvailable
          ? ok({ id: sessionId })
          : err({
              _tag: "StorageFailure" as const,
              operation: "read" as const,
              reason: "not_found" as const,
            });
      },
    };
    const artifacts = {
      quarantineIfPresent: vi.fn(async () =>
        ok({ entryName: "session.backup" }),
      ),
      quarantineReview: vi.fn(async () => ok({ entryName: "review.backup" })),
    };
    const refresh = {
      async refresh() {
        storedReview = review;
        return ok(projection);
      },
    };
    const coordinator = new ReviewOperationCoordinator();
    expect(coordinator.acquire(`${profileId}:${reviewId}`)).toBe(true);
    const value = fixture({
      reviews,
      sessions,
      artifacts,
      refresh,
      coordinator,
    });
    value.preparation.prepare.mockImplementation(async () => {
      sessionAvailable = true;
      return ok({
        session: { id: sessionId, key: { headSha }, createdAt: at },
        disposition: "prepared" as const,
      });
    });

    const opened = value.controller.open({
      profileId,
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 42,
    });
    await preflight;
    expect(artifacts.quarantineReview).not.toHaveBeenCalled();
    coordinator.release(`${profileId}:${reviewId}`);

    await expect(opened).resolves.toEqual({ _tag: "ok", value: projection });
    expect(artifacts.quarantineIfPresent).toHaveBeenCalledWith(
      profileId,
      sessionId,
    );
    expect(artifacts.quarantineReview).toHaveBeenCalledWith(
      profileId,
      reviewId,
    );
    expect(value.preparation.prepare).toHaveBeenCalledOnce();
  });

  it("quarantines a corrupt Review record and rebuilds the Review fresh", async () => {
    const artifacts = {
      quarantineIfPresent: vi.fn(),
      quarantineReview: vi.fn(async () => ok({ entryName: "review.backup" })),
    };
    const reviews = {
      load: vi
        .fn()
        .mockResolvedValueOnce(
          err({
            _tag: "StorageFailure" as const,
            operation: "read" as const,
            reason: "invalid_stored_value" as const,
          }),
        )
        .mockResolvedValue(ok(review)),
      save: vi.fn(async () => ok(undefined)),
    };
    const value = fixture({ reviews, artifacts });

    await expect(
      value.controller.open({
        profileId,
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      }),
    ).resolves.toEqual({ _tag: "ok", value: projection });
    expect(artifacts.quarantineReview).toHaveBeenCalledWith(
      profileId,
      reviewId,
    );
    expect(value.preparation.prepare).toHaveBeenCalledOnce();
  });

  it("fails closed instead of resetting state after a transient storage error", async () => {
    const artifacts = {
      quarantineIfPresent: vi.fn(),
      quarantineReview: vi.fn(),
    };
    const value = fixture({
      sessions: {
        load: vi.fn(async () =>
          err({
            _tag: "StorageFailure" as const,
            operation: "read" as const,
            reason: "io" as const,
          }),
        ),
      },
      artifacts,
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
    expect(artifacts.quarantineReview).not.toHaveBeenCalled();
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

  it("unions the durable own-write journal into detectUpdates so a renderer reload does not drop the maintainer's own recent write", async () => {
    // Simulates the eventual-consistency lag where GitHub's read has not yet
    // caught up with a just-made write: observation would omit the comment
    // and only skip pushing a projection if it can see the journaled write.
    const observe = vi.fn(
      async (observeInput: {
        readonly recentWrites?: ReadonlyArray<unknown>;
      }) =>
        ok(
          observeInput.recentWrites !== undefined &&
            observeInput.recentWrites.length > 0
            ? { _tag: "Reconciled", detectedAt: at }
            : { _tag: "Reconciled", detectedAt: at, projection },
        ),
    );
    const recentWrites = {
      load: vi.fn(async () =>
        ok([{ _tag: "Comment" as const, commentId: "not-visible-yet" }]),
      ),
    };
    const value = fixture({
      recentWrites,
      observation: { recover: vi.fn(), observe },
    });
    // A renderer reload starts with an empty in-memory journal: no
    // recentWrites is sent on the request.
    await expect(
      value.controller.detectUpdates({ profileId, reviewId }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "Reconciled", detectedAt: at },
    });
    expect(recentWrites.load).toHaveBeenCalledWith(profileId, reviewId);
    expect(observe).toHaveBeenCalledWith({
      profileId,
      reviewId,
      recentWrites: [{ _tag: "Comment", commentId: "not-visible-yet" }],
    });
  });

  it("dedupes a LabelChange entry the durable journal and the request both carry", async () => {
    // Exercises this file's own copy of recentWriteDedupeKey (duplicated
    // from review-refresh-service.ts): missing the LabelChange case here
    // would let an identical durable+requested pair through as two entries.
    const observe = vi.fn(async () => ok({ _tag: "Reconciled", detectedAt: at }));
    const recentWrites = {
      load: vi.fn(async () =>
        ok([{ _tag: "LabelChange" as const, added: ["bug"], removed: [] }]),
      ),
    };
    const value = fixture({
      recentWrites,
      observation: { recover: vi.fn(), observe },
    });
    await value.controller.detectUpdates({
      profileId,
      reviewId,
      recentWrites: [{ _tag: "LabelChange", added: ["bug"], removed: [] }],
    });
    expect(observe).toHaveBeenCalledWith({
      profileId,
      reviewId,
      recentWrites: [{ _tag: "LabelChange", added: ["bug"], removed: [] }],
    });
  });

  it("negative control: without a durable journal entry, an empty request-supplied journal still yields a projection", async () => {
    const observe = vi.fn(
      async (observeInput: {
        readonly recentWrites?: ReadonlyArray<unknown>;
      }) =>
        ok(
          observeInput.recentWrites !== undefined &&
            observeInput.recentWrites.length > 0
            ? { _tag: "Reconciled", detectedAt: at }
            : { _tag: "Reconciled", detectedAt: at, projection },
        ),
    );
    const value = fixture({ observation: { recover: vi.fn(), observe } });
    await expect(
      value.controller.detectUpdates({ profileId, reviewId }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { _tag: "Reconciled", detectedAt: at, projection },
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
