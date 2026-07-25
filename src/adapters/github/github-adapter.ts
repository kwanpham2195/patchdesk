import * as v from "valibot";

import type { CommandFailure, CommandRunner } from "./command-runner";
import type {
  CheckRunSummary,
  CheckSummary,
  GitHubComment,
  GitHubComments,
  GitHubConversationThread,
  PullRequestSummary,
} from "../../domain/github-context";
import {
  parseGitSha,
  parseGitHubThreadId,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseRepoRelativePath,
  type AbsolutePath,
  type GitSha,
  type GitHubThreadId,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type ReviewSessionId,
  type RepoRelativePath,
} from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import type { GitHubReviewEvent, GitHubWriteFailure } from "../../domain/review-draft";
import type { RevisionComparison } from "../../domain/review-comparison";

const commandTimeoutMs = 15_000;
// Two source blobs travel through the 2 MiB Electron bridge, so each stays
// below 512 KiB after allowing for JSON framing and multibyte text.
const maxHydratedFileBytes = 512 * 1024;
const threadQuery =
  "query PullRequestThreads($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved isOutdated comments(first: 100) { nodes { id body createdAt updatedAt url author { login } path line startLine side startSide originalLine } } } } } } }";
const maintainerInboxQuery =
  "query MaintainerInbox($owner: String!, $name: String!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequests(first: 100, after: $cursor, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title isDraft headRefName headRefOid baseRefName baseRefOid author { login } updatedAt mergeable reviewDecision additions deletions changedFiles reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login } } } } assignees(first: 50) { nodes { login } } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } pageInfo { hasNextPage endCursor } } } }";

const pullRequestSchema = v.looseObject({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.string(),
  body: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(65_536)))),
  state: v.picklist(["open", "closed"]),
  draft: v.boolean(),
  head: v.looseObject({ ref: v.string(), sha: v.string() }),
  base: v.looseObject({ ref: v.string(), sha: v.optional(v.string()) }),
  user: v.looseObject({ login: v.string() }),
  updated_at: v.string(),
  mergeable_state: v.optional(v.string()),
  labels: v.optional(v.array(v.looseObject({ name: v.string() }))),
  requested_reviewers: v.optional(
    v.array(v.looseObject({ login: v.string() })),
  ),
  assignees: v.optional(v.array(v.looseObject({ login: v.string() }))),
  additions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  deletions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  changed_files: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const checkRunsSchema = v.looseObject({
  check_runs: v.array(
    v.looseObject({
      name: v.string(),
      status: v.string(),
      conclusion: v.optional(v.nullable(v.string())),
      details_url: v.optional(v.nullable(v.string())),
    }),
  ),
});

const repositoryFileSchema = v.looseObject({
  type: v.string(),
  encoding: v.optional(v.string()),
  content: v.optional(v.string()),
  size: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const threadResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      pullRequest: v.looseObject({
        reviewThreads: v.looseObject({
          nodes: v.array(
            v.looseObject({
              id: v.string(),
              isResolved: v.boolean(),
              isOutdated: v.boolean(),
              comments: v.looseObject({
                nodes: v.array(
                  v.looseObject({
                    id: v.string(),
                    body: v.string(),
                    createdAt: v.string(),
                    updatedAt: v.optional(v.nullable(v.string())),
                    url: v.optional(v.nullable(v.string())),
                    author: v.nullish(v.looseObject({ login: v.string() })),
                    path: v.optional(v.nullable(v.string())),
                    line: v.optional(
                      v.nullable(
                        v.pipe(v.number(), v.integer(), v.minValue(1)),
                      ),
                    ),
                    originalLine: v.optional(
                      v.nullable(
                        v.pipe(v.number(), v.integer(), v.minValue(1)),
                      ),
                    ),
                    startLine: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
                    side: v.optional(v.nullable(v.string())),
                    startSide: v.optional(v.nullable(v.string())),
                  }),
                ),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

const maintainerInboxResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      pullRequests: v.looseObject({
        nodes: v.array(v.looseObject({
          number: v.pipe(v.number(), v.integer(), v.minValue(1)),
          title: v.string(),
          isDraft: v.boolean(),
          headRefName: v.string(),
          headRefOid: v.string(),
          baseRefName: v.string(),
          baseRefOid: v.optional(v.string()),
          author: v.nullish(v.looseObject({ login: v.string() })),
          updatedAt: v.string(),
          mergeable: v.string(),
          reviewDecision: v.nullish(v.string()),
          additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
          deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
          changedFiles: v.pipe(v.number(), v.integer(), v.minValue(0)),
          reviewRequests: v.looseObject({
            nodes: v.array(v.looseObject({
              requestedReviewer: v.nullish(
                v.looseObject({ login: v.optional(v.string()) }),
              ),
            })),
          }),
          assignees: v.looseObject({ nodes: v.array(v.looseObject({ login: v.string() })) }),
          commits: v.looseObject({
            nodes: v.array(v.looseObject({
              commit: v.looseObject({
                statusCheckRollup: v.nullish(v.looseObject({ state: v.string() })),
              }),
            })),
          }),
        })),
        pageInfo: v.looseObject({ hasNextPage: v.boolean(), endCursor: v.nullish(v.string()) }),
      }),
    }),
  }),
});

/** The typed read-only operations product code may request from GitHub. */
export interface GitHubReader {
  listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>>;
  listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<MaintainerPullRequestListing, GitHubReadFailure>>;
  getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>>;
  getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>>;
  getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>>;
  getPullRequestDiff(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly fetchedRefs?: FetchedDiffRefs;
    /** Immutable remote comparison used only when no managed checkout exists. */
    readonly snapshot?: { readonly baseSha: GitSha; readonly headSha: GitSha };
  }): Promise<Result<string, GitHubReadFailure>>;
  /** Fetch one bounded text blob at an immutable revision for local diff hydration. */
  getFileContents(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly sha: GitSha;
    readonly path: RepoRelativePath;
  }): Promise<Result<GitHubFileContents, GitHubReadFailure>>;
  compareRevisions(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly baseSha: GitSha;
    readonly headSha: GitSha;
    readonly baseSessionId: ReviewSessionId;
  }): Promise<Result<GitHubRevisionComparison, GitHubReadFailure>>;
  resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>>;
}

export type MaintainerPullRequest = {
  readonly summary: PullRequestSummary;
  readonly checks: CheckSummary;
};

export type MaintainerPullRequestListing = {
  readonly pullRequests: ReadonlyArray<MaintainerPullRequest>;
  /** False means GitHub reported more than Patchdesk's deliberate 300-PR cap. */
  readonly complete: boolean;
};

/** GitHub comparison is usable only when both metadata and one complete unified diff are verified. */
export type GitHubRevisionComparison = {
  readonly comparison: RevisionComparison;
  readonly patch?: string;
};

/** Safe projection for one source file; binary and oversized blobs never enter the renderer. */
export type GitHubFileContents =
  | { readonly state: "available"; readonly contents: string }
  | { readonly state: "binary" | "too_large" };

export type PendingReviewComment = {
  readonly body: string;
  readonly path: string;
  readonly line: number;
  readonly lineEnd?: number;
  readonly diffSide: "new" | "old";
};

/** Explicit write boundary. Product services must recheck the PR head immediately before calling it. */
export interface GitHubReviewWriter {
  createPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly summaryBody: string;
    readonly comments: ReadonlyArray<PendingReviewComment>;
  }): Promise<Result<{ readonly reviewId: string; readonly state: "PENDING" }, GitHubWriteFailure>>;
  submitPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: string;
    readonly event: GitHubReviewEvent;
    readonly summaryBody: string;
  }): Promise<Result<{ readonly reviewId: string }, GitHubWriteFailure>>;
  createThreadReply?(input: { readonly profile: WorkspaceProfileConfig; readonly threadId: GitHubThreadId; readonly body: string }): Promise<Result<{ readonly commentId: string }, GitHubWriteFailure>>;
  setReviewThreadState?(input: { readonly profile: WorkspaceProfileConfig; readonly threadId: GitHubThreadId; readonly state: "resolved" | "open" }): Promise<Result<void, GitHubWriteFailure>>;
}

