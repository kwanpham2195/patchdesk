/**
 * The Review, session and projection fixtures every ReviewWorkbenchController
 * suite builds on, and the lifecycle mock bag each one overrides a slice of.
 */

import { vi } from "vitest";

import { createReviewId } from "../../src/domain/ids";
import type { Review } from "../../src/domain/review";
import { ok } from "../../src/domain/result";
import { ReviewWorkbenchController } from "../../src/services/review-workbench-controller";

// SAFETY: this literal is a well-formed WorkspaceProfileId slug.
export const profileId = "cfw" as never;
// SAFETY: 40 lowercase hex characters are well-formed GitShas.
export const headSha = "a".repeat(40) as never;
// SAFETY: 40 lowercase hex characters are a well-formed GitSha fixture.
export const baseSha = "b".repeat(40) as never;
// SAFETY: this literal is a well-formed ISO 8601 instant, satisfying the
// branded IsoTimestamp values this fixture's Review/session fields expect.
export const at = "2026-08-09T11:35:00.000Z" as never;
// SAFETY: this literal matches the branded head/base-aware ReviewSessionId slug format.
export const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__b48f8e2e76ca" as never;
// SAFETY: these literals are well-formed GitHubHost/GitHubOwner/
// GitHubRepoName/PullRequestNumber values, matching their branded shapes.
export const identity = {
  profileId,
  host: "github.com" as never,
  owner: "centraldigital" as never,
  repo: "patchdesk" as never,
  prNumber: 42 as never,
};
export const reviewId = createReviewId(identity);
// SAFETY: 64 lowercase hex characters is a well-formed ContentHash.
export const snapshotHash = "b".repeat(64) as never;
export const review: Review = {
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
export const snapshot = { pullRequest: { title: "represented" } } as never;
// SAFETY: matches the renderer's ReviewWorkbenchProjection wire shape; the
// controller under test passes it through opaquely, so these suites only
// needs the fields it actually asserts on to be present.
export const projection = {
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
export function fixture(
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
      // ReviewSessionPreparation surface to what these suites exercise.
      preparation as never,
      // SAFETY: same narrowing as `preparation` above, scoped to
      // ReviewWorkbenchProjectionService's single `loadRepresented` method.
      project as never,
      // SAFETY: `lifecycle` implements every member the controller's
      // `lifecycle` dependency bag actually calls in these suites; unused
      // members of the real interfaces are intentionally omitted.
      lifecycle as never,
    ),
    preparation,
    project,
    lifecycle,
  };
}
