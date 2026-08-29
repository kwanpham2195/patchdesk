import type {
  CommandFailure,
  CommandRequest,
  CommandRunner,
  ForbiddenReason,
} from "./command-runner";
import {
  GitHubCliCredentials,
  type GitHubCredentials,
} from "./github-credentials";
import type { IsoTimestamp } from "../../domain/ids";
import { err, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import { parseGitHubTimestamp } from "./github-wire-projections";
import type { MaintainerRateLimit } from "./github-wire-schemas";

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
    }
  | {
      readonly _tag: "GitHubRateLimited";
      readonly operation: GitHubReadOperation;
      readonly resumeAt?: IsoTimestamp;
    }
  | {
      readonly _tag: "GitHubForbidden";
      readonly operation: GitHubReadOperation;
      readonly reason: ForbiddenReason;
    };

export type GitHubReadOperation =
  | "list_open_prs"
  | "list_maintainer_prs"
  | "search_maintainer_prs"
  | "list_repository_labels"
  | "list_assignable_users"
  | "get_pull_request_reviewers"
  | "get_pr"
  | "get_merge_policy"
  | "get_merge_policy_evidence"
  | "get_comments"
  | "get_reviews"
  | "get_pending_review"
  | "get_direct_summary_reviews"
  | "load_conversation"
  | "get_repository_permission"
  | "get_branch_protection"
  | "get_pr_commits"
  | "get_checks"
  | "get_diff"
  | "get_file"
  | "compare_revisions"
  | "get_thread_target"
  | "get_comment_target"
  | "auth_status";

/** A gh invocation whose account environment the runner supplies from the profile. */
export type GhCommandRequest = Omit<
  CommandRequest,
  "environment" | "inheritEnvironment"
>;

/**
 * Runs every gh invocation the GitHub adapter makes, as the profile's own
 * account, and classifies what comes back.
 *
 * It owns the one piece of state that outlives a single call: the
 * last-observed rate limit per host, learned opportunistically from
 * maintainer inbox responses and consulted when a later failure on the same
 * host has to be explained. That is why the runner is a collaborator rather
 * than a set of free functions -- the cache and the classification that reads
 * it belong together.
 */
export class GhRequestRunner {
  /**
   * Last-observed rateLimit { remaining, resetAt } per GitHub host, learned
   * opportunistically from the maintainerInboxQuery response on every
   * successful poll. Consulted when classifying a later CommandRateLimited
   * failure on the same host so the resume time can be surfaced proactively.
   */
  private readonly rateLimitByHost = new Map<
    string,
    { readonly remaining: number; readonly resetAt: IsoTimestamp }
  >();

  constructor(
    private readonly commands: CommandRunner,
    private readonly credentials: GitHubCredentials = new GitHubCliCredentials(
      commands,
    ),
  ) {}

  /** Run a gh command that returns JSON as the profile's configured GitHub account. */
  async ghJson(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.runAsProfileAccount(profile, request, (input) =>
      this.commands.runJson(input),
    );
  }

  /** Run a gh command that returns text as the profile's configured GitHub account. */
  async ghText(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
  ): Promise<Result<string, CommandFailure>> {
    return this.runAsProfileAccount(profile, request, (input) =>
      this.commands.runText(input),
    );
  }

  async runAsProfileAccount<T>(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
    run: (input: CommandRequest) => Promise<Result<T, CommandFailure>>,
  ): Promise<Result<T, CommandFailure>> {
    const environment = await this.credentials.environmentFor(profile);
    if (environment._tag === "err") return environment;
    const response = await run({ ...request, environment: environment.value });
    if (
      response._tag === "err" &&
      response.error._tag === "CommandAuthenticationRequired"
    ) {
      this.credentials.forget(profile);
    }
    return response;
  }

  /**
   * Classify a failed CommandFailure into a GitHubReadFailure. A rate-limited
   * failure carries the last-observed resetAt for `host` when one is cached
   * (see rateLimitByHost); when the cache is cold, resumeAt is left undefined
   * and a fallback delay is applied at the point that schedules the wait,
   * not baked in here.
   */
  commandFailure(
    operation: GitHubReadOperation,
    failure: CommandFailure,
    host: string,
  ): Result<never, GitHubReadFailure> {
    if (failure._tag === "CommandAuthenticationRequired")
      return err({ _tag: "GitHubAuthenticationFailed", operation });
    if (failure._tag === "CommandRateLimited") {
      const cached = this.rateLimitByHost.get(host);
      const resumeAtField =
        cached === undefined ? {} : { resumeAt: cached.resetAt };
      return err({ _tag: "GitHubRateLimited", operation, ...resumeAtField });
    }
    if (failure._tag === "CommandForbidden") {
      return err({
        _tag: "GitHubForbidden",
        operation,
        reason: failure.reason,
      });
    }
    return err({ _tag: "GitHubReadFailed", operation });
  }

  recordRateLimit(host: string, rateLimit: MaintainerRateLimit): void {
    if (rateLimit === undefined) return;
    const resumeAt = parseGitHubTimestamp(rateLimit.resetAt);
    if (resumeAt._tag === "ok")
      this.rateLimitByHost.set(host, {
        remaining: rateLimit.remaining,
        resetAt: resumeAt.value,
      });
  }
}
