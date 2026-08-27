import { vi } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { createReviewId } from "../../src/domain/ids";
import { err, ok } from "../../src/domain/result";
import { ReviewWorkbenchProjectionService } from "../../src/services/review-workbench-projection";

// No fixture below gives a comment an `authorAvatarUrl`, so the projection
// never reads the avatar cache; this path need not exist on disk.
export const paths = PatchdeskPaths.forTest(
  "/does-not-exist/patchdesk-projection-test",
);

// SAFETY: `as never` casts throughout this file bypass branded-primitive
// construction for test-only fixture literals; the brands only exist for
// compile-time cross-boundary safety, and every cast value already
// satisfies its branded type's runtime shape.
export const profileId = "cfw" as never;
// SAFETY: a 40-char hex string already satisfies GitSha's runtime shape.
export const headSha = "a".repeat(40) as never;
// SAFETY: a plain ISO-8601 string already satisfies IsoTimestamp's runtime shape.
export const at = "2026-08-09T11:35:00.000Z" as never;
// SAFETY: a composite `host__owner__repo__pr-N__sha-...__hash` string already satisfies SessionId's runtime shape.
export const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca" as never;
export const identity = {
  profileId,
  // SAFETY: a plain host string already satisfies GitHubHost's runtime shape.
  host: "github.com" as never,
  // SAFETY: a plain owner string already satisfies GitHubOwner's runtime shape.
  owner: "centraldigital" as never,
  // SAFETY: a plain repo name already satisfies GitHubRepoName's runtime shape.
  repo: "patchdesk" as never,
  // SAFETY: a positive integer already satisfies PullRequestNumber's runtime shape.
  prNumber: 42 as never,
};
export const reviewId = createReviewId(identity);
// SAFETY: a 64-char hex string already satisfies ContentHash's runtime shape.
export const hash = "b".repeat(64) as never;
export function session(
  localCheckoutWarning?: "missing_local_path" | "local_checkout_unavailable",
  // A real, readable patch file. Only the tests that need the projection to
  // compute a `patchHash` pass one; the default path does not exist, so the
  // patch read fails and `patchHash` stays `undefined`, which is what every
  // other fixture in this file expects.
  patchPath = "/does-not-exist",
) {
  // SAFETY: this whole fixture is cast `as never` because it stands in for a
  // full, internal `ReviewSession` record the service under test never
  // re-validates (it is handed back verbatim by the mocked `sessions.load`);
  // every field already matches its real runtime shape.
  return {
    id: sessionId,
    key: { ...identity, headSha },
    pr: { headSha, baseSha: headSha, isDraft: false, isOpen: true },
    prContext: {
      title: "saved title",
      author: "author",
      headBranch: "feature",
      baseBranch: "sit",
    },
    // SAFETY: a plain filesystem path string already satisfies the branded patch-path type's runtime shape.
    patchPath: patchPath as never,
    // SAFETY: a plain filesystem path string already satisfies the branded worktree-path type's runtime shape.
    worktree: { path: "/tmp/worktree" as never, headSha },
    pendingReview: {
      _tag: "Pending",
      review: {
        // SAFETY: a plain string already satisfies the branded GraphQL node-id type's runtime shape.
        nodeId: "node" as never,
        // SAFETY: a plain string already satisfies the branded REST id type's runtime shape.
        restId: "1" as never,
        headSha,
        comments: [],
        // SAFETY: a plain login string already satisfies the branded author type's runtime shape.
        author: "fixture" as never,
        pr: identity,
        createdAt: at,
        updatedAt: at,
      },
    },
    directSummaryReview: {
      _tag: "Confirmed",
      receipt: {
        // SAFETY: a plain string already satisfies the branded review-id type's runtime shape.
        reviewId: "1" as never,
        event: "COMMENT",
        headSha,
        submittedAt: at,
      },
    },
    createdAt: at,
    updatedAt: at,
    // SAFETY: see the file-level note above `function session()`.
    localCheckoutWarning,
  } as never;
}
// SAFETY: this whole fixture is cast `as never` because it stands in for a
// `ReviewRemoteSnapshot` the service under test receives as an
// already-parsed argument; every field already matches its real runtime
// shape.
export const snapshotData = {
  schemaVersion: 1,
  pullRequest: {
    ref: identity,
    headSha,
    baseSha: headSha,
    title: "represented title",
    author: "author",
    headBranch: "feature",
    baseBranch: "sit",
    isDraft: false,
    isOpen: true,
    reviewState: "approved",
    mergeability: "mergeable",
    labels: [],
    updatedAt: at,
  },
  comments: { threads: [], complete: true },
  conversation: { prDescription: "represented description", entries: [] },
  commits: [
    {
      sha: headSha,
      message: "represented commit",
      author: "author",
      authoredAt: at,
      isHead: true,
    },
  ],
  checks: {
    overall: "passing",
    checks: [
      {
        name: "build",
        required: true,
        status: "completed",
        conclusion: "success",
      },
    ],
  },
  mergeEvidence: {
    mergeable: "mergeable",
    mergeStateStatus: "clean",
    reviewDecision: "approved",
  },
};
// SAFETY: see the file-level note above `const snapshotData`.
export const snapshot = snapshotData as never;
export function review(
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- each call site overrides a different, differently-shaped subset of the Review fixture below; the merged result is narrowed to `never` at the return, same as the base fixture fields it's merged with.
  overrides: Record<string, unknown> = {},
) {
  // SAFETY: this whole fixture is cast `as never` because it stands in for a
  // full, internal `Review` record the service under test never
  // re-validates (it is handed back verbatim by the mocked `reviews.load`);
  // every field already matches its real runtime shape.
  return {
    id: reviewId,
    identity,
    currentSessionId: sessionId,
    currentHeadSha: headSha,
    representedRemote: {
      headSha,
      pullRequestUpdatedAt: at,
      snapshotHash: hash,
      refreshedAt: at,
    },
    freshness: { _tag: "Fresh" },
    status: { _tag: "Open" },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as never;
}
export function fixture(
  stable = review(),
  localCheckoutWarning?: "missing_local_path" | "local_checkout_unavailable",
  patchPath?: string,
) {
  const profiles = { load: vi.fn(async () => ok({ ghAccount: "fixture" })) };
  const sessions = {
    load: vi.fn(async () => ok(session(localCheckoutWarning, patchPath))),
  };
  const reviews = { load: vi.fn(async () => ok(stable)) };
  const insights = {
    loadTyped: vi.fn(async () => err({ reason: "not_found" })),
  };
  return {
    // SAFETY: each mock below only stubs the one method this service
    // actually calls; casting to `never` stands in for the full repository
    // interface the constructor declares.
    service: new ReviewWorkbenchProjectionService(
      profiles as never,
      sessions as never,
      reviews as never,
      insights as never,
      paths,
    ),
    profiles,
    sessions,
    reviews,
    insights,
  };
}
