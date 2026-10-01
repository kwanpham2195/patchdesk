import { describe, expect, it, vi } from "vitest";

import { definedProps } from "../../src/domain/defined-props";
import type { MergeOutcome } from "../../src/adapters/github/github-ports";
import type {
  CheckSummary,
  MergeMethod,
} from "../../src/domain/github-context";
import type { GitHubWriteFailure } from "../../src/domain/github-write";
import type { RefusalCause } from "../../src/domain/github-write-refusal";
import { mergePullRequest } from "../../src/services/merge-service";

// SAFETY: This literal is a well-formed GitSha fixture for the merge service seam.
const sha = "abcdef1234567890abcdef1234567890abcdef12" as never;
// SAFETY: This fixture supplies the session fields exercised by mergePullRequest; unrelated stored fields are not needed by this behavior test.
const session = {
  id: "github.com__octo-org__patchdesk__pr-1__sha-abcdef12__base-00000000__0123456789ab",
  key: {
    profileId: "acme",
    host: "github.com",
    owner: "octo-org",
    repo: "patchdesk",
    source: { kind: "pull_request", prNumber: 1 },
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
                owner: "octo-org",
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
        acknowledgedWarningCodes: [],
        recordRefusal: async () => true,
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
    merge: () => Promise<
      | { readonly _tag: "ok"; readonly value: object }
      | { readonly _tag: "err"; readonly error: GitHubWriteFailure }
    >,
    checks: CheckSummary = passingChecks,
    repository: {
      readonly allowedMergeMethods?: ReadonlyArray<MergeMethod>;
      readonly outcome?: MergeOutcome;
      readonly onOutcomeRead?: () => void;
    } = {},
  ) {
    // SAFETY: this fake gateway implements the methods exercised by
    // mergePullRequest; the test does not need the wider adapter surface.
    return {
      getPullRequest: async () => ({
        _tag: "ok" as const,
        value: {
          ref: {
            host: "github.com",
            owner: "octo-org",
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
          ...definedProps({
            allowedMergeMethods: repository.allowedMergeMethods,
          }),
        },
      }),
      getMergeOutcome: async () => {
        repository.onOutcomeRead?.();
        return repository.outcome === undefined
          ? { _tag: "err" as const, error: { _tag: "GitHubReadFailed" } }
          : { _tag: "ok" as const, value: repository.outcome };
      },
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
        acknowledgedWarningCodes: [],
        recordRefusal: async () => true,
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
        acknowledgedWarningCodes: [],
        recordRefusal: async () => true,
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
        acknowledgedWarningCodes: [],
        recordRefusal: async () => true,
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
        acknowledgedWarningCodes: [],
        recordRefusal: async () => true,
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { readiness: { _tag: "Ready", blockers: [] } },
    });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("refuses a method the repository does not allow without asking GitHub to merge", async () => {
    const merge = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    await expect(
      mergePullRequest({
        profile,
        session,
        gateway: gateway("approved", merge, passingChecks, {
          allowedMergeMethods: ["rebase"],
        }),
        method: "squash",
        acknowledgedWarningCodes: [],
        recordRefusal: async () => true,
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "MergeMethodNotAllowed" },
    });
    expect(merge).not.toHaveBeenCalled();
  });

  // ADR 0046: a resent merge whose first delivery landed is refused too, so a
  // refusal proves nothing merged only while the pull request is still open.
  describe("a refused merge", () => {
    const refusal = (cause: RefusalCause) => ({
      _tag: "err" as const,
      error: {
        _tag: "GitHubWriteFailure" as const,
        category: "refused" as const,
        message: "GitHub refused the request.",
        cause,
      },
    });
    const merged = {
      state: "merged",
      // SAFETY: an ISO literal already satisfies the branded IsoTimestamp's runtime shape.
      mergedAt: "2026-10-01T00:00:00.000Z" as never,
    } as const;

    async function refused(input: {
      readonly cause: RefusalCause;
      readonly outcome?: MergeOutcome | undefined;
      readonly recorded?: boolean;
    }) {
      const getMergeOutcome = vi.fn();
      const recordRefusal = vi.fn(async () => input.recorded ?? true);
      const merge = vi.fn(async () => refusal(input.cause));
      const result = await mergePullRequest({
        profile,
        session,
        gateway: gateway("approved", merge, passingChecks, {
          onOutcomeRead: getMergeOutcome,
          ...definedProps({ outcome: input.outcome }),
        }),
        method: "squash",
        acknowledgedWarningCodes: [],
        recordRefusal,
      });
      return { result, getMergeOutcome, recordRefusal };
    }

    it.each(["not_found", "conflict", "not_allowed", "unprocessable"] as const)(
      "is final for %s while the pull request is open",
      async (cause) => {
        const { result, recordRefusal } = await refused({
          cause,
          outcome: { state: "open" },
        });
        expect(result).toEqual({
          _tag: "err",
          error: { _tag: "GitHubMergeRefused", cause },
        });
        expect(recordRefusal).toHaveBeenCalledWith(cause);
      },
    );

    it.each([
      { name: "merged", outcome: merged },
      { name: "unreadable", outcome: undefined },
    ])(
      "stays outcome unknown when the pull request is $name",
      async ({ outcome }) => {
        const { result, recordRefusal } = await refused({
          cause: "conflict",
          ...definedProps({ outcome }),
        });
        expect(result).toEqual({
          _tag: "err",
          error: { _tag: "GitHubMergeOutcomeUnknown" },
        });
        expect(recordRefusal).not.toHaveBeenCalled();
      },
    );

    it("stays outcome unknown when the rejection cannot be recorded", async () => {
      const { result } = await refused({
        cause: "not_found",
        outcome: { state: "open" },
        recorded: false,
      });
      expect(result).toEqual({
        _tag: "err",
        error: { _tag: "GitHubMergeOutcomeUnknown" },
      });
    });

    it("is final for an unsupported endpoint without reading the pull request", async () => {
      const { result, getMergeOutcome } = await refused({
        cause: "unsupported",
      });
      expect(result).toEqual({
        _tag: "err",
        error: { _tag: "GitHubMergeRefused", cause: "unsupported" },
      });
      expect(getMergeOutcome).not.toHaveBeenCalled();
    });
  });

  // ADR 0046 accepts the rate-limit case: a read under the same limit would
  // usually fail too and would lock every real rate limit.
  it("is final for a rate limit without reading the pull request", async () => {
    const getMergeOutcome = vi.fn();
    const merge = async () => ({
      _tag: "err" as const,
      error: {
        _tag: "GitHubWriteFailure" as const,
        category: "rate_limited" as const,
        message: "GitHub rate-limited this request.",
      },
    });
    await expect(
      mergePullRequest({
        profile,
        session,
        gateway: gateway("approved", merge, passingChecks, {
          outcome: { state: "open" },
          onOutcomeRead: getMergeOutcome,
        }),
        method: "squash",
        acknowledgedWarningCodes: [],
        recordRefusal: async () => true,
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "GitHubMergeRateLimited" },
    });
    expect(getMergeOutcome).not.toHaveBeenCalled();
  });
});
