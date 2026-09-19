import { describe, expect, it } from "vitest";

import { normalizeCommandLabel } from "../../src/adapters/github/command-runner";
import * as queries from "../../src/adapters/github/github-graphql-queries";
import { ghInvocationFor } from "../../src/adapters/github/github-request";
import { isQueryDocument } from "../../src/adapters/github/transport-shadow";

/**
 * Every GraphQL document this adapter sends, the label it spawns under, and
 * whether the routing reads it as a query or as a mutation (issue #276, step
 * T2). A document is served over HTTPS only when it is a query and its label
 * is allowlisted, so both answers decide a transport, and two documents
 * sharing a label would share the allowlist entry and move together.
 */

type DocumentCase = {
  /** The export in `github-graphql-queries.ts` this document comes from. */
  readonly name: string;
  readonly document: string;
  readonly label: string;
  readonly isQuery: boolean;
};

const cases: ReadonlyArray<DocumentCase> = [
  {
    name: "threadQuery",
    document: queries.threadQuery,
    label: "api graphql PullRequestThreads",
    isQuery: true,
  },
  {
    name: "confirmCreatedCommentThreadQuery",
    document: queries.confirmCreatedCommentThreadQuery,
    label: "api graphql ConfirmCreatedCommentThread",
    isQuery: true,
  },
  {
    name: "pendingReviewThreadsQuery",
    document: queries.pendingReviewThreadsQuery,
    label: "api graphql PendingReviewThreads",
    isQuery: true,
  },
  {
    name: "threadCommentsQuery",
    document: queries.threadCommentsQuery,
    label: "api graphql ReviewThreadComments",
    isQuery: true,
  },
  {
    name: "reviewThreadTargetQuery",
    document: queries.reviewThreadTargetQuery,
    label: "api graphql ReviewThreadTarget",
    isQuery: true,
  },
  {
    name: "reviewCommentTargetQuery",
    document: queries.reviewCommentTargetQuery,
    label: "api graphql ReviewCommentTarget",
    isQuery: true,
  },
  {
    name: "maintainerInboxQuery",
    document: queries.maintainerInboxQuery,
    label: "api graphql MaintainerInbox",
    isQuery: true,
  },
  {
    name: "maintainerInboxSearchQuery",
    document: queries.maintainerInboxSearchQuery,
    label: "api graphql MaintainerInboxSearch",
    isQuery: true,
  },
  {
    name: "repositoryLabelsQuery",
    document: queries.repositoryLabelsQuery,
    label: "api graphql RepositoryLabels",
    isQuery: true,
  },
  {
    name: "assignableUsersQuery",
    document: queries.assignableUsersQuery,
    label: "api graphql AssignableUsers",
    isQuery: true,
  },
  {
    name: "pullRequestReviewersQuery",
    document: queries.pullRequestReviewersQuery,
    label: "api graphql PullRequestReviewers",
    isQuery: true,
  },
  {
    name: "repositoryBranchesQuery",
    document: queries.repositoryBranchesQuery,
    label: "api graphql RepositoryBranches",
    isQuery: true,
  },
  {
    name: "mergePolicyQuery",
    document: queries.mergePolicyQuery,
    label: "api graphql MergePolicy",
    isQuery: true,
  },
  {
    name: "watchedPullRequestsQuery",
    document: queries.watchedPullRequestsQuery(2),
    label: "api graphql WatchedPullRequests",
    isQuery: true,
  },
  // Every mutation below is an anonymous document, so its label is the root
  // field gh's label rule falls back to rather than an operation name.
  {
    name: "addLabelsToLabelableMutation",
    document: queries.addLabelsToLabelableMutation,
    label: "api graphql addLabelsToLabelable",
    isQuery: false,
  },
  {
    name: "removeLabelsFromLabelableMutation",
    document: queries.removeLabelsFromLabelableMutation,
    label: "api graphql removeLabelsFromLabelable",
    isQuery: false,
  },
  {
    name: "addAssigneesToAssignableMutation",
    document: queries.addAssigneesToAssignableMutation,
    label: "api graphql addAssigneesToAssignable",
    isQuery: false,
  },
  {
    name: "removeAssigneesFromAssignableMutation",
    document: queries.removeAssigneesFromAssignableMutation,
    label: "api graphql removeAssigneesFromAssignable",
    isQuery: false,
  },
  {
    name: "requestReviewsMutation",
    document: queries.requestReviewsMutation,
    label: "api graphql requestReviews",
    isQuery: false,
  },
  {
    name: "updatePullRequestBaseBranchMutation",
    document: queries.updatePullRequestBaseBranchMutation,
    label: "api graphql updatePullRequest",
    isQuery: false,
  },
  {
    name: "markPullRequestReadyForReviewMutation",
    document: queries.markPullRequestReadyForReviewMutation,
    label: "api graphql markPullRequestReadyForReview",
    isQuery: false,
  },
  {
    name: "convertPullRequestToDraftMutation",
    document: queries.convertPullRequestToDraftMutation,
    label: "api graphql convertPullRequestToDraft",
    isQuery: false,
  },
  {
    name: "addPendingReviewThreadMutation",
    document: queries.addPendingReviewThreadMutation("RIGHT"),
    label: "api graphql addPullRequestReviewThread",
    isQuery: false,
  },
  {
    name: "addThreadReplyMutation",
    document: queries.addThreadReplyMutation,
    label: "api graphql addPullRequestReviewThreadReply",
    isQuery: false,
  },
  {
    name: "reviewThreadStateMutation",
    document: queries.reviewThreadStateMutation("resolved"),
    label: "api graphql resolveReviewThread",
    isQuery: false,
  },
  {
    name: "updateThreadCommentMutation",
    document: queries.updateThreadCommentMutation,
    label: "api graphql updatePullRequestReviewComment",
    isQuery: false,
  },
  {
    name: "deleteThreadCommentMutation",
    document: queries.deleteThreadCommentMutation,
    label: "api graphql deletePullRequestReviewComment",
    isQuery: false,
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
  it.each(cases)("$name spawns under $label", ({ document, label }) => {
    expect(labelFor(document)).toBe(label);
  });

  it.each(cases)(
    "$name is read as a query: $isQuery",
    ({ document, isQuery }) => {
      expect(isQueryDocument(document)).toBe(isQuery);
    },
  );

  it("gives each document a label of its own, so no two share an allowlist entry", () => {
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
