import {
  addAssigneesToAssignableMutation,
  addLabelsToLabelableMutation,
  addPendingReviewThreadMutation,
  addThreadReplyMutation,
  convertPullRequestToDraftMutation,
  deleteThreadCommentMutation,
  markPullRequestReadyForReviewMutation,
  removeAssigneesFromAssignableMutation,
  removeLabelsFromLabelableMutation,
  requestReviewsMutation,
  reviewThreadStateMutation,
  updatePullRequestBaseBranchMutation,
  updateThreadCommentMutation,
} from "../../src/adapters/github/github-graphql-queries";
import type { GitHubRequest } from "../../src/adapters/github/github-request";

/**
 * Every write request the GitHub adapter can send, one row per label, written
 * the way its call site writes it (issue #276). This is the inventory ADR
 * 0046's Cutover record lists: the runner suite asserts each row reaches the
 * transport under the label named here, and the request-shape suites drive the
 * real adapter methods that produce these.
 *
 * Three call sites share the `POST .../pulls/:n/reviews` row —
 * `createPendingReview`, `startPendingReviewWithThread`, and
 * `createDirectSummaryReview` — because one label covers all three. The bodies
 * differ, and each is asserted in its own request-shape test.
 */
export type WriteInventoryEntry = {
  readonly name: string;
  /** The label the write routing matches, named by the method GitHub receives. */
  readonly label: string;
  readonly request: GitHubRequest;
};

const owner = "octo-org";
const repo = "patchdesk";
const reviewId = "9001";
const commentId = "2412345678";

export function writeRequests(): ReadonlyArray<WriteInventoryEntry> {
  return [...restWrites(), ...mutationWrites()];
}

function restWrites(): ReadonlyArray<WriteInventoryEntry> {
  return [
    {
      name: "create a review",
      label: "api POST repos/:owner/:repo/pulls/:n/reviews",
      request: {
        kind: "rest",
        host: "github.com",
        method: "POST",
        path: `repos/${owner}/${repo}/pulls/42/reviews`,
        jsonBody: '{"commit_id":"a","body":"","comments":[]}',
      },
    },
    {
      name: "submit a pending review",
      label: "api POST repos/:owner/:repo/pulls/:n/reviews/:n/events",
      request: {
        kind: "rest",
        host: "github.com",
        method: "POST",
        path: `repos/${owner}/${repo}/pulls/42/reviews/${reviewId}/events`,
        jsonBody: '{"event":"COMMENT","body":"summary"}',
      },
    },
    {
      name: "dismiss a review",
      label: "api PUT repos/:owner/:repo/pulls/:n/reviews/:n/dismissals",
      request: {
        kind: "rest",
        host: "github.com",
        method: "PUT",
        path: `repos/${owner}/${repo}/pulls/42/reviews/${reviewId}/dismissals`,
        jsonBody: '{"message":"stale"}',
      },
    },
    {
      name: "discard a pending review",
      label: "api DELETE repos/:owner/:repo/pulls/:n/reviews/:n",
      request: {
        kind: "rest",
        host: "github.com",
        method: "DELETE",
        path: `repos/${owner}/${repo}/pulls/42/reviews/${reviewId}`,
      },
    },
    {
      name: "merge a pull request",
      label: "api PUT repos/:owner/:repo/pulls/:n/merge",
      request: {
        kind: "rest",
        host: "github.com",
        method: "PUT",
        path: `repos/${owner}/${repo}/pulls/42/merge`,
        jsonBody: '{"sha":"a","merge_method":"squash"}',
      },
    },
    {
      name: "create an inline comment",
      label: "api POST repos/:owner/:repo/pulls/:n/comments",
      request: {
        kind: "rest",
        host: "github.com",
        method: "POST",
        path: `repos/${owner}/${repo}/pulls/42/comments`,
        jsonBody: '{"body":"note","commit_id":"a"}',
      },
    },
    {
      name: "edit a published comment",
      label: "api PATCH repos/:owner/:repo/pulls/comments/:n",
      request: {
        kind: "rest",
        host: "github.com",
        method: "PATCH",
        path: `repos/${owner}/${repo}/pulls/comments/${commentId}`,
        jsonBody: '{"body":"edited"}',
      },
    },
    {
      name: "delete a published comment",
      label: "api DELETE repos/:owner/:repo/pulls/comments/:n",
      request: {
        kind: "rest",
        host: "github.com",
        method: "DELETE",
        path: `repos/${owner}/${repo}/pulls/comments/${commentId}`,
      },
    },
    {
      name: "remove requested reviewers",
      label: "api DELETE repos/:owner/:repo/pulls/:n/requested_reviewers",
      request: {
        kind: "rest",
        host: "github.com",
        method: "DELETE",
        path: `repos/${owner}/${repo}/pulls/42/requested_reviewers`,
        jsonBody: '{"reviewers":["ann"]}',
      },
    },
  ];
}

