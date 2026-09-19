import { describe, it } from "vitest";

import {
  addAssigneesToAssignableMutation,
  addLabelsToLabelableMutation,
  convertPullRequestToDraftMutation,
  markPullRequestReadyForReviewMutation,
  removeAssigneesFromAssignableMutation,
  removeLabelsFromLabelableMutation,
  requestReviewsMutation,
  updatePullRequestBaseBranchMutation,
} from "../../src/adapters/github/github-graphql-queries";
import { profile, useFixtureServer } from "./github-http-fixture-server";
import {
  expectSameMutationAsGh,
  expectSameRequestAsGh,
  pr,
  writeAdapter,
} from "./github-write-shape";

/**
 * The pull-request metadata write family over HTTP: labels, assignees,
 * reviewer requests, the draft toggle, and the base branch (issue #276, step
 * T3).
 *
 * Every id list here was sent by gh as repeated `-F 'name[]=<value>'` pairs,
 * which is a real GraphQL list, so what the client must reproduce is an array
 * of the same values in the same order — including the single-element case,
 * where a naive encoding would send a bare string and the schema would reject
 * `[ID!]!`.
 */

const server = useFixtureServer();
const pullRequestId = "PR_kwDOabc123";
const nodeIds = ["MDQ6VXNlcjE=", "MDQ6VXNlcjI="];
const oneNodeId = "MDQ6VXNlcjE=";

describe("label and assignee writes over HTTP", () => {
  const idListWrites = [
    {
      name: "add labels",
      query: addLabelsToLabelableMutation,
      subject: "labelableId",
      ids: "labelIds",
      call: (ids: ReadonlyArray<string>) =>
        writeAdapter(server).addLabelsToLabelable({
          profile,
          labelableId: pullRequestId,
          labelIds: ids,
        }),
    },
    {
      name: "remove labels",
      query: removeLabelsFromLabelableMutation,
      subject: "labelableId",
      ids: "labelIds",
      call: (ids: ReadonlyArray<string>) =>
        writeAdapter(server).removeLabelsFromLabelable({
          profile,
          labelableId: pullRequestId,
          labelIds: ids,
        }),
    },
    {
      name: "add assignees",
      query: addAssigneesToAssignableMutation,
      subject: "assignableId",
      ids: "assigneeIds",
      call: (ids: ReadonlyArray<string>) =>
        writeAdapter(server).addAssigneesToAssignable({
          profile,
          assignableId: pullRequestId,
          assigneeIds: ids,
        }),
    },
    {
      name: "remove assignees",
      query: removeAssigneesFromAssignableMutation,
      subject: "assignableId",
      ids: "assigneeIds",
      call: (ids: ReadonlyArray<string>) =>
        writeAdapter(server).removeAssigneesFromAssignable({
          profile,
          assignableId: pullRequestId,
          assigneeIds: ids,
        }),
    },
    {
      name: "request reviewers",
      query: requestReviewsMutation,
      subject: "pullRequestId",
      ids: "userIds",
      call: (ids: ReadonlyArray<string>) =>
        writeAdapter(server).requestReviews({
          profile,
          pullRequestId,
          userIds: ids,
        }),
    },
  ] as const;

  it.each(idListWrites)(
    "sends $name with its id list as a GraphQL array",
    async ({ query, subject, ids, call }) => {
      await call(nodeIds);

      expectSameMutationAsGh(server.requests()[0], {
        query,
        variables: { [subject]: pullRequestId, [ids]: nodeIds },
      });
    },
  );

  it.each(idListWrites)(
    "sends $name with one id still as an array",
    async ({ query, subject, ids, call }) => {
      await call([oneNodeId]);

      expectSameMutationAsGh(server.requests()[0], {
        query,
        variables: { [subject]: pullRequestId, [ids]: [oneNodeId] },
      });
    },
  );

  it.each(idListWrites)(
    "sends $name with an empty id list as an empty array",
    async ({ query, subject, ids, call }) => {
      await call([]);

      expectSameMutationAsGh(server.requests()[0], {
        query,
        variables: { [subject]: pullRequestId, [ids]: [] },
      });
    },
  );
});

describe("reviewer removal over HTTP", () => {
  /**
   * Removal takes the subtractive REST endpoint rather than a mutation, and it
   * is the one DELETE the adapter sends with a body, which gh carried on stdin
   * through `--input -`.
   */
  it("deletes the named logins with a body", async () => {
    await writeAdapter(server).removeRequestedReviewers({
      profile,
      pr,
      logins: ["ann", "bo"],
    });

    expectSameRequestAsGh(server.requests()[0], {
      kind: "rest",
      host: "github.com",
      method: "DELETE",
      path: "repos/centraldigital/patchdesk/pulls/42/requested_reviewers",
      jsonBody: JSON.stringify({ reviewers: ["ann", "bo"] }),
    });
  });
});

describe("draft and base branch writes over HTTP", () => {
  const draftStates = [
    { draft: true, query: convertPullRequestToDraftMutation },
    { draft: false, query: markPullRequestReadyForReviewMutation },
  ] as const;

  it.each(draftStates)(
    "picks the mutation for draft=$draft rather than a variable",
    async ({ draft, query }) => {
      await writeAdapter(server).setPullRequestDraftState({
        profile,
        pullRequestId,
        draft,
      });

      expectSameMutationAsGh(server.requests()[0], {
        query,
        variables: { pullRequestId },
      });
    },
  );

  // The branch name goes through `-f`, so a numeric-looking branch stays a
  // GraphQL String rather than becoming an Int the schema rejects.
  const branches = ["main", "2026", "release/v2", "café"];

  it.each(branches)("sends the base branch %s as a String", async (branch) => {
    await writeAdapter(server).setPullRequestBaseBranch({
      profile,
      pullRequestId,
      branch,
    });

    expectSameMutationAsGh(server.requests()[0], {
      query: updatePullRequestBaseBranchMutation,
      variables: { pullRequestId, baseRefName: branch },
    });
  });
});
