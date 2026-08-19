import { describe, expect, it, vi } from "vitest";

import { createReviewId } from "../../src/domain/ids";
import { err, ok } from "../../src/domain/result";
import { ReviewWorkbenchProjectionService } from "../../src/services/review-workbench-projection";

// SAFETY: `as never` casts throughout this file bypass branded-primitive
// construction for test-only fixture literals; the brands only exist for
// compile-time cross-boundary safety, and every cast value already
// satisfies its branded type's runtime shape.
const profileId = "cfw" as never;
// SAFETY: a 40-char hex string already satisfies GitSha's runtime shape.
const headSha = "a".repeat(40) as never;
// SAFETY: a plain ISO-8601 string already satisfies IsoTimestamp's runtime shape.
const at = "2026-08-09T11:35:00.000Z" as never;
// SAFETY: a composite `host__owner__repo__pr-N__sha-...__hash` string already satisfies SessionId's runtime shape.
const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__b48f8e2e76ca" as never;
const identity = {
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
const reviewId = createReviewId(identity);
// SAFETY: a 64-char hex string already satisfies ContentHash's runtime shape.
const hash = "b".repeat(64) as never;
function session() {
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
    patchPath: "/does-not-exist" as never,
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
  } as never;
}
// SAFETY: this whole fixture is cast `as never` because it stands in for a
// `ReviewRemoteSnapshot` the service under test receives as an
// already-parsed argument; every field already matches its real runtime
// shape.
const snapshotData = {
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
const snapshot = snapshotData as never;
function review(
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
function fixture(stable = review()) {
  const profiles = { load: vi.fn(async () => ok({ ghAccount: "fixture" })) };
  const sessions = { load: vi.fn(async () => ok(session())) };
  const reviews = { load: vi.fn(async () => ok(stable)) };
  const insights = {
    loadTyped: vi.fn(async () => err({ reason: "not_found" })),
    load: vi.fn(async () => err({ reason: "not_found" })),
  };
  return {
    // SAFETY: each mock below only stubs the one method
    // (`load`/`loadTyped`) this service actually calls; casting to `never`
    // stands in for the full repository interface the constructor declares.
    service: new ReviewWorkbenchProjectionService(
      profiles as never,
      sessions as never,
      reviews as never,
      insights as never,
    ),
    profiles,
    sessions,
    reviews,
    insights,
  };
}

describe("ReviewWorkbenchProjectionService", () => {
  it("projects only the represented Review snapshot and performs no GitHub reads", async () => {
    const value = fixture();
    await expect(
      value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        review: { id: reviewId, status: "open" },
        revision: {
          freshness: "fresh",
          refreshedAt: at,
          reviewedHeadSha: headSha,
        },
        pullRequest: { title: "represented title" },
        commits: [{ message: "represented commit" }],
        checks: { overall: "passing" },
        conversation: { prDescription: "represented description" },
        pendingReview: { state: "pending" },
        directSummary: { state: "confirmed" },
      },
    });
    expect(value.profiles.load).toHaveBeenCalledOnce();
    expect(value.sessions.load).toHaveBeenCalledOnce();
    expect(value.reviews.load).toHaveBeenCalledOnce();
  });

  it("carries real {name,color} labels through to the renderer-facing pull request shape", async () => {
    const value = fixture();
    // SAFETY: same shape as `snapshotData` above, only `pullRequest.labels` differs.
    const labeledSnapshot = {
      ...snapshotData,
      pullRequest: {
        ...snapshotData.pullRequest,
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "enhancement", color: "a2eeef" },
        ],
      },
    } as never;
    await expect(
      value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: labeledSnapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        pullRequest: {
          labels: [
            { name: "bug", color: "d73a4a" },
            { name: "enhancement", color: "a2eeef" },
          ],
        },
      },
    });
  });

  it("projects represented freshness, analysis and walkthrough defaults, and merge evidence", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: {
        _tag: "RevisionChanged",
        detectedAt: at,
        identity: { headSha, baseSha: headSha, canonicalPatchHash: hash },
      },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        revision: { freshness: "updates_available" },
        insights: {
          analysis: { status: "not_generated" },
          walkthrough: { status: "not_generated" },
        },
        mergeReadiness: { _tag: "Ready" },
        mergeReasons: [],
      },
    });
  });

  it("ignores a corrupt Insight record and projects the Review as not generated", async () => {
    const value = fixture();
    value.insights.loadTyped.mockResolvedValueOnce(
      // SAFETY: only the `reason` discriminant this service branches on is
      // set; casting to `never` stands in for the full StorageFailure shape.
      err({ reason: "invalid_stored_value" } as never),
    );
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        insights: {
          analysis: { status: "not_generated" },
          walkthrough: { status: "not_generated" },
        },
      },
    });
  });

  it("fails closed when the Review authority is missing or bound to another Session", async () => {
    const absent = fixture();
    absent.reviews.load.mockResolvedValueOnce(
      // SAFETY: only the `reason` discriminant this service branches on is
      // set; casting to `never` stands in for the full StorageFailure shape.
      err({ reason: "not_found" } as never),
    );
    await expect(
      absent.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toEqual({ _tag: "err", error: { _tag: "ReviewNotFound" } });
    const mismatched = fixture(review({ currentSessionId: "other-session" }));
    await expect(
      mismatched.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "SessionStorageUnavailable" },
    });
  });

  describe("deriveMergeReasons (via loadRepresented's mergeEvidence)", () => {
    // SAFETY: this test helper builds a `ReviewRemoteSnapshot`-shaped
    // fixture with a custom `mergeEvidence`; cast `as never` for the same
    // reason as `snapshotData` above.
    function snapshotWithMergeEvidence(
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- test-only fixture builder; the resulting object is cast `as never` below, the same boundary `snapshotData` itself uses.
      mergeEvidence: unknown,
    ) {
      // SAFETY: see the file-level note above `const snapshotData`; this
      // helper only swaps in a caller-supplied `mergeEvidence` fixture.
      return { ...snapshotData, mergeEvidence } as never;
    }

    it("prefers a ruleset-sourced approval count, marking it available instead of partial", async () => {
      const value = fixture();
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "mergeable",
          mergeStateStatus: "clean",
          reviewDecision: "review_required",
          policy: {
            branchProtection: { state: "unavailable", reason: "not_found" },
            appliedRuleset: {
              state: "available",
              value: {
                rules: [
                  {
                    type: "pull_request",
                    pullRequestParameters: { requiredApprovingReviewCount: 2 },
                  },
                ],
              },
            },
          },
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          mergeReasons: [
            {
              code: "review_required",
              message: "2 approving reviews required by ruleset configuration.",
              source: "ruleset_configuration",
              availability: "available",
              openOnGitHub: false,
            },
          ],
        },
      });
    });

    it("still uses classic branch protection when no ruleset count is available", async () => {
      const value = fixture();
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "mergeable",
          mergeStateStatus: "clean",
          reviewDecision: "review_required",
          policy: {
            branchProtection: {
              state: "available",
              value: { requiredApprovingReviewCount: 1 },
            },
            appliedRuleset: { state: "unavailable", reason: "not_found" },
          },
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          mergeReasons: [
            {
              code: "review_required",
              message: "1 approving review required by branch protection.",
              source: "branch_protection",
              availability: "available",
              openOnGitHub: false,
            },
          ],
        },
      });
    });

    it("names requireLastPushApproval and requiredReviewThreadResolution as separate reasons when GitHub reports blocked, and skips the generic fallback", async () => {
      const value = fixture();
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "blocked",
          mergeStateStatus: "blocked",
          reviewDecision: "approved",
          policy: {
            branchProtection: { state: "unavailable", reason: "not_found" },
            appliedRuleset: {
              state: "available",
              value: {
                rules: [
                  {
                    type: "pull_request",
                    pullRequestParameters: {
                      requireLastPushApproval: true,
                      requiredReviewThreadResolution: true,
                    },
                  },
                ],
              },
            },
          },
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          mergeReasons: [
            {
              code: "review_required",
              message:
                "New changes require approval from someone other than the last pusher.",
              source: "ruleset_configuration",
              availability: "available",
            },
            {
              code: "blocked",
              message:
                "All review threads must be resolved before this can merge.",
              source: "ruleset_configuration",
              availability: "available",
            },
          ],
        },
      });
      const reasons =
        result._tag === "ok" ? result.value.mergeReasons : undefined;
      expect(reasons).toHaveLength(2);
      expect(
        reasons?.some((reason) =>
          reason.message.includes("merge requirements are not satisfied"),
        ),
      ).toBe(false);
    });

    it("reports failing checks and an outstanding review requirement together", async () => {
      const value = fixture();
      // SAFETY: see the file-level note above `const snapshotData`; this
      // inline fixture only overrides `checks` and `mergeEvidence`.
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: {
          ...snapshotData,
          checks: { overall: "failing", checks: [] },
          mergeEvidence: {
            mergeable: "mergeable",
            mergeStateStatus: "clean",
            reviewDecision: "review_required",
          },
          // SAFETY: see the file-level note above `const snapshotData`.
        } as never,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      const reasons =
        result._tag === "ok" ? result.value.mergeReasons : undefined;
      expect(reasons).toHaveLength(2);
      expect(reasons).toContainEqual(
        expect.objectContaining({ code: "review_required" }),
      );
      expect(reasons).toContainEqual(
        expect.objectContaining({ code: "checks" }),
      );
    });

    it("treats has_hooks and unstable as mergeable, producing no blocker reason", async () => {
      // Per GitHub's own `MergeStateStatus` semantics, HAS_HOOKS ("Mergeable
      // with passing commit status and pre-receive hooks") and UNSTABLE
      // ("Mergeable with non-passing commit status") both describe a
      // mergeable PR, not a blocked one, so neither should ever produce a
      // `mergeReasons` entry.
      const value = fixture();
      const hasHooks = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "mergeable",
          mergeStateStatus: "has_hooks",
          reviewDecision: "approved",
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(hasHooks).toMatchObject({
        _tag: "ok",
        value: { mergeReasons: [] },
      });

      const unstable = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "mergeable",
          mergeStateStatus: "unstable",
          reviewDecision: "approved",
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(unstable).toMatchObject({
        _tag: "ok",
        value: { mergeReasons: [] },
      });
    });

    it("does not assert unsatisfied requirements when no policy evidence is readable at all", async () => {
      const value = fixture();
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "blocked",
          mergeStateStatus: "blocked",
          reviewDecision: "approved",
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          mergeReasons: [
            {
              code: "blocked",
              source: "github_pr_state",
              availability: "partial",
              openOnGitHub: true,
            },
          ],
        },
      });
      const reasons =
        result._tag === "ok" ? result.value.mergeReasons : undefined;
      expect(reasons?.[0]?.message).not.toMatch(
        /requirements are not satisfied/,
      );
      expect(reasons?.[0]?.message).toMatch(/could not read/i);
    });
  });

  it("never falls back to session-only context when the represented snapshot is complete", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Unavailable", detectedAt: at, reason: "github_read" },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        pullRequest: { title: "represented title" },
        conversation: { prDescription: "represented description" },
        revision: { freshness: "unavailable" },
      },
    });
  });
});
