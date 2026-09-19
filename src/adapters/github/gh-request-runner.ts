import * as v from "valibot";

import {
  normalizeCommandLabel,
  type CommandFailure,
  type CommandRequest,
  type CommandRunner,
  type ForbiddenReason,
} from "./command-runner";
import {
  GitHubCliCredentials,
  type GitHubCredentials,
} from "./github-credentials";
import type { IsoTimestamp } from "../../domain/ids";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import { parseGitHubTimestamp } from "./github-wire-projections";
import {
  ghInvocationFor,
  type GitHubGraphQlRequest,
  type GitHubRequest,
  type GitHubRestRequest,
} from "./github-request";
import type { MaintainerRateLimit } from "./github-wire-schemas";
import { isShadowableRead, type TransportShadow } from "./transport-shadow";

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

/** Wall-clock budget for one gh invocation, shared by every GitHub module. */
export const commandTimeoutMs = 15_000;

/**
 * The reads served over HTTPS rather than by a `gh api` child, named by the
 * label `normalizeCommandLabel` prints for them (ADR 0046, issue #276, steps
 * T1a, T1b, and T2). Every label here read clean against gh for a whole
 * shadow window before it was added.
 *
 * This list is the cutover record: T2 extends it as its labels prove clean,
 * and T4 deletes it together with the last `gh api` argv. A GraphQL label is
 * served only when the document is also a query, so naming one here never
 * moves the mutations that share its endpoint.
 */
export const httpServedReadLabels: ReadonlySet<string> = new Set([
  "api GET repos/:owner/:repo/commits/:sha/check-runs",
  "api GET repos/:owner/:repo/commits/:sha/status",
  "api GET repos/:owner/:repo/collaborators/:user/permission",
  "api GET repos/:owner/:repo/branches/:branch/protection",
  "api GET repos/:owner/:repo/branches/:branch/protection/required_status_checks",
  "api GET repos/:owner/:repo/rules/branches/:branch",
  "api GET repos/:owner/:repo/issues/:n/comments",
  "api GET user",
  "api GET repos/:owner/:repo/pulls/:n",
  "api GET repos/:owner/:repo/compare/:range",
  "api GET repos/:owner/:repo/pulls/:n/reviews",
  "api GET repos/:owner/:repo/pulls/:n/comments",
  "api graphql MergePolicy",
  "api graphql PullRequestThreads",
  "api graphql MaintainerInboxSearch",
]);

/**
 * The HTTP transport an allowlisted read is served through, narrowed to the
 * two calls the runner makes of it. `GitHubHttpClient` satisfies it; a test
 * supplies its own.
 */
export interface GitHubServedTransport {
  rest(
    profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<unknown, CommandFailure>>;
  graphql(
    profile: WorkspaceProfileConfig,
    request: GitHubGraphQlRequest,
  ): Promise<Result<unknown, CommandFailure>>;
}

/** A gh invocation whose account environment the runner supplies from the profile. */
export type GhCommandRequest = Omit<
  CommandRequest,
  "environment" | "inheritEnvironment"
>;

/** Every gh call this adapter makes shares the one timeout, so the request never carries it. */
function ghCommandFor(request: GitHubRequest): GhCommandRequest {
  return { ...ghInvocationFor(request), timeoutMs: commandTimeoutMs };
}

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
    /**
     * Compares the HTTP transport against gh for reads when one is supplied
     * (issue #292). It never contributes to the result this returns.
     */
    private readonly shadow?: TransportShadow,
    /**
     * Serves the reads in `httpServedReadLabels` when one is supplied; absent,
     * every read stays on gh. There is no fallback in either direction: an
     * HTTP failure is this call's failure, and gh is not tried after it.
     */
    private readonly http?: GitHubServedTransport,
  ) {}

  /** Run a request that returns JSON as the profile's configured GitHub account. */
  async ghJson(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    const overHttp = this.httpServed(profile, request);
    if (overHttp !== undefined) return overHttp;
    const served = this.runAsProfileAccount(
      profile,
      ghCommandFor(request),
      (input) => this.commands.runJson(input),
    );
    this.shadow?.observe({ profile, request, served, body: "json" });
    return served;
  }

  /** Run a request that returns text as the profile's configured GitHub account. */
  async ghText(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<string, CommandFailure>> {
    const overHttp = this.httpServed(profile, request);
    if (overHttp !== undefined) return asText(await overHttp);
    const served = this.runAsProfileAccount(
      profile,
      ghCommandFor(request),
      (input) => this.commands.runText(input),
    );
    this.shadow?.observe({ profile, request, served, body: "text" });
    return served;
  }

  /**
   * The HTTP transport's answer when this request is one of the reads that
   * has moved off `gh api`, or undefined when it stays on gh. A request served
   * here is not shadowed: the shadow compares the two transports on a read gh
   * is answering, and there is no gh answer left to compare against.
   */
  private httpServed(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<unknown, CommandFailure>> | undefined {
    const http = this.http;
    if (http === undefined) return undefined;
    // Same conservative read predicate the shadow uses: a REST write, a REST
    // body with no method (`gh api --input` defaults to POST), and a GraphQL
    // mutation stay on gh whatever their label normalizes to.
    if (!isShadowableRead(request)) return undefined;
    const label = normalizeCommandLabel(ghInvocationFor(request).argv);
    if (!httpServedReadLabels.has(label)) return undefined;
    return request.kind === "rest"
      ? http.rest(profile, request)
      : http.graphql(profile, request);
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
 * An HTTP answer narrowed to the stdout bytes `ghText`'s callers read. The
 * client answers a non-JSON response as its text, which is what a text read
 * asks for; a JSON body arriving here is a response gh would have handed over
 * verbatim, so the read fails rather than silently changing shape.
 */
function asText(
  response: Result<unknown, CommandFailure>,
): Result<string, CommandFailure> {
  if (response._tag === "err") return response;
  const text = v.safeParse(v.string(), response.value);
  return text.success ? ok(text.output) : err({ _tag: "CommandFailed" });
}