export interface GitHubMergeWriter {
  mergePullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly method: "merge" | "squash" | "rebase";
  }): Promise<Result<{ readonly mergeCommitSha?: GitSha }, GitHubWriteFailure>>;
}

/** Explicit evidence created by a future fetched-ref owner before Git diff fallback is allowed. */
export type FetchedDiffRefs = {
  readonly repositoryPath: AbsolutePath;
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: GitSha;
  readonly headSha: GitSha;
} & { readonly [fetchedDiffRefsBrand]: "FetchedDiffRefs" };

declare const fetchedDiffRefsBrand: unique symbol;

/** Safe parser for the managed refs that permit the adapter's Git diff fallback. */
export function createFetchedDiffRefs(input: {
  readonly repositoryPath: AbsolutePath;
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: GitSha;
  readonly headSha: GitSha;
}): Result<FetchedDiffRefs, InvalidFetchedDiffRefs> {
  if (
    !isManagedFetchedRef(input.baseRef) ||
    !isManagedFetchedRef(input.headRef)
  ) {
    return err({ _tag: "InvalidFetchedDiffRefs" });
  }

  // SAFETY: the parser above establishes that both ref arguments name Patchdesk-managed refs,
  // and the branded path and expected commit IDs have already passed their boundary parsers.
  return ok(input as FetchedDiffRefs);
}

/** Expected failure for invalid fetched-ref fallback evidence. */
export type InvalidFetchedDiffRefs = {
  readonly _tag: "InvalidFetchedDiffRefs";
};

/** Safe identity projection from a successful local gh auth-status check. */
export type AuthenticatedGitHubAccount = {
  readonly host: string;
  readonly account: string;
};

/** Safe expected failures emitted by the GitHub read boundary. */
export type GitHubReadFailure =
  | {
      readonly _tag: "GitHubAuthenticationFailed";
      readonly operation: GitHubReadOperation;
    }
  | {
      readonly _tag: "GitHubReadFailed";
      readonly operation: GitHubReadOperation;
    }
  | {
      readonly _tag: "GitHubResponseInvalid";
      readonly operation: GitHubReadOperation;
    };

type GitHubReadOperation =
  | "list_open_prs"
  | "list_maintainer_prs"
  | "get_pr"
  | "get_comments"
  | "get_checks"
  | "get_diff"
  | "get_file"
  | "compare_revisions"
  | "auth_status";

/**
 * GitHub CLI external adapter. It owns all gh execution and returns parsed, safe projections.
 * Read operations and explicit review writes live in the main process; renderer code never reaches this adapter.
 */
export class GitHubAdapter implements GitHubReader, GitHubReviewWriter, GitHubMergeWriter {
  constructor(private readonly commands: CommandRunner) {}

