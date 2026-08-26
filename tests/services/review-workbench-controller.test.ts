import { describe, expect, it, vi } from "vitest";

import { createReviewId } from "../../src/domain/ids";
import type { Review } from "../../src/domain/review";
import { err, ok } from "../../src/domain/result";
import { ReviewWorkbenchController } from "../../src/services/review-workbench-controller";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

// SAFETY: this literal is a well-formed WorkspaceProfileId slug.
const profileId = "cfw" as never;
// SAFETY: 40 lowercase hex characters are well-formed GitShas.
const headSha = "a".repeat(40) as never;
// SAFETY: 40 lowercase hex characters are a well-formed GitSha fixture.
const baseSha = "b".repeat(40) as never;
// SAFETY: this literal is a well-formed ISO 8601 instant, satisfying the
// branded IsoTimestamp values this fixture's Review/session fields expect.
const at = "2026-08-09T11:35:00.000Z" as never;
// SAFETY: this literal matches the branded head/base-aware ReviewSessionId slug format.
const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__b48f8e2e76ca" as never;
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
      ok({
        session: { id: sessionId, key: { headSha, baseSha }, createdAt: at },
      }),
    ),
  };
  const project = { loadRepresented: vi.fn(async () => ok(projection)) };
  // `refreshUnlocked`/`recoverUnlocked` alias the same mock as their locked
  // sibling by default: `open()`'s tree calls the Unlocked name (see
  // review-workbench-controller.ts), everything else calls the locked name,
  // and most tests don't care which was invoked, only that it was.
  const refreshFn = vi.fn(async () => ok(projection));
  const recoverFn = vi.fn(async () => ok(undefined));
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
    refresh: { refresh: refreshFn, refreshUnlocked: refreshFn },
    observation: {
      recover: recoverFn,
      recoverUnlocked: recoverFn,
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

  it("maps a preparation authentication failure onto the github_auth reason when opening a fresh Review", async () => {
    const value = fixture({
      reviews: {
        load: vi.fn(async () => err({ reason: "not_found" })),
        save: vi.fn(async () => ok(undefined)),
      },
    });
    value.preparation.prepare.mockImplementation(
      async () =>
        // SAFETY: the fixture's initial `vi.fn(async () => ok({...}))` fixes
        // this mock's inferred error type to `never`; this override only
        // ever returns `err`, so the cast is exhaustively true at every call.
        err({ _tag: "GitHubAuthenticationFailed" }) as never,
    );

    await expect(
      value.controller.open({
        profileId,
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "github_auth" } });
    expect(value.lifecycle.reviews.save).not.toHaveBeenCalled();
  });

  it("starts fresh automatically when an upgrade left the current session unavailable", async () => {
    let storedReview = review;
    let sessionAvailable = false;
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
    const refreshFn = vi.fn(async () => {
      storedReview = review;
      return ok(projection);
    });
    const refresh = { refresh: refreshFn, refreshUnlocked: refreshFn };
    const value = fixture({
      reviews,
      sessions,
      artifacts,
      refresh,
    });
    value.preparation.prepare.mockImplementation(async () => {
      sessionAvailable = true;
      return ok({
        session: {
          id: sessionId,
          key: { headSha, baseSha },
          createdAt: at,
        },
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

  it("quarantines a rejected schema-5 session, saves schema 6, and reopens it", async () => {
    const replacementSession = {
      schemaVersion: 6 as const,
      id: sessionId,
      key: { ...identity, headSha, baseSha },
      createdAt: at,
    };
    const representedRemote = review.representedRemote;
    if (representedRemote === undefined)
      throw new Error("Test fixture requires a represented snapshot");
    const savedSessions = new Map<string, typeof replacementSession>();
    let schemaFivePresent = true;
    let storedReview = review;
    const artifacts = {
      quarantineIfPresent: vi.fn(async () => {
        schemaFivePresent = false;
        return ok({ entryName: "session.schema-5.backup" });
      }),
      quarantineReview: vi.fn(async () => ok({ entryName: "review.backup" })),
    };
    const sessions = {
      load: vi.fn(async (_profileId: string, requestedSessionId: string) => {
        if (requestedSessionId === sessionId && schemaFivePresent)
          return err({
            _tag: "StorageFailure" as const,
            operation: "read" as const,
            reason: "invalid_stored_value" as const,
          });
        const saved = savedSessions.get(requestedSessionId);
        return saved === undefined
          ? err({
              _tag: "StorageFailure" as const,
              operation: "read" as const,
              reason: "not_found" as const,
            })
          : ok(saved);
      }),
    };
    const reviews = {
      load: vi.fn(async () => ok(storedReview)),
      save: vi.fn(async (saved) => {
        storedReview = saved;
        return ok(undefined);
      }),
    };
    const refreshFn = vi.fn(async () => {
      storedReview = {
        ...storedReview,
        representedRemote,
      };
      return ok(projection);
    });
    const refresh = { refresh: refreshFn, refreshUnlocked: refreshFn };
    const value = fixture({ sessions, artifacts, reviews, refresh });
    value.preparation.prepare.mockImplementation(async () => {
      savedSessions.set(replacementSession.id, replacementSession);
      return ok({
        session: replacementSession,
        disposition: "prepared" as const,
      });
    });
    const input = {
      profileId,
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 42,
    };

    await expect(value.controller.open(input)).resolves.toEqual({
      _tag: "ok",
      value: projection,
    });
    expect(artifacts.quarantineIfPresent).toHaveBeenCalledWith(
      profileId,
      sessionId,
    );
    expect(artifacts.quarantineReview).toHaveBeenCalledWith(
      profileId,
      reviewId,
    );
    expect(savedSessions.get(storedReview.currentSessionId)).toMatchObject({
      schemaVersion: 6,
      key: { headSha, baseSha },
    });

    await expect(value.controller.open(input)).resolves.toEqual({
      _tag: "ok",
      value: projection,
    });
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

  it("maps terminal-only preparation failure before saving a fresh Review", async () => {
    const reviews = {
      load: vi.fn(async () => err({ reason: "not_found" })),
      save: vi.fn(async () => ok(undefined)),
    };
    const value = fixture({ reviews });
    // SAFETY: this test's mocked prepare function can return this typed failure.
    value.preparation.prepare.mockImplementation(
      async () => err({ _tag: "PullRequestStateChanged" }) as never,
    );

    await expect(
      value.controller.openMerged({
        profileId,
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "terminal" } });
    expect(value.preparation.prepare).toHaveBeenCalledWith({
      profileId,
      pullRequest: {
        host: identity.host,
        owner: identity.owner,
        repo: identity.repo,
        number: identity.prNumber,
      },
      expectedPullRequestState: "non_open",
    });
    expect(reviews.save).not.toHaveBeenCalled();
  });

  it("requires terminal refresh before openMerged can return an existing writable Review", async () => {
    const refreshFn = vi.fn(async () => err({ reason: "terminal" }));
    const refresh = { refresh: refreshFn, refreshUnlocked: refreshFn };
    const value = fixture({ refresh });

    await expect(
      value.controller.openMerged({
        profileId,
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "terminal" } });
    expect(refresh.refresh).toHaveBeenCalledWith({
      profileId,
      reviewId,
      expectedTerminalState: "merged",
    });
    expect(value.project.loadRepresented).not.toHaveBeenCalled();
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
    const observe = vi.fn(async () =>
      ok({ _tag: "Reconciled", detectedAt: at }),
    );
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

  it("open() and refresh() serialize through the coordinator's own lock table, not a second open-only lock", async () => {
    // Regression for the two-lock-table bug: on `main`, `open()` serializes
    // through its own `openLocks` map while `refresh()` serializes through
    // `ReviewOperationCoordinator`. Those are different tables over the same
    // key, so a `refresh()` call concurrent with a blocked `open()` was free
    // to proceed. Fixed, both go through the one coordinator lock.
    const coordinator = new ReviewOperationCoordinator();
    let releaseSave: (() => void) | undefined;
    const savePending = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let observedSaveEntered: (() => void) | undefined;
    const saveEntered = new Promise<void>((resolve) => {
      observedSaveEntered = resolve;
    });
    let created = false;
    const reviews = {
      load: vi.fn(async () =>
        created ? ok(review) : err({ reason: "not_found" }),
      ),
      save: vi.fn(async () => {
        observedSaveEntered?.();
        await savePending;
        created = true;
        return ok(undefined);
      }),
    };
    // Mirrors production wiring: `ReviewRefreshService.refresh` takes the
    // same `ReviewOperationCoordinator` the controller does. This fake's
    // locked `refresh` re-enters that same coordinator on the same key, so a
    // concurrent `refresh()` call's first store read only runs once `open()`
    // releases the lock.
    const firstStoreRead = vi.fn(async () => ok(undefined));
    const refresh = {
      refresh: vi.fn(async (input: { profileId: string; reviewId: string }) =>
        coordinator.withReviewLock(
          input.profileId,
          input.reviewId,
          async () => {
            await firstStoreRead();
            return ok(projection);
          },
        ),
      ),
      refreshUnlocked: vi.fn(async () => ok(projection)),
    };
    const value = fixture({ reviews, refresh, coordinator });

    const opened = value.controller.open({
      profileId,
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 42,
    });
    // open() is now blocked inside reviews.save, still holding the
    // coordinator lock for this Review.
    await saveEntered;

    const refreshed = value.controller.refresh({ profileId, reviewId });
    // Give a not-actually-blocked continuation room to run: every mock here
    // resolves immediately, so a handful of microtask ticks is enough for
    // refresh()'s first store read to fire if it were not queued behind
    // open()'s held lock.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(firstStoreRead).not.toHaveBeenCalled();

    releaseSave?.();
    await opened;
    await refreshed;
    expect(firstStoreRead).toHaveBeenCalledOnce();
  });

  it("open() never re-enters its own coordinator lock while recovering, restarting, refreshing, or projecting", async () => {
    // Safety net beyond the two lock sites the plan names: every method
    // `open()`'s tree reaches (recoverObservation, restartUnusableReview,
    // initializeSnapshot's refresh, projectStable) has an Unlocked sibling.
    // Each "locked" fake below re-enters the *same* real coordinator on the
    // same key `open()` already holds, so calling the wrong (locked)
    // sibling from inside open()'s tree would hang this test rather than
    // fail an assertion — the timeout race turns that hang into a fast,
    // loud failure instead of stalling the suite.
    const coordinator = new ReviewOperationCoordinator();
    const recoverBody = vi.fn(async () =>
      ok({ _tag: "Unchanged", detectedAt: at }),
    );
    const observation = {
      observe: vi.fn(async () => ok(undefined)),
      recover: vi.fn(async (input: { profileId: string; reviewId: string }) =>
        coordinator.withReviewLock(input.profileId, input.reviewId, () =>
          recoverBody(),
        ),
      ),
      recoverUnlocked: vi.fn(async () => recoverBody()),
    };
    const refreshBody = vi.fn(async () => ok(projection));
    const refresh = {
      refresh: vi.fn(async (input: { profileId: string; reviewId: string }) =>
        coordinator.withReviewLock(input.profileId, input.reviewId, () =>
          refreshBody(),
        ),
      ),
      refreshUnlocked: vi.fn(async () => refreshBody()),
    };
    // The current session is unreadable the first time (forces
    // restartUnusableReview), then available once a fresh one is prepared.
    let sessionAvailable = false;
    const sessions = {
      load: vi.fn(async () =>
        sessionAvailable
          ? ok({ id: sessionId })
          : err({
              _tag: "StorageFailure" as const,
              operation: "read" as const,
              reason: "not_found" as const,
            }),
      ),
    };
    const artifacts = {
      quarantineIfPresent: vi.fn(async () =>
        ok({ entryName: "session.backup" }),
      ),
      quarantineReview: vi.fn(async () => ok({ entryName: "review.backup" })),
    };
    // A journal is present only for open()'s own initial recovery check;
    // restartOrKeepReview's and projectStableUnlocked's own journal checks
    // (later calls) must see it already cleared.
    const journals = {
      load: vi
        .fn()
        .mockResolvedValueOnce(ok({ operation: "observe" }))
        .mockResolvedValue(ok(undefined)),
    };
    const value = fixture({
      observation,
      refresh,
      sessions,
      artifacts,
      journals,
      coordinator,
    });
    value.preparation.prepare.mockImplementation(async () => {
      sessionAvailable = true;
      return ok({
        session: { id: sessionId, key: { headSha, baseSha }, createdAt: at },
      });
    });

    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 1000);
    });
    const opened = value.controller.open({
      profileId,
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 42,
    });
    const winner = await Promise.race([
      opened.then(() => "opened" as const),
      timeout,
    ]);

    expect(winner).toBe("opened");
    expect(recoverBody).toHaveBeenCalledOnce();
    expect(refreshBody).toHaveBeenCalledOnce();
    expect(observation.recover).not.toHaveBeenCalled();
    expect(refresh.refresh).not.toHaveBeenCalled();
  }, 2000);
});
