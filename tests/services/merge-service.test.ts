import { describe, expect, it, vi } from "vitest";

import type { CheckSummary } from "../../src/domain/github-context";
import { mergePullRequest } from "../../src/services/merge-service";

// SAFETY: This literal is a well-formed GitSha fixture for the merge service seam.
const sha = "abcdef1234567890abcdef1234567890abcdef12" as never;
// SAFETY: This fixture supplies the session fields exercised by mergePullRequest; unrelated stored fields are not needed by this behavior test.
const session = {
  id: "github.com__centraldigital__patchdesk__pr-1__sha-abcdef12__base-00000000__0123456789ab",
  key: {
    profileId: "cfw",
    host: "github.com",
    owner: "centraldigital",
    repo: "patchdesk",
    prNumber: 1,
    headSha: sha,
  },
  pr: { headSha: sha, baseSha: sha, isDraft: false, isOpen: true },
  patchPath: "/tmp/does-not-exist",
} as never;
// SAFETY: This fixture supplies the profile fields exercised by mergePullRequest.
const profile = { githubHost: "github.com", ghAccount: "fixture" } as never;
describe("merge service", () => {
  it("fails closed when complete revision proof is unavailable", async () => {
    const merge = async () => ({ _tag: "ok" as const, value: {} });
    await expect(
      mergePullRequest({
        profile,
        session,
        // SAFETY: This fake gateway implements the methods exercised by mergePullRequest; the test does not need the wider adapter surface.
        gateway: {
          getPullRequest: async () => ({
            _tag: "ok" as const,
            value: {
              ref: {
                host: "github.com",
                owner: "centraldigital",
                repo: "patchdesk",
                number: 1,
              },
              headSha: sha,
              baseSha: sha,
              changedFileCount: 1,
            },
          }),
          getPullRequestDiff: async () => ({ _tag: "ok" as const, value: "" }),
          getMergePolicy: async () => ({ _tag: "ok" as const, value: {} }),
          mergePullRequest: merge,
        } as never,
        method: "squash",
        supportedMethods: ["squash"],
        acknowledgedWarningCodes: [],
      }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: { _tag: "RevisionUnavailableBlocksMerge" },
    });
  });

  const passingChecks: CheckSummary = {
    overall: "passing",
    checks: [
      {
        name: "unit",
        required: true,
        status: "completed",
        conclusion: "success",
      },
    ],
  };
  // A pull request whose revision proof holds, so the readiness rules alone
  // decide the outcome. `changedFileCount: 0` matches the empty canonical
  // diff below, which is what makes the revision `Same`.
  function gateway(
    reviewDecision: "unknown" | "review_required" | "approved",
    merge: () => Promise<{ readonly _tag: "ok"; readonly value: object }>,
    checks: CheckSummary = passingChecks,
  ) {
    // SAFETY: this fake gateway implements the methods exercised by
    // mergePullRequest; the test does not need the wider adapter surface.
    return {
      getPullRequest: async () => ({
        _tag: "ok" as const,
        value: {
          ref: {
            host: "github.com",
            owner: "centraldigital",
            repo: "patchdesk",
            number: 1,
          },
          headSha: sha,
          baseSha: sha,
          changedFileCount: 0,
        },
      }),
      getPullRequestDiff: async () => ({ _tag: "ok" as const, value: "" }),
      getMergePolicy: async () => ({
        _tag: "ok" as const,
        value: {
          headSha: sha,
          baseSha: sha,
          isOpen: true,
          isDraft: false,
          mergeability: "mergeable",
          reviewDecision,
          checks,
          complete: true,
        },
      }),
      mergePullRequest: merge,
    } as never;
  }

  it("merges when GitHub reports no review decision and the checks pass", async () => {
    const merge = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    await expect(
      mergePullRequest({
        profile,
        session,
        gateway: gateway("unknown", merge),
        method: "squash",
        supportedMethods: ["squash"],
        acknowledgedWarningCodes: [],
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { readiness: { _tag: "Ready", blockers: [] } },
    });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  // A Finding already on the review is handled; the gate must not ask the
  // maintainer to acknowledge it again.
  it("does not ask to acknowledge a high-severity Finding already added to the review", async () => {
    const merge = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    await expect(
      mergePullRequest({
        profile,
        session,
        // SAFETY: a plain string already satisfies the branded FindingId's runtime shape.
        result: {
          findings: [
            { id: "finding-1" as never, severity: "P1", addedToReview: true },
          ],
        },
        gateway: gateway("unknown", merge),
        method: "squash",
        supportedMethods: ["squash"],
        acknowledgedWarningCodes: [],
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { readiness: { _tag: "Ready", blockers: [], warnings: [] } },
    });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("refuses the merge when GitHub requires a review", async () => {
    const merge = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    await expect(
      mergePullRequest({
        profile,
        session,
        gateway: gateway("review_required", merge),
        method: "squash",
        supportedMethods: ["squash"],
        acknowledgedWarningCodes: [],
      }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: {
        _tag: "MergeBlocked",
        readiness: { _tag: "Blocked", blockers: ["github_review"] },
      },
    });
    expect(merge).not.toHaveBeenCalled();
  });

  // A repository with no classic required-status-checks policy answers the
  // protection endpoint with 404, so `completeMergePolicy` marks every check
  // `required: false` and GitHub itself calls the pull request mergeable
  // (`unstable`). Per ADR 0027 that is a mergeable state, not a blocker: the
  // gate must not refuse a merge over a check nobody requires.
  it("merges when a check that GitHub does not require is failing", async () => {
    const merge = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    await expect(
      mergePullRequest({
        profile,
        session,
        gateway: gateway("approved", merge, {
          overall: "failing",
          checks: [
            {
              name: "optional-lint",
              required: false,
              status: "completed",
              conclusion: "failure",
            },
          ],
        }),
        method: "squash",
        supportedMethods: ["squash"],
        acknowledgedWarningCodes: [],
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { readiness: { _tag: "Ready", blockers: [] } },
    });
    expect(merge).toHaveBeenCalledTimes(1);
  });
});
