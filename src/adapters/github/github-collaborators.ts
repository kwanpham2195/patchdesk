import * as v from "valibot";

import type { CommandFailure } from "./command-runner";
import {
  type GhRequestRunner,
  type GitHubReadFailure,
  type GitHubReadOperation,
} from "./gh-request-runner";
import type { GitHubRequest } from "./github-request";
import type {
  AssignableUserListing,
  PullRequestReviewerListing,
  RepositoryLabelListing,
} from "../../domain/github-context";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import type { GitHubWriteFailure } from "../../domain/github-write";
import {
  addAssigneesToAssignableMutation,
  addLabelsToLabelableMutation,
  assignableUsersQuery,
  convertPullRequestToDraftMutation,
  markPullRequestReadyForReviewMutation,
  pullRequestReviewersQuery,
  removeAssigneesFromAssignableMutation,
  removeLabelsFromLabelableMutation,
  repositoryLabelsQuery,
  requestReviewsMutation,
  updatePullRequestBaseBranchMutation,
} from "./github-graphql-queries";
import {
  assignableUsersResponseSchema,
  pullRequestReviewersResponseSchema,
  repositoryLabelsResponseSchema,
} from "./github-wire-schemas";
import {
  parseAssignableUser,
  parsePullRequestReviewerListing,
  parseRepositoryLabel,
} from "./github-wire-projections";
import { invalid, writeFailure } from "./github-write-failures";

/**
 * Reads and writes the people-and-labels metadata on a pull request: labels,
 * assignable users, reviewers, assignees.
 */
export class GitHubCollaborators {
  constructor(private readonly requests: GhRequestRunner) {}

