import type { BranchProtectionRead } from "../../src/adapters/github/github-merge-policy";
import type { PullRequestReviewsRead } from "../../src/adapters/github/github-pull-request-reviews";
import type { ReviewRemoteSnapshot } from "../../src/adapters/storage/review-remote-store";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";

export const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "err") throw new Error("fixture");
  return result.value;
};
export const profileId = must(parseWorkspaceProfileId("cfw"));
export const identity = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
};
export const headSha = must(parseGitSha("1".repeat(40)));
export const baseSha = must(parseGitSha("0".repeat(40)));
export const otherSha = must(parseGitSha("2".repeat(40)));
export const observedAt = must(parseIsoTimestamp("2026-08-12T00:01:00.000Z"));
export const patch = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

export function snapshot(input: {
  readonly title: string;
  readonly conversation?: ReviewRemoteSnapshot["conversation"];
}): ReviewRemoteSnapshot {
  return {
    schemaVersion: 1,
    pullRequest: {
      ref: {
        host: identity.host,
        owner: identity.owner,
        repo: identity.repo,
        number: identity.prNumber,
      },
      headSha,
      baseSha,
      isDraft: false,
      isOpen: true,
      title: input.title,
      author: "fixture",
      headBranch: "feature",
      baseBranch: "main",
      reviewState: "none",
      mergeability: "mergeable",
      labels: [],
      changedFileCount: 1,
      updatedAt: observedAt,
    },
    comments: { threads: [], complete: true },
    commits: [],
    checks: { overall: "passing", checks: [] },
    conversation: input.conversation ?? { prDescription: "", entries: [] },
  };
}

export function fakeGitHub(input: { readonly terminal: boolean }) {
  const current = {
    ...snapshot({ title: "new" }).pullRequest,
    isOpen: !input.terminal,
    // The observation assembles the Conversation from this read, so the
    // description it carries is the one the stored snapshot must show.
    description: "current description",
  };
  return {
    async getPullRequest() {
      return ok(current);
    },
    async getPullRequestDiff() {
      return ok(patch);
    },
    async getPullRequestComments() {
      return ok({ threads: [], complete: true });
    },
    async getPullRequestChecks() {
      return ok({ overall: "passing" as const, checks: [] });
    },
    async getMergePolicy() {
      return ok({
        pr: current.ref,
        headSha,
        isOpen: !input.terminal,
        isDraft: false,
        mergeability: "mergeable" as const,
        reviewDecision: "approved" as const,
        checks: { overall: "passing" as const, checks: [] },
        complete: true,
      });
    },
    async resolveAuthenticatedAccount() {
      return ok({ host: identity.host, account: "fixture" });
    },
    async getViewerPendingReview() {
      return ok({ _tag: "None" as const });
    },
    async getPullRequestPublishedFeedback() {
      return ok({
        reviews: [],
        comments: [],
        issueComments: [],
        complete: true,
      });
    },
    async getMergeOutcome() {
      return ok(
        input.terminal
          ? { state: "closed_unmerged" as const }
          : { state: "open" as const },
      );
    },
  };
}

/**
 * Wraps `fakeGitHub` with call counters on `getPullRequest` and
 * `getPullRequestDiff`, so tests can assert how many round trips one
 * observation makes without depending on internal call ordering.
 */
export function countingGitHub(input: { readonly terminal: boolean }) {
  const base = fakeGitHub(input);
  const counts = { getPullRequest: 0, getPullRequestDiff: 0 };
  return {
    github: {
      ...base,
      async getPullRequest(...args: Parameters<typeof base.getPullRequest>) {
        counts.getPullRequest += 1;
        return base.getPullRequest(...args);
      },
      async getPullRequestDiff(
        ...args: Parameters<typeof base.getPullRequestDiff>
      ) {
        counts.getPullRequestDiff += 1;
        return base.getPullRequestDiff(...args);
      },
    },
    counts,
  };
}

