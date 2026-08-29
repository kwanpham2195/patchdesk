import * as v from "valibot";

import type { CommandFailure, CommandRunner } from "./command-runner";
import {
  commandTimeoutMs,
  type GhCommandRequest,
  type GhRequestRunner,
  type GitHubReadFailure,
  type GitHubReadOperation,
} from "./gh-request-runner";
import type { CheckSummary } from "../../domain/github-context";
import {
  type AbsolutePath,
  type GitSha,
  parseGitSha,
  type RepoRelativePath,
} from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import {
  checkRunsSchema,
  commitStatusesSchema,
  repositoryFileSchema,
} from "./github-wire-schemas";
import {
  overallCheckStatus,
  toCheckRunSummary,
  toCommitStatusSummary,
} from "./github-wire-projections";
import { invalid } from "./github-write-failures";
import type { FetchedDiffRefs, GitHubFileContents } from "./github-adapter";

// Two source blobs travel through the 2 MiB Electron bridge, so each stays
// below 512 KiB after allowing for JSON framing and multibyte text.
const maxHydratedFileBytes = 512 * 1024;

/**
 * Reads what a pull request changed: its check runs, its unified diff (with
 * the bounded local Git fallback), and one file's contents at a revision.
 */
export class GitHubDiffReader {
  constructor(
    private readonly requests: GhRequestRunner,
    private readonly commands: CommandRunner,
  ) {}

  /** Run a gh command that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.requests.ghJson(profile, request);
  }

  /** Run a gh command that returns text as the profile's configured GitHub account. */
  private async ghText(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
  ): Promise<Result<string, CommandFailure>> {
    return this.requests.ghText(profile, request);
  }

  private commandFailure(
    operation: GitHubReadOperation,
    failure: CommandFailure,
    host: string,
  ): Result<never, GitHubReadFailure> {
    return this.requests.commandFailure(operation, failure, host);
  }

  async getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>> {
    const [checkRunsResponse, statusesResponse] = await Promise.all([
      this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/commits/${input.headSha}/check-runs`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
      this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/commits/${input.headSha}/status`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
    ]);
    if (checkRunsResponse._tag === "err" && statusesResponse._tag === "err")
      return this.commandFailure(
        "get_checks",
        checkRunsResponse.error,
        input.profile.githubHost,
      );
    const checks =
      checkRunsResponse._tag === "ok"
        ? v.safeParse(checkRunsSchema, checkRunsResponse.value)
        : undefined;
    const statuses =
      statusesResponse._tag === "ok"
        ? v.safeParse(commitStatusesSchema, statusesResponse.value)
        : undefined;
    if (checks?.success !== true && statuses?.success !== true)
      return invalid("get_checks");

    const summaries = [
      ...(checks?.success === true
        ? checks.output.check_runs.map(toCheckRunSummary)
        : []),
      ...(statuses?.success === true
        ? statuses.output.statuses.map(toCommitStatusSummary)
        : []),
    ];
    return ok({ overall: overallCheckStatus(summaries), checks: summaries });
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
        : this.commandFailure(
            "get_diff",
            exact.error,
            input.profile.githubHost,
          );
    }

    if (input.snapshot !== undefined) {
      const exact = await this.ghText(input.profile, {
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
        : this.commandFailure(
            "get_diff",
            exact.error,
            input.profile.githubHost,
          );
    }

    const response = await this.ghText(input.profile, {
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
      return this.commandFailure(
        "get_diff",
        response.error,
        input.profile.githubHost,
      );
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
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/contents/${encodedPath}?ref=${input.sha}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_file",
        response.error,
        input.profile.githubHost,
      );
    const parsed = v.safeParse(repositoryFileSchema, response.value);
    if (!parsed.success || parsed.output.type !== "file")
      return invalid("get_file");
    if ((parsed.output.size ?? 0) > maxHydratedFileBytes) {
      return ok({ state: "too_large" });
    }
    if (
      parsed.output.encoding !== "base64" ||
      parsed.output.content === undefined
    ) {
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
