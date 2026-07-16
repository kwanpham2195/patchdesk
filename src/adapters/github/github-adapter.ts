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
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseRepoRelativePath,
  type AbsolutePath,
  type GitSha,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
} from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";

const commandTimeoutMs = 15_000;
const threadQuery =
  "query PullRequestThreads($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved isOutdated comments(first: 100) { nodes { id body createdAt updatedAt url author { login } path line originalLine diffSide } } } } } } }";

const pullRequestSchema = v.looseObject({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.string(),
  state: v.picklist(["open", "closed"]),
  draft: v.boolean(),
  head: v.looseObject({ ref: v.string(), sha: v.string() }),
  base: v.looseObject({ ref: v.string() }),
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
                    diffSide: v.optional(v.nullable(v.string())),
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

/** The typed read-only operations product code may request from GitHub. */
export interface GitHubReader {
  listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>>;
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
  }): Promise<Result<string, GitHubReadFailure>>;
  resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>>;
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
  | "get_pr"
  | "get_comments"
  | "get_checks"
  | "get_diff"
  | "auth_status";

/**
 * GitHub CLI external adapter. It owns all gh execution and returns parsed, safe projections.
 * It has no GitHub write operation.
 */
export class GitHubAdapter implements GitHubReader {
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
      threads.push({
        id: rawThread.id,
        state: rawThread.isResolved
          ? "resolved"
          : rawThread.isOutdated
            ? "outdated"
            : "open",
        comments,
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
  }): Promise<Result<string, GitHubReadFailure>> {
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
    if (input.fetchedRefs === undefined)
      return err({ _tag: "GitHubReadFailed", operation: "get_diff" });

    const fetchedRefs = await this.verifyFetchedRefs(input.fetchedRefs);
    if (fetchedRefs._tag === "err") return fetchedRefs;

    const fallback = await this.commands.runText({
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
    return fallback._tag === "ok"
      ? fallback
      : commandFailure("get_diff", fallback.error);
  }

  async resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>> {
    const response = await this.commands.runText({
      argv: ["gh", "auth", "status", "--hostname", profile.githubHost],
      timeoutMs: commandTimeoutMs,
    });
    if (
      response._tag === "err" ||
      !statusHasActiveAccount(response.value, profile.ghAccount)
    ) {
      return err({
        _tag: "GitHubAuthenticationFailed",
        operation: "auth_status",
      });
    }
    return ok({ host: profile.githubHost, account: profile.ghAccount });
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
export class FakeGitHubAdapter implements GitHubReader {
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
  }): Promise<Result<string, GitHubReadFailure>> {
    void input;
    return this.values.diff === undefined
      ? missing("get_diff")
      : ok(this.values.diff);
  }

  async resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>> {
    void profile;
    return this.values.authenticatedAccount === undefined
      ? missing("auth_status")
      : ok(this.values.authenticatedAccount);
  }
}

/** Fixture values accepted by FakeGitHubAdapter. */
export type FakeGitHubAdapterValues = {
  readonly listOpenPullRequests: ReadonlyArray<PullRequestSummary>;
  readonly pullRequest: PullRequestSummary;
  readonly comments: GitHubComments;
  readonly checks: CheckSummary;
  readonly diff: string;
  readonly authenticatedAccount: AuthenticatedGitHubAccount;
};

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
  const updatedAt = parseGitHubTimestamp(parsed.output.updated_at);
  if (
    number._tag === "err" ||
    headSha._tag === "err" ||
    updatedAt._tag === "err"
  )
    return err({ _tag: "Invalid" });

  const summary: PullRequestSummary = {
    ref: { host, owner, repo, number: number.value },
    title: parsed.output.title,
    author: parsed.output.user.login,
    headBranch: parsed.output.head.ref,
    baseBranch: parsed.output.base.ref,
    headSha: headSha.value,
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
    input.diffSide,
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
  diffSide: string | null | undefined,
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
    ...(selectedLine === undefined ? {} : { line: selectedLine }),
    ...(diffSide === "RIGHT"
      ? { diffSide: "new" as const }
      : diffSide === "LEFT"
        ? { diffSide: "old" as const }
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
  if (value === "clean") return "mergeable";
  if (value === "dirty") return "conflicting";
  if (value === "blocked") return "blocked";
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

function statusHasActiveAccount(status: string, account: string): boolean {
  const escapedAccount = account.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const configuredAccount = new RegExp(
    `\\baccount\\s+${escapedAccount}(?:\\s|$)`,
    "i",
  );
  let selectedAccountIsConfigured = false;

  for (const line of status.split(/\r?\n/)) {
    if (/\baccount\s+\S+/i.test(line)) {
      selectedAccountIsConfigured = configuredAccount.test(line);
      continue;
    }
    if (
      selectedAccountIsConfigured &&
      /\bActive account:\s*true\b/i.test(line)
    ) {
      return true;
    }
  }

  return false;
}
