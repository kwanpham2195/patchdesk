/**
 * Projects the two maintainer pull-request listing queries into domain rows
 * and pages. `maintainerInboxQuery`'s `repository.pullRequests` connection and
 * `maintainerInboxSearchQuery`'s repository-wide `search` connection return
 * the same node and page shape, so one row projection and one page projection
 * serve both. They live here rather than in `github-wire-projections.ts`
 * because that file is at its size ceiling; the general mappers they still
 * share with the pull-request and merge-policy projections are imported from
 * it.
 */
import type {
  CheckSummary,
  MaintainerPullRequest,
  MaintainerPullRequestPage,
  PullRequestSummary,
} from "../../domain/github-context";
import {
  parseGitSha,
  parsePullRequestNumber,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
} from "../../domain/ids";
import type { InboxStateFilter } from "../../domain/maintainer-inbox";
import { err, ok, type Result } from "../../domain/result";
import {
  mapMergeability,
  parseGitHubTimestamp,
} from "./github-wire-projections";
import type { MaintainerPullRequestConnection } from "./github-wire-schemas";

/**
 * Projects one cursor-carrying maintainer page — the `repository.pullRequests`
 * connection and the repository-wide `search` connection share this exact
 * shape. `undefined` means the page is unusable and the caller must report
 * `Invalid`: either a row failed projection, or GitHub claimed a next page
 * without the cursor needed to ask for it, which would silently truncate the
 * inbox. `issueCount` stays with the search caller; it is the only field the
 * two connections do not share.
 */
export function parseMaintainerPullRequestPage(
  connection: MaintainerPullRequestConnection,
  host: GitHubHost,
  owner: GitHubOwner,
  repo: GitHubRepoName,
  state: InboxStateFilter,
): MaintainerPullRequestPage | undefined {
  const endCursor = connection.pageInfo.endCursor ?? undefined;
  if (connection.pageInfo.hasNextPage && endCursor === undefined)
    return undefined;
  const entries = [];
  for (const edge of connection.edges) {
    const projected = parseMaintainerPullRequest(
      edge.node,
      host,
      owner,
      repo,
      state,
    );
    if (projected._tag === "err") return undefined;
    entries.push({ cursor: edge.cursor, pullRequest: projected.value });
  }
  const page: MaintainerPullRequestPage = {
    entries,
    hasNextPage: connection.pageInfo.hasNextPage,
  };
  return endCursor === undefined ? page : { ...page, endCursor };
}

function parseMaintainerPullRequest(
  input: MaintainerPullRequestConnection["edges"][number]["node"],
  host: GitHubHost,
  owner: GitHubOwner,
  repo: GitHubRepoName,
  state: InboxStateFilter,
): Result<MaintainerPullRequest, { readonly _tag: "Invalid" }> {
  const number = parsePullRequestNumber(input.number);
  const headSha = parseGitSha(input.headRefOid);
  const baseSha =
    input.baseRefOid === undefined ? undefined : parseGitSha(input.baseRefOid);
  const updatedAt = parseGitHubTimestamp(input.updatedAt);
  if (
    number._tag === "err" ||
    headSha._tag === "err" ||
    (baseSha !== undefined && baseSha._tag === "err") ||
    updatedAt._tag === "err"
  )
    return err({ _tag: "Invalid" });
  let summary: PullRequestSummary = {
    ref: { host, owner, repo, number: number.value },
    title: input.title,
    author: input.author?.login ?? "ghost",
    headBranch: input.headRefName,
    baseBranch: input.baseRefName,
    headSha: headSha.value,
    isDraft: input.isDraft,
    isOpen: state === "open",
    reviewState: mapReviewDecision(input.reviewDecision),
    mergeability: mapMergeability(input.mergeable),
    labels: input.labels.nodes.map((label) => ({
      name: label.name,
      color: label.color,
    })),
    labelCount: input.labels.totalCount,
    requestedReviewers: input.reviewRequests.nodes.flatMap((request) =>
      request.requestedReviewer?.login === undefined
        ? []
        : [request.requestedReviewer.login],
    ),
    assignees: input.assignees.nodes.map((assignee) => assignee.login),
    updatedAt: updatedAt.value,
    additions: input.additions,
    deletions: input.deletions,
    changedFileCount: input.changedFiles,
  };
  const authorAvatarUrl = input.author?.avatarUrl ?? undefined;
  if (authorAvatarUrl !== undefined) summary = { ...summary, authorAvatarUrl };
  if (baseSha !== undefined) summary = { ...summary, baseSha: baseSha.value };
  const rollup = input.commits.nodes[0]?.commit.statusCheckRollup?.state;
  return ok({ summary, checks: rollupCheckSummary(rollup) });
}

function mapReviewDecision(
  value: string | null | undefined,
): PullRequestSummary["reviewState"] {
  switch (value) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_pending";
    case null:
    case undefined:
      return "none";
    default:
      return "unknown";
  }
}

function rollupCheckSummary(value: string | undefined): CheckSummary {
  switch (value) {
    case "SUCCESS":
      return { overall: "passing", checks: [] };
    case "FAILURE":
    case "ERROR":
    case "EXPECTED":
      return { overall: "failing", checks: [] };
    case "PENDING":
      return { overall: "pending", checks: [] };
    default:
      return { overall: "unknown", checks: [] };
  }
}
