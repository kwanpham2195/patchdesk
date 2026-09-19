import { describe, expect, it } from "vitest";

import { normalizeCommandLabel } from "../../src/adapters/github/command-runner";
import * as queries from "../../src/adapters/github/github-graphql-queries";
import { ghInvocationFor } from "../../src/adapters/github/github-request";

/**
 * Every GraphQL document this adapter sends and the label its request is
 * logged and counted under (issue #276). Two documents sharing a label would
 * be indistinguishable in `scripts/gh-spawn-report.mjs`.
 */

type DocumentCase = {
  /** The export in `github-graphql-queries.ts` this document comes from. */
  readonly name: string;
  readonly document: string;
  readonly label: string;
};

const cases: ReadonlyArray<DocumentCase> = [
  {
    name: "threadQuery",
    document: queries.threadQuery,
    label: "api graphql PullRequestThreads",
  },
  {
    name: "confirmCreatedCommentThreadQuery",
    document: queries.confirmCreatedCommentThreadQuery,
    label: "api graphql ConfirmCreatedCommentThread",
  },
  {
    name: "pendingReviewThreadsQuery",
    document: queries.pendingReviewThreadsQuery,
    label: "api graphql PendingReviewThreads",
  },
  {
    name: "threadCommentsQuery",
    document: queries.threadCommentsQuery,
    label: "api graphql ReviewThreadComments",
  },
  {
    name: "reviewThreadTargetQuery",
    document: queries.reviewThreadTargetQuery,
    label: "api graphql ReviewThreadTarget",
  },
  {
    name: "reviewCommentTargetQuery",
    document: queries.reviewCommentTargetQuery,
    label: "api graphql ReviewCommentTarget",
  },
  {
    name: "maintainerInboxQuery",
    document: queries.maintainerInboxQuery,
    label: "api graphql MaintainerInbox",
  },
  {
    name: "maintainerInboxSearchQuery",
    document: queries.maintainerInboxSearchQuery,
    label: "api graphql MaintainerInboxSearch",
  },
  {
    name: "repositoryLabelsQuery",
    document: queries.repositoryLabelsQuery,
    label: "api graphql RepositoryLabels",
  },
  {
    name: "assignableUsersQuery",
    document: queries.assignableUsersQuery,
    label: "api graphql AssignableUsers",
  },
  {
    name: "pullRequestReviewersQuery",
    document: queries.pullRequestReviewersQuery,
    label: "api graphql PullRequestReviewers",
  },
  {
    name: "repositoryBranchesQuery",
    document: queries.repositoryBranchesQuery,
    label: "api graphql RepositoryBranches",
  },
  {
    name: "mergePolicyQuery",
    document: queries.mergePolicyQuery,
    label: "api graphql MergePolicy",
  },
  {
    name: "watchedPullRequestsQuery",
    document: queries.watchedPullRequestsQuery(2),
    label: "api graphql WatchedPullRequests",
  },
  // Every mutation below is an anonymous document, so its label is the root
  // field gh's label rule falls back to rather than an operation name.
  {
    name: "addLabelsToLabelableMutation",
    document: queries.addLabelsToLabelableMutation,
    label: "api graphql addLabelsToLabelable",
  },
  {
    name: "removeLabelsFromLabelableMutation",
    document: queries.removeLabelsFromLabelableMutation,
    label: "api graphql removeLabelsFromLabelable",
  },
  {
    name: "addAssigneesToAssignableMutation",
    document: queries.addAssigneesToAssignableMutation,
    label: "api graphql addAssigneesToAssignable",
  },
  {
    name: "removeAssigneesFromAssignableMutation",
    document: queries.removeAssigneesFromAssignableMutation,
    label: "api graphql removeAssigneesFromAssignable",
  },
  {
    name: "requestReviewsMutation",
    document: queries.requestReviewsMutation,
    label: "api graphql requestReviews",
  },
  {
    name: "updatePullRequestBaseBranchMutation",
    document: queries.updatePullRequestBaseBranchMutation,
    label: "api graphql updatePullRequest",
  },
  {
    name: "markPullRequestReadyForReviewMutation",
    document: queries.markPullRequestReadyForReviewMutation,
    label: "api graphql markPullRequestReadyForReview",
  },
  {
    name: "convertPullRequestToDraftMutation",
    document: queries.convertPullRequestToDraftMutation,
    label: "api graphql convertPullRequestToDraft",
  },
  {
    name: "addPendingReviewThreadMutation",
    document: queries.addPendingReviewThreadMutation("RIGHT"),
    label: "api graphql addPullRequestReviewThread",
  },
  {
    name: "addThreadReplyMutation",
    document: queries.addThreadReplyMutation,
    label: "api graphql addPullRequestReviewThreadReply",
  },
  {
    name: "reviewThreadStateMutation",
    document: queries.reviewThreadStateMutation("resolved"),
    label: "api graphql resolveReviewThread",
  },
  {
    name: "updateThreadCommentMutation",
    document: queries.updateThreadCommentMutation,
    label: "api graphql updatePullRequestReviewComment",
  },
  {
    name: "deleteThreadCommentMutation",
    document: queries.deleteThreadCommentMutation,
    label: "api graphql deletePullRequestReviewComment",
  },
];

function labelFor(document: string): string {
  return normalizeCommandLabel(
    ghInvocationFor({
      kind: "graphql",
      host: "github.com",
      document,
      variables: [],
    }).argv,
  );
}

describe("every GraphQL document this adapter sends", () => {
  it.each(cases)("$name is logged under $label", ({ document, label }) => {
    expect(labelFor(document)).toBe(label);
  });

  it("gives each document a label of its own, so no two are counted as one", () => {
    const labels = cases.map((entry) => entry.label);

    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names every document the adapter holds, so a new one has to be classified here", () => {
    // Documents are the exports named for what they are; the rest of the
    // module is page and entry caps.
    const documentExports = Object.keys(queries)
      .filter((name) => name.endsWith("Query") || name.endsWith("Mutation"))
      .sort();

    expect(cases.map((entry) => entry.name).sort()).toEqual(documentExports);
  });
});
