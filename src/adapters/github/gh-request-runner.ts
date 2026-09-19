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
  isReadRequest,
  restMethodFor,
  type GitHubGraphQlRequest,
  type GitHubRequest,
  type GitHubRestRequest,
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

/** Wall-clock budget for one gh invocation, shared by every GitHub module. */
export const commandTimeoutMs = 15_000;

/**
 * The reads served over HTTPS rather than by a `gh api` child, named by the
 * label `normalizeCommandLabel` prints for them (ADR 0046, issue #276, steps
 * T1a, T1b, and T2). Every label here read clean against gh for a whole
 * comparison window before it was added.
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
  "api GET repos/:owner/:repo/pulls/:n/commits",
  "api graphql MergePolicy",
  "api graphql PullRequestThreads",
  "api graphql MaintainerInboxSearch",
  "api graphql AssignableUsers",
  "api graphql PullRequestReviewers",
  "api graphql RepositoryBranches",
  "api graphql RepositoryLabels",
]);

/**
 * The writes served over HTTPS rather than by a `gh api` child, named by the
 * label the write routing prints for them (ADR 0046, issue #276, step T3).
 * Every REST write here is named by the method GitHub receives rather than the
 * one in the argv, so no write label can ever collide with a read's.
 *
 * A write is only served when the launch also asked for it
 * (`PATCHDESK_GITHUB_WRITES=http`): a write cannot be run twice, so this list
 * is proven by request-shape and failure-classification tests plus one manual
 * live check, not by a comparison window. T4 deletes it together with
 * `httpServedReadLabels`.
 *
 * The three read-back lookups that run inside write flows --
 * `ReviewThreadTarget`, `ReviewCommentTarget`, `ConfirmCreatedCommentThread`
 * -- are queries and belong on neither list until they have read clean.
 */
export const httpServedWriteLabels: ReadonlySet<string> = new Set([
  "api POST repos/:owner/:repo/pulls/:n/reviews",
  "api POST repos/:owner/:repo/pulls/:n/reviews/:n/events",
  "api PUT repos/:owner/:repo/pulls/:n/reviews/:n/dismissals",
  "api DELETE repos/:owner/:repo/pulls/:n/reviews/:n",
  "api PUT repos/:owner/:repo/pulls/:n/merge",
  "api POST repos/:owner/:repo/pulls/:n/comments",
  "api PATCH repos/:owner/:repo/pulls/comments/:n",
  "api DELETE repos/:owner/:repo/pulls/comments/:n",
  "api DELETE repos/:owner/:repo/pulls/:n/requested_reviewers",
  "api graphql addLabelsToLabelable",
  "api graphql removeLabelsFromLabelable",
  "api graphql addAssigneesToAssignable",
  "api graphql removeAssigneesFromAssignable",
  "api graphql requestReviews",
  "api graphql updatePullRequest",
  "api graphql markPullRequestReadyForReview",
  "api graphql convertPullRequestToDraft",
  "api graphql addPullRequestReviewThread",
  "api graphql addPullRequestReviewThreadReply",
  "api graphql resolveReviewThread",
  "api graphql unresolveReviewThread",
  "api graphql updatePullRequestReviewComment",
  "api graphql deletePullRequestReviewComment",
]);

/** Which transport answers one request, decided once per call by `transportRouteFor`. */
export type GitHubTransportRoute = "http_read" | "http_write" | "gh";

/**
 * The transport one request takes. Every request is exactly one of the three:
 * an allowlisted read served over HTTPS, an allowlisted write served over
 * HTTPS once the launch switched writes on, or a `gh api` child.
 *
 * The read gate is `isReadRequest`'s conservative predicate, so a REST write,
 * a REST body with no method, and a GraphQL mutation can never take the read
 * path whatever their label normalizes to.
 */
export function transportRouteFor(
  request: GitHubRequest,
  writesOverHttp: boolean,
): GitHubTransportRoute {
  if (isReadRequest(request)) {
    const label = normalizeCommandLabel(ghInvocationFor(request).argv);
    return httpServedReadLabels.has(label) ? "http_read" : "gh";
  }
  if (!writesOverHttp) return "gh";
  return httpServedWriteLabels.has(writeLabel(request)) ? "http_write" : "gh";
}

/**
 * The label a write is matched against. `normalizeCommandLabel` reads the
 * method off the argv, and `gh api` sends a body-carrying request with no
 * `--method` as a POST, so such a request normalizes to a GET label that could
 * collide with a read's. Naming the method GitHub receives keeps every write
 * label distinct from every read label.
 */
function writeLabel(request: GitHubRequest): string {
  if (request.kind !== "rest")
    return normalizeCommandLabel(ghInvocationFor(request).argv);
  const method = restMethodFor(request);
  const named = method === "GET" ? request : { ...request, method };
  return normalizeCommandLabel(ghInvocationFor(named).argv);
}

/**
 * The HTTP transport an allowlisted request is served through, narrowed to the
 * three calls the runner makes of it. `GitHubHttpClient` satisfies it; a test
 * supplies its own.
 */
export interface GitHubServedTransport {
  rest(
    profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<unknown, CommandFailure>>;
  /** The response bytes, as `gh api`'s stdout reached `runText` (see `ghText`). */
  restText(
    profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<string, CommandFailure>>;
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
     * Serves the reads in `httpServedReadLabels` when one is supplied; absent,
     * every read stays on gh. There is no fallback in either direction: an
     * HTTP failure is this call's failure, and gh is not tried after it.
     */
    private readonly http?: GitHubServedTransport,
    /**
     * Whether the launch also serves the writes in `httpServedWriteLabels`
     * over that transport (issue #276, step T3). Default is gh, because a
     * write cannot be proven by comparison: it is switched on per launch until
     * the live check passes, and the option goes with both allowlists at T4.
     */
    private readonly writesOverHttp: boolean = false,
  ) {}

  /** Run a request that returns JSON as the profile's configured GitHub account. */
  async ghJson(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    const http = this.httpServing(request);
    if (http !== undefined) {
      return request.kind === "rest"
        ? http.rest(profile, request)
        : http.graphql(profile, request);
    }
    return this.runAsProfileAccount(profile, ghCommandFor(request), (input) =>
      this.commands.runJson(input),
    );
  }

  /** Run a request that returns text as the profile's configured GitHub account. */
  async ghText(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<string, CommandFailure>> {
    const http = this.httpServing(request);
    if (http !== undefined) {
      return request.kind === "rest"
        ? http.restText(profile, request)
        : asText(await http.graphql(profile, request));
    }
    return this.runAsProfileAccount(profile, ghCommandFor(request), (input) =>
      this.commands.runText(input),
    );
  }

  /** The HTTP transport when it serves this request, or undefined when the request stays on gh. */
  private httpServing(
    request: GitHubRequest,
  ): GitHubServedTransport | undefined {
    const http = this.http;
    if (http === undefined) return undefined;
    const route = transportRouteFor(request, this.writesOverHttp);
    return route === "gh" ? undefined : http;
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
 * A GraphQL answer narrowed to the stdout bytes `ghText`'s callers read. Every
 * REST text caller takes `restText`, which hands over the response bytes; a
 * GraphQL document read as text would arrive here already parsed, so the read
 * fails rather than silently changing shape.
 */
function asText(
  response: Result<unknown, CommandFailure>,
): Result<string, CommandFailure> {
  if (response._tag === "err") return response;
  const text = v.safeParse(v.string(), response.value);
  return text.success ? ok(text.output) : err({ _tag: "CommandFailed" });
}
