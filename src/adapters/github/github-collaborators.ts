import * as v from "valibot";

import type { CommandFailure } from "./command-runner";
import {
  commandTimeoutMs,
  type GhCommandRequest,
  type GhRequestRunner,
  type GitHubReadFailure,
  type GitHubReadOperation,
} from "./gh-request-runner";
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
  pullRequestReviewersQuery,
  removeAssigneesFromAssignableMutation,
  removeLabelsFromLabelableMutation,
  repositoryLabelsQuery,
  requestReviewsMutation,
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

  /** Run a gh command that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
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
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        host,
        "-f",
        `query=${repositoryLabelsQuery}`,
        "-F",
        `owner=${input.repo.owner}`,
        "-F",
        `name=${input.repo.repo}`,
      ],
      timeoutMs: commandTimeoutMs,
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
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        host,
        "-f",
        `query=${assignableUsersQuery}`,
        "-F",
        `owner=${input.repo.owner}`,
        "-F",
        `name=${input.repo.repo}`,
        ...(input.query !== undefined && input.query.length > 0
          ? ["-F", `search=${input.query}`]
          : []),
      ],
      timeoutMs: commandTimeoutMs,
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
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        host,
        "-f",
        `query=${pullRequestReviewersQuery}`,
        "-F",
        `owner=${input.pr.owner}`,
        "-F",
        `name=${input.pr.repo}`,
        "-F",
        `number=${input.pr.number}`,
      ],
      timeoutMs: commandTimeoutMs,
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
   * Runs one `gh api graphql` mutation whose whole variable set is a subject
   * node id plus a list of node ids — the shape every label, assignee, and
   * reviewer mutation on this adapter has. The list rides as one repeated
   * `-F 'name[]=<id>'` pair per element, which is how `gh` sends a real
   * GraphQL list (verified live on gh 2.96.0; see the note on
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
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${input.mutation}`,
        "-F",
        `${input.subjectVariable}=${input.subjectId}`,
        ...input.ids.flatMap((id) => ["-F", `${input.idsVariable}[]=${id}`]),
      ],
      timeoutMs: commandTimeoutMs,
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
   * Removes named people from a pull request's requested-reviewer set via
   * the REST endpoint's own subtractive semantics (`DELETE
   * .../requested_reviewers` with a `{ reviewers: [...] }` body removes only
   * the named logins) — see the asymmetry explained on
   * `GitHubReviewWriter.removeRequestedReviewers`. `--method DELETE` +
   * `--input -` + `stdin: JSON.stringify(...)` copies `updateReviewComment`'s
   * argv shape for a body-carrying non-GET request.
   */
  async removeRequestedReviewers(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly logins: ReadonlyArray<string>;
  }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "DELETE",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/requested_reviewers`,
        "--input",
        "-",
      ],
      stdin: JSON.stringify({ reviewers: input.logins }),
      timeoutMs: commandTimeoutMs,
    });
    return response._tag === "err"
      ? err(writeFailure(response.error))
      : ok(undefined);
  }
}