  /** Run a request that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.requests.ghJson(profile, request);
  }

  private commandFailure(
    operation: GitHubReadOperation,
    failure: CommandFailure,
    host: string,
  ): Result<never, GitHubReadFailure> {
    return this.requests.commandFailure(operation, failure, host);
  }

  /** Fetches up to 100 repository labels in one bounded page; `totalCount` reveals truncation beyond that. */
  async listRepositoryLabels(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: Pick<PullRequestRef, "host" | "owner" | "repo">;
  }): Promise<Result<RepositoryLabelListing, GitHubReadFailure>> {
    const host = input.profile.githubHost;
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host,
      document: repositoryLabelsQuery,
      variables: [
        { kind: "typed", name: "owner", value: input.repo.owner },
        { kind: "typed", name: "name", value: input.repo.repo },
      ],
    });
    if (response._tag === "err")
      return this.commandFailure(
        "list_repository_labels",
        response.error,
        host,
      );
    const parsed = v.safeParse(repositoryLabelsResponseSchema, response.value);
    if (!parsed.success) return invalid("list_repository_labels");
    const connection = parsed.output.data.repository.labels;
    return ok({
      labels: connection.nodes.map(parseRepositoryLabel),
      totalCount: connection.totalCount,
    });
  }

  /** Fetches up to 100 repository collaborators eligible for assignment in one bounded page; `totalCount` reveals truncation beyond that. `query` filters server-side by login/name substring when provided. */
  async listAssignableUsers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
    readonly query?: string;
  }): Promise<Result<AssignableUserListing, GitHubReadFailure>> {
    const host = input.profile.githubHost;
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host,
      document: assignableUsersQuery,
      variables: [
        { kind: "typed", name: "owner", value: input.repo.owner },
        { kind: "typed", name: "name", value: input.repo.repo },
        ...(input.query !== undefined && input.query.length > 0
          ? [{ kind: "string" as const, name: "search", value: input.query }]
          : []),
      ],
    });
    if (response._tag === "err")
      return this.commandFailure("list_assignable_users", response.error, host);
    const parsed = v.safeParse(assignableUsersResponseSchema, response.value);
    if (!parsed.success) return invalid("list_assignable_users");
    const connection = parsed.output.data.repository.assignableUsers;
    return ok({
      users: connection.nodes.map(parseAssignableUser),
      totalCount: connection.totalCount,
    });
  }

  async getPullRequestReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestReviewerListing, GitHubReadFailure>> {
    const host = input.profile.githubHost;
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host,
      document: pullRequestReviewersQuery,
      variables: [
        { kind: "typed", name: "owner", value: input.pr.owner },
        { kind: "typed", name: "name", value: input.pr.repo },
        { kind: "typed", name: "number", value: input.pr.number },
      ],
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_pull_request_reviewers",
        response.error,
        host,
      );
    const parsed = v.safeParse(
      pullRequestReviewersResponseSchema,
      response.value,
    );
    if (!parsed.success) return invalid("get_pull_request_reviewers");
    return ok(
      parsePullRequestReviewerListing(
        parsed.output.data.repository.pullRequest,
      ),
    );
  }

  /**
   * Runs one GraphQL mutation whose whole variable set is a subject node id
   * plus a list of node ids — the shape every label, assignee, and reviewer
   * mutation on this adapter has (see the note on
   * `addLabelsToLabelableMutation`). Every such mutation returns only
   * `clientMutationId`, so a succeeding command is the whole result.
   */
  private async runIdListMutation(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly mutation: string;
    readonly subjectVariable: string;
    readonly subjectId: string;
    readonly idsVariable: string;
    readonly ids: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host: input.profile.githubHost,
      document: input.mutation,
      variables: [
        {
          kind: "typed",
          name: input.subjectVariable,
          value: input.subjectId,
        },
        { kind: "list", name: input.idsVariable, values: input.ids },
      ],
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  async addLabelsToLabelable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly labelableId: string;
    readonly labelIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.runIdListMutation({
      profile: input.profile,
      mutation: addLabelsToLabelableMutation,
      subjectVariable: "labelableId",
      subjectId: input.labelableId,
      idsVariable: "labelIds",
      ids: input.labelIds,
    });
  }

  async removeLabelsFromLabelable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly labelableId: string;
    readonly labelIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.runIdListMutation({
      profile: input.profile,
      mutation: removeLabelsFromLabelableMutation,
      subjectVariable: "labelableId",
      subjectId: input.labelableId,
      idsVariable: "labelIds",
      ids: input.labelIds,
    });
  }

  async addAssigneesToAssignable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.runIdListMutation({
      profile: input.profile,
      mutation: addAssigneesToAssignableMutation,
      subjectVariable: "assignableId",
      subjectId: input.assignableId,
      idsVariable: "assigneeIds",
      ids: input.assigneeIds,
    });
  }

  async removeAssigneesFromAssignable(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly assignableId: string;
    readonly assigneeIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.runIdListMutation({
      profile: input.profile,
      mutation: removeAssigneesFromAssignableMutation,
      subjectVariable: "assignableId",
      subjectId: input.assignableId,
      idsVariable: "assigneeIds",
      ids: input.assigneeIds,
    });
  }

  async requestReviews(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly userIds: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    return this.runIdListMutation({
      profile: input.profile,
      mutation: requestReviewsMutation,
      subjectVariable: "pullRequestId",
      subjectId: input.pullRequestId,
      idsVariable: "userIds",
      ids: input.userIds,
    });
  }

  /**
   * Toggles one pull request's draft state. `runIdListMutation` cannot carry
   * this write: its whole shape is a subject id plus a list of node ids, and
   * this mutation takes only the subject, so the request is built here the way
   * `removeRequestedReviewers` builds its own.
   */
  async setPullRequestDraftState(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly draft: boolean;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const mutation = input.draft
      ? convertPullRequestToDraftMutation
      : markPullRequestReadyForReviewMutation;
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host: input.profile.githubHost,
      document: mutation,
      variables: [
        { kind: "typed", name: "pullRequestId", value: input.pullRequestId },
      ],
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  /** Moves a pull request onto `branch` of its base repository with `updatePullRequest`. */
  async setPullRequestBaseBranch(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pullRequestId: string;
    readonly branch: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      kind: "graphql",
      host: input.profile.githubHost,
      document: updatePullRequestBaseBranchMutation,
      variables: [
        { kind: "typed", name: "pullRequestId", value: input.pullRequestId },
        // A string variable keeps a numeric-looking branch name a GraphQL String.
        { kind: "string", name: "baseRefName", value: input.branch },
      ],
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }

  /**
   * Removes named people from a pull request's requested-reviewer set via
   * the REST endpoint's own subtractive semantics (`DELETE
   * .../requested_reviewers` with a `{ reviewers: [...] }` body removes only
   * the named logins) — see the asymmetry explained on
   * `GitHubReviewWriter.removeRequestedReviewers`. A `DELETE` method with a
   * `jsonBody` copies `updateReviewComment`'s shape for a body-carrying
   * non-GET request.
   */
  async removeRequestedReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly logins: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      kind: "rest",
      host: input.profile.githubHost,
      method: "DELETE",
      path: `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/requested_reviewers`,
      jsonBody: JSON.stringify({ reviewers: input.logins }),
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }
}
