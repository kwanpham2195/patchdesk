import * as v from "valibot";

import type { CommandFailure, ForbiddenReason } from "./command-runner";
import type { IsoTimestamp } from "../../domain/ids";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import { parseGitHubTimestamp } from "./github-wire-projections";
import type {
  GitHubGraphQlRequest,
  GitHubRequest,
  GitHubRestRequest,
} from "./github-request";
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
  | "list_repository_branches"
  | "get_pull_request_reviewers"
  | "get_pr"
  | "get_watched_prs"
  | "get_merge_policy"
  | "get_merge_policy_evidence"
  | "get_comments"
  | "get_issue_comments"
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

/** Wall-clock budget for one GitHub API call or one git child, shared by every GitHub module. */
export const commandTimeoutMs = 15_000;

/**
 * The HTTP transport a request is served through, narrowed to the three calls
 * the runner makes of it. `GitHubHttpClient` satisfies it; a test supplies its
 * own.
 */
export interface GitHubServedTransport {
  rest(
    profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<unknown, CommandFailure>>;
  /** The response bytes, unparsed, as `ghText`'s callers read them. */
  restText(
    profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<string, CommandFailure>>;
  graphql(
    profile: WorkspaceProfileConfig,
    request: GitHubGraphQlRequest,
  ): Promise<Result<unknown, CommandFailure>>;
}

/**
 * Sends every request the GitHub adapter makes over HTTPS as the profile's own
 * account, and classifies what comes back (ADR 0046, issue #276).
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

  constructor(private readonly http: GitHubServedTransport) {}

  /** Run a request that returns JSON as the profile's configured GitHub account. */
  async ghJson(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return request.kind === "rest"
      ? this.http.rest(profile, request)
      : this.http.graphql(profile, request);
  }

  /** Run a request that returns text as the profile's configured GitHub account. */
  async ghText(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<string, CommandFailure>> {
    return request.kind === "rest"
      ? this.http.restText(profile, request)
      : asText(await this.http.graphql(profile, request));
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

  /**
   * Whether the last response from `host` spent its whole rate limit and the
   * reset is still ahead of `now`, so a background read can wait without
   * asking GitHub.
   */
  exhaustedRateLimit(
    host: string,
    now: IsoTimestamp,
  ): IsoTimestamp | undefined {
    const cached = this.rateLimitByHost.get(host);
    return cached !== undefined &&
      cached.remaining === 0 &&
      cached.resetAt > now
      ? cached.resetAt
      : undefined;
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

/**
 * A GraphQL answer narrowed to the response bytes `ghText`'s callers read.
 * Every REST text caller takes `restText`, which hands those bytes over
 * unparsed; a GraphQL document read as text would arrive here already parsed,
 * so the read fails rather than silently changing shape.
 */
function asText(
  response: Result<unknown, CommandFailure>,
): Result<string, CommandFailure> {
  if (response._tag === "err") return response;
  const text = v.safeParse(v.string(), response.value);
  return text.success ? ok(text.output) : err({ _tag: "CommandFailed" });
}