  async listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>> {
    const response = await this.commands.runJson({
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.repo.owner}/${input.repo.repo}/pulls?state=open&per_page=100`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return commandFailure("list_open_prs", response.error);
    if (!Array.isArray(response.value)) return invalid("list_open_prs");

    const summaries: Array<PullRequestSummary> = [];
    for (const value of response.value) {
      const summary = parsePullRequest(
        value,
        input.profile.githubHost,
        input.repo.owner,
        input.repo.repo,
      );
      if (summary._tag === "err") return invalid("list_open_prs");
      summaries.push(summary.value);
    }
    return ok(summaries);
  }

  /** Lists up to 300 open PRs with the inbox metadata in three bounded GraphQL pages. */
  async listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<MaintainerPullRequestListing, GitHubReadFailure>> {
    const pullRequests: Array<MaintainerPullRequest> = [];
    let cursor: string | undefined;
    let hasNextPage = true;
    for (let page = 0; page < 3 && hasNextPage; page += 1) {
      const response = await this.commands.runJson({
        argv: [
          "gh", "api", "graphql", "--hostname", input.profile.githubHost,
          "-f", `query=${maintainerInboxQuery}`,
          "-F", `owner=${input.repo.owner}`,
          "-F", `name=${input.repo.repo}`,
          ...(cursor === undefined ? [] : ["-f", `cursor=${cursor}`]),
        ],
        timeoutMs: commandTimeoutMs,
      });
      if (response._tag === "err")
        return commandFailure("list_maintainer_prs", response.error);
      const parsed = v.safeParse(maintainerInboxResponseSchema, response.value);
      if (!parsed.success) return invalid("list_maintainer_prs");
      const connection = parsed.output.data.repository.pullRequests;
      for (const node of connection.nodes) {
        const projected = parseMaintainerPullRequest(
          node,
          input.profile.githubHost,
          input.repo.owner,
          input.repo.repo,
        );
        if (projected._tag === "err") return invalid("list_maintainer_prs");
        pullRequests.push(projected.value);
      }
      hasNextPage = connection.pageInfo.hasNextPage;
      cursor = connection.pageInfo.endCursor ?? undefined;
      if (hasNextPage && cursor === undefined) return invalid("list_maintainer_prs");
    }
    return ok({ pullRequests, complete: !hasNextPage });
  }

  async getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>> {
    const response = await this.commands.runJson({
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return commandFailure("get_pr", response.error);
    const parsed = parsePullRequest(
      response.value,
      input.profile.githubHost,
      input.pr.owner,
      input.pr.repo,
    );
    return parsed._tag === "ok" ? parsed : invalid("get_pr");
  }

  async getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>> {
    const response = await this.commands.runJson({
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${threadQuery}`,
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
      return commandFailure("get_comments", response.error);
    const parsed = v.safeParse(threadResponseSchema, response.value);
    if (!parsed.success) return invalid("get_comments");

    const threads: Array<GitHubConversationThread> = [];
    for (const rawThread of parsed.output.data.repository.pullRequest
      .reviewThreads.nodes) {
      const comments: Array<GitHubComment> = [];
      for (const rawComment of rawThread.comments.nodes) {
        const comment = parseComment(rawComment);
        if (comment._tag === "err") return invalid("get_comments");
        comments.push(comment.value);
      }
      const threadId = parseGitHubThreadId(rawThread.id);
      if (threadId._tag === "err") return invalid("get_comments");
      const root = comments[0];
      threads.push({
        id: threadId.value,
        state: rawThread.isResolved
          ? "resolved"
          : rawThread.isOutdated
            ? "outdated"
            : "open",
        comments,
        ...(root?.location === undefined ? {} : { location: root.location }),
      });
    }
    return ok({ threads });
  }

  async getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>> {
    const response = await this.commands.runJson({
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/commits/${input.headSha}/check-runs`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return commandFailure("get_checks", response.error);
    const parsed = v.safeParse(checkRunsSchema, response.value);
    if (!parsed.success) return invalid("get_checks");

    const checks = parsed.output.check_runs.map(toCheckRunSummary);
    return ok({ overall: overallCheckStatus(checks), checks });
  }

  async getPullRequestDiff(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly fetchedRefs?: FetchedDiffRefs;
    /** Immutable remote comparison used only when no managed checkout exists. */
    readonly snapshot?: { readonly baseSha: GitSha; readonly headSha: GitSha };
  }): Promise<Result<string, GitHubReadFailure>> {
    if (input.fetchedRefs !== undefined) {
      const fetchedRefs = await this.verifyFetchedRefs(input.fetchedRefs);
      if (fetchedRefs._tag === "err") return fetchedRefs;

      const exact = await this.commands.runText({
        argv: [
          "git",
          "-C",
          input.fetchedRefs.repositoryPath,
          "diff",
          "--no-ext-diff",
          `${input.fetchedRefs.baseRef}...${input.fetchedRefs.headRef}`,
        ],
        timeoutMs: commandTimeoutMs,
      });
      return exact._tag === "ok"
        ? exact
        : commandFailure("get_diff", exact.error);
    }

    if (input.snapshot !== undefined) {
      const exact = await this.commands.runText({
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          "-H",
          "Accept: application/vnd.github.v3.diff",
          `repos/${input.pr.owner}/${input.pr.repo}/compare/${input.snapshot.baseSha}...${input.snapshot.headSha}`,
        ],
        timeoutMs: commandTimeoutMs,
      });
      return exact._tag === "ok"
        ? exact
        : commandFailure("get_diff", exact.error);
    }

    const response = await this.commands.runText({
      argv: [
        "gh",
        "pr",
        "diff",
        String(input.pr.number),
        "--repo",
        `${input.profile.githubHost}/${input.pr.owner}/${input.pr.repo}`,
        "--patch",
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "ok" && response.value.length > 0) return response;
    if (
      response._tag === "err" &&
      response.error._tag === "CommandAuthenticationRequired"
    ) {
      return commandFailure("get_diff", response.error);
    }
    return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
  }

  async getFileContents(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly sha: GitSha;
    readonly path: RepoRelativePath;
  }): Promise<Result<GitHubFileContents, GitHubReadFailure>> {
    const encodedPath = input.path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const response = await this.commands.runJson({
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/contents/${encodedPath}?ref=${input.sha}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return commandFailure("get_file", response.error);
    const parsed = v.safeParse(repositoryFileSchema, response.value);
    if (!parsed.success || parsed.output.type !== "file") return invalid("get_file");
    if ((parsed.output.size ?? 0) > maxHydratedFileBytes) {
      return ok({ state: "too_large" });
    }
    if (parsed.output.encoding !== "base64" || parsed.output.content === undefined) {
      return err({ _tag: "GitHubReadFailed", operation: "get_file" });
    }
    const contents = Buffer.from(
      parsed.output.content.replaceAll("\n", ""),
      "base64",
    );
    if (contents.byteLength > maxHydratedFileBytes) {
      return ok({ state: "too_large" });
    }
    if (contents.includes(0)) return ok({ state: "binary" });
    return ok({ state: "available", contents: contents.toString("utf8") });
  }

  async compareRevisions(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly baseSha: GitSha;
    readonly headSha: GitSha;
    readonly baseSessionId: ReviewSessionId;
  }): Promise<Result<GitHubRevisionComparison, GitHubReadFailure>> {
    const endpoint = `repos/${input.pr.owner}/${input.pr.repo}/compare/${input.baseSha}...${input.headSha}`;
    const metadata = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, endpoint],
      timeoutMs: commandTimeoutMs,
    });
    if (metadata._tag === "err") return commandFailure("compare_revisions", metadata.error);
    const comparison = parseGitHubComparison(metadata.value, input);
    if (comparison === undefined) return invalid("compare_revisions");
    if (comparison.completeness === "incomplete") return ok({ comparison });
    const patch = await this.commands.runText({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "-H", "Accept: application/vnd.github.v3.diff", endpoint],
      timeoutMs: commandTimeoutMs,
    });
    if (patch._tag === "err") return commandFailure("compare_revisions", patch.error);
    return patch.value.length === 0
      ? ok({ comparison: { ...comparison, completeness: "incomplete" } })
      : ok({ comparison, patch: patch.value });
  }

  async resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>> {
    const response = await this.commands.runText({
      // `gh auth status` exits nonzero if any stale, inactive account is
      // invalid, even when the configured active account can make API calls.
      // Ask GitHub who this invocation can actually authenticate as instead.
      argv: [
        "gh",
        "api",
        "--hostname",
        profile.githubHost,
        "user",
        "--jq",
        ".login",
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (
      response._tag === "err" ||
      response.value.trim() !== profile.ghAccount
    ) {
      return err({
        _tag: "GitHubAuthenticationFailed",
        operation: "auth_status",
      });
    }
    return ok({ host: profile.githubHost, account: profile.ghAccount });
  }

  async createPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly summaryBody: string;
    readonly comments: ReadonlyArray<PendingReviewComment>;
  }): Promise<Result<{ readonly reviewId: string; readonly state: "PENDING" }, GitHubWriteFailure>> {
    if (input.comments.length === 0)
      return err({ _tag: "GitHubWriteFailure", category: "rejected", message: "No postable comments are selected." });
    const response = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "POST", `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews`, "--input", "-"],
      stdin: JSON.stringify({
        commit_id: input.headSha,
        body: input.summaryBody,
        comments: input.comments.map(toGitHubReviewComment),
      }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const pending = parsePendingReview(response.value);
    return pending === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not return a PENDING review." })
      : ok(pending);
  }

  async submitPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: string;
    readonly event: GitHubReviewEvent;
    readonly summaryBody: string;
  }): Promise<Result<{ readonly reviewId: string }, GitHubWriteFailure>> {
    const response = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "POST", `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews/${input.reviewId}/events`, "--input", "-"],
      stdin: JSON.stringify({ event: input.event, body: input.summaryBody }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const reviewId = parseReviewId(response.value);
    return reviewId === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not return a submitted review ID." })
      : ok({ reviewId });
  }

  async createThreadReply(input: { readonly profile: WorkspaceProfileConfig; readonly threadId: GitHubThreadId; readonly body: string }): Promise<Result<{ readonly commentId: string }, GitHubWriteFailure>> {
    const response = await this.commands.runJson({ argv: ["gh", "api", "graphql", "--hostname", input.profile.githubHost, "-f", "query=mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}", "-F", `threadId=${input.threadId}`, "-f", `body=${input.body}`], timeoutMs: commandTimeoutMs });
    if (response._tag === "err") return err(writeFailure(response.error));
    const commentId = nestedString(response.value, ["data", "addPullRequestReviewThreadReply", "comment", "id"]);
    return typeof commentId === "string" && commentId.length > 0 ? ok({ commentId }) : err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not return a reply ID." });
  }

  async setReviewThreadState(input: { readonly profile: WorkspaceProfileConfig; readonly threadId: GitHubThreadId; readonly state: "resolved" | "open" }): Promise<Result<void, GitHubWriteFailure>> {
    const mutation = input.state === "resolved" ? "resolveReviewThread" : "unresolveReviewThread";
    const response = await this.commands.runJson({ argv: ["gh", "api", "graphql", "--hostname", input.profile.githubHost, "-f", `query=mutation($threadId:ID!){${mutation}(input:{threadId:$threadId}){thread{id}}}`, "-F", `threadId=${input.threadId}`], timeoutMs: commandTimeoutMs });
    return response._tag === "err" ? err(writeFailure(response.error)) : ok(undefined);
  }

  async mergePullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly method: "merge" | "squash" | "rebase";
  }): Promise<Result<{ readonly mergeCommitSha?: GitSha }, GitHubWriteFailure>> {
    const response = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "PUT", `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/merge`, "--input", "-"],
      stdin: JSON.stringify({ sha: input.headSha, merge_method: input.method }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    if (typeof response.value !== "object" || response.value === null || (response.value as { readonly merged?: unknown }).merged !== true)
      return err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not confirm the merge." });
    const rawSha = (response.value as { readonly sha?: unknown }).sha;
    const sha = rawSha === undefined ? undefined : parseGitSha(rawSha);
    return sha !== undefined && sha._tag === "err"
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub returned an invalid merge commit." })
      : ok(sha === undefined ? {} : { mergeCommitSha: sha.value });
  }

  private async verifyFetchedRefs(
    refs: FetchedDiffRefs,
  ): Promise<Result<void, GitHubReadFailure>> {
    const base = await this.resolveFetchedRef(
      refs.repositoryPath,
      refs.baseRef,
    );
    if (base._tag === "err" || base.value !== refs.baseSha) {
      return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
    }
    const head = await this.resolveFetchedRef(
      refs.repositoryPath,
      refs.headRef,
    );
    if (head._tag === "err" || head.value !== refs.headSha) {
      return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
    }
    return ok(undefined);
  }

  private async resolveFetchedRef(
    repositoryPath: AbsolutePath,
    ref: string,
  ): Promise<Result<GitSha, GitHubReadFailure>> {
    const response = await this.commands.runText({
      argv: [
        "git",
        "-C",
        repositoryPath,
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${ref}^{commit}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") {
      return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
    }
    const sha = parseGitSha(response.value.trim());
    return sha._tag === "ok"
      ? sha
      : err({ _tag: "GitHubReadFailed", operation: "get_diff" });
  }
}

/** A fixture-oriented GitHubReader with no process, filesystem, or network behavior. */
export class FakeGitHubAdapter implements GitHubReader, GitHubReviewWriter, GitHubMergeWriter {
  constructor(private readonly values: Partial<FakeGitHubAdapterValues>) {}

  async listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>> {
    void input;
    return this.values.listOpenPullRequests === undefined
      ? missing("list_open_prs")
      : ok(this.values.listOpenPullRequests);
  }

  async listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<MaintainerPullRequestListing, GitHubReadFailure>> {
    void input;
    if (this.values.maintainerPullRequests !== undefined)
      return ok(this.values.maintainerPullRequests);
    if (this.values.listOpenPullRequests === undefined)
      return missing("list_maintainer_prs");
    return ok({
      pullRequests: this.values.listOpenPullRequests.map((summary) => ({
        summary,
        checks: this.values.checks ?? { overall: "unknown", checks: [] },
      })),
      complete: true,
    });
  }

  async getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>> {
    void input;
    return this.values.pullRequest === undefined
      ? missing("get_pr")
      : ok(this.values.pullRequest);
  }

  async getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>> {
    void input;
    return this.values.comments === undefined
      ? missing("get_comments")
      : ok(this.values.comments);
  }

  async getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>> {
    void input;
    return this.values.checks === undefined
      ? missing("get_checks")
      : ok(this.values.checks);
  }

  async getPullRequestDiff(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly fetchedRefs?: FetchedDiffRefs;
    readonly snapshot?: { readonly baseSha: GitSha; readonly headSha: GitSha };
  }): Promise<Result<string, GitHubReadFailure>> {
    void input;
    return this.values.diff === undefined
      ? missing("get_diff")
      : ok(this.values.diff);
  }

  async getFileContents(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly sha: GitSha;
    readonly path: RepoRelativePath;
  }): Promise<Result<GitHubFileContents, GitHubReadFailure>> {
    void input;
    return this.values.fileContents === undefined
      ? missing("get_file")
      : ok(this.values.fileContents);
  }

  async compareRevisions(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly baseSha: GitSha;
    readonly headSha: GitSha;
    readonly baseSessionId: ReviewSessionId;
  }): Promise<Result<GitHubRevisionComparison, GitHubReadFailure>> {
    void input;
    return this.values.comparison === undefined
      ? missing("compare_revisions")
      : ok(this.values.comparison);
  }

  async resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>> {
    void profile;
    return this.values.authenticatedAccount === undefined
      ? missing("auth_status")
      : ok(this.values.authenticatedAccount);
  }

  async createPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly summaryBody: string;
    readonly comments: ReadonlyArray<PendingReviewComment>;
  }): Promise<Result<{ readonly reviewId: string; readonly state: "PENDING" }, GitHubWriteFailure>> {
    void input;
    return this.values.pendingReview === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "Missing pending review fixture." })
      : ok(this.values.pendingReview);
  }

  async submitPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: string;
    readonly event: GitHubReviewEvent;
    readonly summaryBody: string;
  }): Promise<Result<{ readonly reviewId: string }, GitHubWriteFailure>> {
    void input;
    return this.values.submittedReview === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "Missing submitted review fixture." })
      : ok(this.values.submittedReview);
  }

  async mergePullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly method: "merge" | "squash" | "rebase";
  }): Promise<Result<{ readonly mergeCommitSha?: GitSha }, GitHubWriteFailure>> {
    void input;
    return this.values.mergeResult === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "Missing merge fixture." })
      : ok(this.values.mergeResult);
  }
}

/** Fixture values accepted by FakeGitHubAdapter. */
export type FakeGitHubAdapterValues = {
  readonly listOpenPullRequests: ReadonlyArray<PullRequestSummary>;
  readonly maintainerPullRequests: MaintainerPullRequestListing;
  readonly pullRequest: PullRequestSummary;
  readonly comments: GitHubComments;
  readonly checks: CheckSummary;
  readonly diff: string;
  readonly fileContents: GitHubFileContents;
  readonly comparison: GitHubRevisionComparison;
  readonly authenticatedAccount: AuthenticatedGitHubAccount;
  readonly pendingReview: { readonly reviewId: string; readonly state: "PENDING" };
  readonly submittedReview: { readonly reviewId: string };
  readonly mergeResult: { readonly mergeCommitSha?: GitSha };
};

function parseMaintainerPullRequest(
  input: v.InferOutput<typeof maintainerInboxResponseSchema>["data"]["repository"]["pullRequests"]["nodes"][number],
  host: GitHubHost,
  owner: GitHubOwner,
  repo: GitHubRepoName,
): Result<MaintainerPullRequest, { readonly _tag: "Invalid" }> {
  const number = parsePullRequestNumber(input.number);
  const headSha = parseGitSha(input.headRefOid);
  const baseSha =
    input.baseRefOid === undefined
      ? undefined
      : parseGitSha(input.baseRefOid);
  const updatedAt = parseGitHubTimestamp(input.updatedAt);
  if (
    number._tag === "err" ||
    headSha._tag === "err" ||
    (baseSha !== undefined && baseSha._tag === "err") ||
    updatedAt._tag === "err"
  )
    return err({ _tag: "Invalid" });
  const summary: PullRequestSummary = {
    ref: { host, owner, repo, number: number.value },
    title: input.title,
    author: input.author?.login ?? "ghost",
    headBranch: input.headRefName,
    baseBranch: input.baseRefName,
    headSha: headSha.value,
    ...(baseSha === undefined ? {} : { baseSha: baseSha.value }),
    isDraft: input.isDraft,
    isOpen: true,
    reviewState: mapReviewDecision(input.reviewDecision),
    mergeability: mapMergeability(input.mergeable),
    labels: [],
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
  const rollup = input.commits.nodes[0]?.commit.statusCheckRollup?.state;
  return ok({ summary, checks: rollupCheckSummary(rollup) });
}

function parseGitHubComparison(
  input: unknown,
  expected: {
    readonly baseSessionId: ReviewSessionId;
    readonly baseSha: GitSha;
    readonly headSha: GitSha;
  },
): RevisionComparison | undefined {
  if (!isObject(input)) return undefined;
  const baseSha = readSha(input.base_commit);
  const headSha = readSha(input.head_commit);
  const createdAt = typeof input.created_at === "string" ? parseGitHubTimestamp(input.created_at) : undefined;
  if (baseSha !== expected.baseSha || headSha !== expected.headSha || createdAt === undefined || createdAt._tag === "err" || !Array.isArray(input.files) || !Array.isArray(input.commits)) return undefined;
  const files = input.files.map(parseComparedFile);
  const commits = input.commits.map(parseComparedCommit);
  if (files.some((file) => file === undefined) || commits.some((commit) => commit === undefined)) return undefined;
  const safeFiles = files.filter((file): file is NonNullable<typeof file> => file !== undefined);
  const safeCommits = commits.filter((commit): commit is NonNullable<typeof commit> => commit !== undefined);
  const additions = safeFiles.reduce((total, file) => total + file.additions, 0);
  const deletions = safeFiles.reduce((total, file) => total + file.deletions, 0);
  return {
    schemaVersion: 1,
    baseSessionId: expected.baseSessionId,
    baseHeadSha: expected.baseSha,
    headSha: expected.headSha,
    ancestry: input.status === "ahead" ? "fast_forward" : "rewritten",
    source: "github",
    // GitHub's comparison file list is capped. Refuse to call a cap-sized list complete.
    completeness: safeFiles.length >= 300 ? "incomplete" : "complete",
    commits: safeCommits,
    files: safeFiles,
    additions,
    deletions,
    createdAt: createdAt.value,
  };
}

function parseComparedFile(input: unknown): RevisionComparison["files"][number] | undefined {
  if (!isObject(input) || typeof input.filename !== "string" || typeof input.status !== "string" || !isNonNegativeInteger(input.additions) || !isNonNegativeInteger(input.deletions)) return undefined;
  const status = input.status === "added" || input.status === "modified" || input.status === "deleted" || input.status === "renamed" || input.status === "copied" ? input.status : "unknown";
  const oldPath = typeof input.previous_filename === "string" ? input.previous_filename : undefined;
  const textPatchAvailable = typeof input.patch === "string";
  return { path: input.filename, ...(oldPath === undefined ? {} : { oldPath }), status, additions: input.additions, deletions: input.deletions, binary: !textPatchAvailable, textPatchAvailable };
}

function parseComparedCommit(input: unknown): RevisionComparison["commits"][number] | undefined {
  if (!isObject(input) || typeof input.sha !== "string" || !isObject(input.commit) || typeof input.commit.message !== "string" || !isObject(input.commit.author) || typeof input.commit.author.name !== "string" || typeof input.commit.author.date !== "string") return undefined;
  const sha = parseGitSha(input.sha);
  const authoredAt = parseGitHubTimestamp(input.commit.author.date);
  if (sha._tag === "err" || authoredAt._tag === "err") return undefined;
  return { sha: sha.value, subject: input.commit.message.split("\n", 1)[0] ?? "", author: input.commit.author.name, authoredAt: authoredAt.value };
}

function readSha(input: unknown): GitSha | undefined {
  if (!isObject(input)) return undefined;
  const sha = parseGitSha(input.sha);
  return sha._tag === "ok" ? sha.value : undefined;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function nestedString(input: unknown, keys: ReadonlyArray<string>): string | undefined {
  let value: unknown = input;
  for (const key of keys) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  return typeof value === "string" ? value : undefined;
}

function isNonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}

function mapReviewDecision(value: string | null | undefined): PullRequestSummary["reviewState"] {
  switch (value) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes_requested";
    case "REVIEW_REQUIRED": return "review_pending";
    case null:
    case undefined: return "none";
    default: return "unknown";
  }
}

function rollupCheckSummary(value: string | undefined): CheckSummary {
  switch (value) {
    case "SUCCESS": return { overall: "passing", checks: [] };
    case "FAILURE":
    case "ERROR":
    case "EXPECTED": return { overall: "failing", checks: [] };
    case "PENDING": return { overall: "pending", checks: [] };
    default: return { overall: "unknown", checks: [] };
  }
}

function parsePullRequest(
  input: unknown,
  host: GitHubHost,
  owner: GitHubOwner,
  repo: GitHubRepoName,
):
  | Result<PullRequestSummary, never>
  | Result<never, { readonly _tag: "Invalid" }> {
  const parsed = v.safeParse(pullRequestSchema, input);
  if (!parsed.success) return err({ _tag: "Invalid" });
  const number = parsePullRequestNumber(parsed.output.number);
  const headSha = parseGitSha(parsed.output.head.sha);
  const baseSha =
    parsed.output.base.sha === undefined
      ? undefined
      : parseGitSha(parsed.output.base.sha);
  const updatedAt = parseGitHubTimestamp(parsed.output.updated_at);
  if (
    number._tag === "err" ||
    headSha._tag === "err" ||
    (baseSha !== undefined && baseSha._tag === "err") ||
    updatedAt._tag === "err"
  )
    return err({ _tag: "Invalid" });

  const summary: PullRequestSummary = {
    ref: { host, owner, repo, number: number.value },
    title: parsed.output.title,
    ...(parsed.output.body === undefined || parsed.output.body === null
      ? {}
      : { description: parsed.output.body }),
    author: parsed.output.user.login,
    headBranch: parsed.output.head.ref,
    baseBranch: parsed.output.base.ref,
    headSha: headSha.value,
    ...(baseSha === undefined ? {} : { baseSha: baseSha.value }),
    isDraft: parsed.output.draft,
    isOpen: parsed.output.state === "open",
    reviewState: "unknown",
    mergeability: mapMergeability(parsed.output.mergeable_state),
    labels: (parsed.output.labels ?? []).map((label) => label.name),
    ...(parsed.output.requested_reviewers === undefined
      ? {}
      : {
          requestedReviewers: parsed.output.requested_reviewers.map(
            (reviewer) => reviewer.login,
          ),
        }),
    ...(parsed.output.assignees === undefined
      ? {}
      : {
          assignees: parsed.output.assignees.map((assignee) => assignee.login),
        }),
    updatedAt: updatedAt.value,
    ...(parsed.output.changed_files === undefined
      ? {}
      : { changedFileCount: parsed.output.changed_files }),
    ...(parsed.output.additions === undefined
      ? {}
      : { additions: parsed.output.additions }),
    ...(parsed.output.deletions === undefined
      ? {}
      : { deletions: parsed.output.deletions }),
  };
  return ok(summary);
}

function parseComment(
  input: v.InferOutput<
    typeof threadResponseSchema
  >["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][number]["comments"]["nodes"][number],
): Result<GitHubComment, { readonly _tag: "Invalid" }> {
  const createdAt = parseGitHubTimestamp(input.createdAt);
  const updatedAt =
    input.updatedAt === null || input.updatedAt === undefined
      ? undefined
      : parseGitHubTimestamp(input.updatedAt);
  if (
    createdAt._tag === "err" ||
    (updatedAt !== undefined && updatedAt._tag === "err")
  )
    return err({ _tag: "Invalid" });

  const location = parseLocation(
    input.path,
    input.line,
    input.originalLine,
    input.startLine,
    input.side,
    input.startSide,
  );
  const comment: GitHubComment = {
    id: input.id,
    author: input.author?.login ?? "ghost",
    body: input.body,
    createdAt: createdAt.value,
    ...(updatedAt === undefined ? {} : { updatedAt: updatedAt.value }),
    ...(input.url === null || input.url === undefined
      ? {}
      : { url: input.url }),
    ...(location === undefined ? {} : { location }),
  };
  return ok(comment);
}

function parseLocation(
  path: string | null | undefined,
  line: number | null | undefined,
  originalLine: number | null | undefined,
  startLine: number | null | undefined,
  diffSide: string | null | undefined,
  startSide: string | null | undefined,
): GitHubComment["location"] {
  if (path === null || path === undefined) return undefined;
  const parsedPath = parseRepoRelativePath(path);
  if (parsedPath._tag === "err") return undefined;
  const selectedLine =
    line === null || line === undefined
      ? originalLine === null || originalLine === undefined
        ? undefined
        : originalLine
      : line;
  return {
    path: parsedPath.value,
    ...(selectedLine === undefined
      ? {}
      : startLine === null || startLine === undefined
        ? { line: selectedLine }
        : { line: startLine, lineEnd: selectedLine }),
    ...(diffSide === "RIGHT"
      ? { diffSide: "new" as const }
      : diffSide === "LEFT" || startSide === "LEFT"
        ? { diffSide: "old" as const }
        : startSide === "RIGHT"
          ? { diffSide: "new" as const }
          : {}),
  };
}

function toCheckRunSummary(
  input: v.InferOutput<typeof checkRunsSchema>["check_runs"][number],
): CheckRunSummary {
  const conclusion = mapCheckConclusion(input.conclusion);
  return {
    name: input.name,
    required: "unknown",
    status: mapCheckStatus(input.status),
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(input.details_url === null || input.details_url === undefined
      ? {}
      : { url: input.details_url }),
  };
}

function mapMergeability(
  value: string | undefined,
): PullRequestSummary["mergeability"] {
  if (value === "clean" || value === "MERGEABLE") return "mergeable";
  if (value === "dirty" || value === "CONFLICTING") return "conflicting";
  if (value === "blocked" || value === "BLOCKED") return "blocked";
  return "unknown";
}

function mapCheckStatus(value: string): CheckRunSummary["status"] {
  if (value === "queued" || value === "in_progress" || value === "completed")
    return value;
  return "unknown";
}

function mapCheckConclusion(
  value: string | null | undefined,
): CheckRunSummary["conclusion"] {
  if (
    value === "success" ||
    value === "failure" ||
    value === "cancelled" ||
    value === "timed_out" ||
    value === "skipped" ||
    value === "neutral"
  )
    return value;
  return undefined;
}

function overallCheckStatus(
  checks: ReadonlyArray<CheckRunSummary>,
): CheckSummary["overall"] {
  if (checks.length === 0) return "unknown";
  if (checks.some((check) => check.status !== "completed")) return "pending";
  if (
    checks.some(
      (check) =>
        check.conclusion === "failure" ||
        check.conclusion === "cancelled" ||
        check.conclusion === "timed_out",
    )
  )
    return "failing";
  if (checks.every((check) => check.conclusion === "skipped")) return "skipped";
  if (
    checks.every(
      (check) =>
        check.conclusion === "success" ||
        check.conclusion === "neutral" ||
        check.conclusion === "skipped",
    )
  )
    return "passing";
  return "unknown";
}

function parseGitHubTimestamp(
  input: string,
): ReturnType<typeof parseIsoTimestamp> {
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input)
    ? `${input.slice(0, -1)}.000Z`
    : input;
  return parseIsoTimestamp(normalized);
}

function commandFailure(
  operation: GitHubReadOperation,
  failure: CommandFailure,
): Result<never, GitHubReadFailure> {
  return failure._tag === "CommandAuthenticationRequired"
    ? err({ _tag: "GitHubAuthenticationFailed", operation })
    : err({ _tag: "GitHubReadFailed", operation });
}

function toGitHubReviewComment(comment: PendingReviewComment): Record<string, unknown> {
  const side = comment.diffSide === "new" ? "RIGHT" : "LEFT";
  return {
    path: comment.path,
    line: comment.lineEnd ?? comment.line,
    side,
    body: comment.body,
    ...(comment.lineEnd === undefined
      ? {}
      : { start_line: comment.line, start_side: side }),
  };
}

function parseReviewId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("id" in input)) return undefined;
  const value = (input as { readonly id: unknown }).id;
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))
    ? String(value)
    : undefined;
}

function parsePendingReview(input: unknown): { readonly reviewId: string; readonly state: "PENDING" } | undefined {
  const reviewId = parseReviewId(input);
  if (reviewId === undefined || typeof input !== "object" || input === null) return undefined;
  return (input as { readonly state?: unknown }).state === "PENDING"
    ? { reviewId, state: "PENDING" }
    : undefined;
}

function writeFailure(failure: CommandFailure): GitHubWriteFailure {
  if (failure._tag === "CommandAuthenticationRequired")
    return { _tag: "GitHubWriteFailure", category: "auth", message: "GitHub authentication is required." };
  if (failure._tag === "CommandFailed")
    return { _tag: "GitHubWriteFailure", category: "rejected", message: "GitHub rejected the review request." };
  return { _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub review request could not be confirmed." };
}

function invalid(
  operation: GitHubReadOperation,
): Result<never, GitHubReadFailure> {
  return err({ _tag: "GitHubResponseInvalid", operation });
}

function missing(
  operation: GitHubReadOperation,
): Result<never, GitHubReadFailure> {
  return err({ _tag: "GitHubReadFailed", operation });
}

function isManagedFetchedRef(value: string): boolean {
  return (
    /^refs\/patchdesk\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//")
  );
}