/** The value each consumer of a shared read was handed, or `undefined` when it was handed none. */
type ConsumedSharedReads = {
  publishedFeedbackBranchProtection: BranchProtectionRead | undefined;
  publishedFeedbackReviews: PullRequestReviewsRead | undefined;
  mergeEvidenceBranchProtection: BranchProtectionRead | undefined;
  pendingReviewReviews: PullRequestReviewsRead | undefined;
};

/**
 * Wraps `fakeGitHub` with the two reads a cycle is meant to start once, and
 * records the value each of their consumers was handed. The recorded values
 * are compared by identity, so a consumer that started its own read shows up
 * as a different object rather than an equal one.
 */
export function sharedReadGitHub() {
  const base = fakeGitHub({ terminal: false });
  const shared = {
    branchProtection: {
      dismissal: ok({ protected: true, allowedDismissers: [] }),
      evidence: ok({
        state: "available" as const,
        value: { requiredApprovingReviewCount: 1 },
      }),
    } satisfies BranchProtectionRead,
    reviews: { _tag: "Reviews", reviews: [] } satisfies PullRequestReviewsRead,
  };
  const counts = { readBranchProtection: 0, readPullRequestReviews: 0 };
  const received: ConsumedSharedReads = {
    publishedFeedbackBranchProtection: undefined,
    publishedFeedbackReviews: undefined,
    mergeEvidenceBranchProtection: undefined,
    pendingReviewReviews: undefined,
  };
  return {
    shared,
    counts,
    received,
    github: {
      ...base,
      async readBranchProtection() {
        counts.readBranchProtection += 1;
        return shared.branchProtection;
      },
      async readPullRequestReviews() {
        counts.readPullRequestReviews += 1;
        return shared.reviews;
      },
      async getPullRequestPublishedFeedback(input: {
        readonly branchProtection?: BranchProtectionRead;
        readonly reviews?: PullRequestReviewsRead;
      }) {
        received.publishedFeedbackBranchProtection = input.branchProtection;
        received.publishedFeedbackReviews = input.reviews;
        return base.getPullRequestPublishedFeedback();
      },
      async getMergePolicyEvidence(input: {
        readonly branchProtection?: BranchProtectionRead;
      }) {
        received.mergeEvidenceBranchProtection = input.branchProtection;
        return ok({
          branchProtection: {
            state: "available" as const,
            value: { requiredApprovingReviewCount: 1 },
          },
          appliedRuleset: {
            state: "unavailable" as const,
            reason: "not_found" as const,
          },
        });
      },
      async getViewerPendingReview(input: {
        readonly reviews?: PullRequestReviewsRead;
      }) {
        received.pendingReviewReviews = input.reviews;
        return base.getViewerPendingReview();
      },
    },
  };
}

/**
 * Like `fakeGitHub`, but reports the represented session's own headSha for
 * the first `getPullRequest` call (the terminal-state read, which the first
 * identity proof now reuses), then reports a changed headSha from the second
 * call onward — simulating a push landing in the gap between the first
 * identity read and the cheap second-check recheck.
 */
export function fakeGitHubChangedMidObservation(input: {
  readonly terminal: boolean;
}) {
  const base = fakeGitHub(input);
  const counts = { getPullRequest: 0, getPullRequestDiff: 0 };
  return {
    github: {
      ...base,
      async getPullRequest(...args: Parameters<typeof base.getPullRequest>) {
        counts.getPullRequest += 1;
        const result = await base.getPullRequest(...args);
        if (result._tag === "err" || counts.getPullRequest <= 1) return result;
        return ok({ ...result.value, headSha: otherSha });
      },
      async getPullRequestDiff(
        ...args: Parameters<typeof base.getPullRequestDiff>
      ) {
        counts.getPullRequestDiff += 1;
        return base.getPullRequestDiff(...args);
      },
    },
    counts,
  };
}