function mutationWrites(): ReadonlyArray<WriteInventoryEntry> {
  const idList = (
    name: string,
    label: string,
    document: string,
    subject: string,
    ids: string,
  ): WriteInventoryEntry => ({
    name,
    label: `api graphql ${label}`,
    request: {
      kind: "graphql",
      host: "github.com",
      document,
      variables: [
        { kind: "typed", name: subject, value: "PR_1" },
        { kind: "list", name: ids, values: ["MDQ6VXNlcjE="] },
      ],
    },
  });
  const subjectOnly = (
    name: string,
    label: string,
    document: string,
    variable: string,
    value: string,
  ): WriteInventoryEntry => ({
    name,
    label: `api graphql ${label}`,
    request: {
      kind: "graphql",
      host: "github.com",
      document,
      variables: [{ kind: "typed", name: variable, value }],
    },
  });

  return [
    idList(
      "add labels",
      "addLabelsToLabelable",
      addLabelsToLabelableMutation,
      "labelableId",
      "labelIds",
    ),
    idList(
      "remove labels",
      "removeLabelsFromLabelable",
      removeLabelsFromLabelableMutation,
      "labelableId",
      "labelIds",
    ),
    idList(
      "add assignees",
      "addAssigneesToAssignable",
      addAssigneesToAssignableMutation,
      "assignableId",
      "assigneeIds",
    ),
    idList(
      "remove assignees",
      "removeAssigneesFromAssignable",
      removeAssigneesFromAssignableMutation,
      "assignableId",
      "assigneeIds",
    ),
    idList(
      "request reviewers",
      "requestReviews",
      requestReviewsMutation,
      "pullRequestId",
      "userIds",
    ),
    {
      name: "change the base branch",
      label: "api graphql updatePullRequest",
      request: {
        kind: "graphql",
        host: "github.com",
        document: updatePullRequestBaseBranchMutation,
        variables: [
          { kind: "typed", name: "pullRequestId", value: "PR_1" },
          { kind: "string", name: "baseRefName", value: "main" },
        ],
      },
    },
    subjectOnly(
      "mark ready for review",
      "markPullRequestReadyForReview",
      markPullRequestReadyForReviewMutation,
      "pullRequestId",
      "PR_1",
    ),
    subjectOnly(
      "convert to draft",
      "convertPullRequestToDraft",
      convertPullRequestToDraftMutation,
      "pullRequestId",
      "PR_1",
    ),
    {
      name: "add a pending review thread",
      label: "api graphql addPullRequestReviewThread",
      request: {
        kind: "graphql",
        host: "github.com",
        document: addPendingReviewThreadMutation("RIGHT"),
        variables: [
          { kind: "typed", name: "reviewId", value: "PRR_1" },
          { kind: "typed", name: "path", value: "src/a.ts" },
          { kind: "typed", name: "line", value: 12 },
          { kind: "string", name: "body", value: "note" },
        ],
      },
    },
    {
      name: "reply to a thread",
      label: "api graphql addPullRequestReviewThreadReply",
      request: {
        kind: "graphql",
        host: "github.com",
        document: addThreadReplyMutation,
        variables: [
          { kind: "typed", name: "threadId", value: "PRRT_1" },
          { kind: "string", name: "body", value: "reply" },
        ],
      },
    },
    subjectOnly(
      "resolve a thread",
      "resolveReviewThread",
      reviewThreadStateMutation("resolved"),
      "threadId",
      "PRRT_1",
    ),
    subjectOnly(
      "unresolve a thread",
      "unresolveReviewThread",
      reviewThreadStateMutation("open"),
      "threadId",
      "PRRT_1",
    ),
    {
      name: "edit a thread comment",
      label: "api graphql updatePullRequestReviewComment",
      request: {
        kind: "graphql",
        host: "github.com",
        document: updateThreadCommentMutation,
        variables: [
          { kind: "typed", name: "commentId", value: "PRRC_1" },
          { kind: "string", name: "body", value: "edited" },
        ],
      },
    },
    subjectOnly(
      "delete a thread comment",
      "deletePullRequestReviewComment",
      deleteThreadCommentMutation,
      "commentId",
      "PRRC_1",
    ),
  ];
}
