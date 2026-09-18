import {
  requestCoalescingContext,
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
import { err, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import { parseGitHubTimestamp } from "./github-wire-projections";
import { ghInvocationFor, type GitHubRequest } from "./github-request";
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
 * The identity two reads have to share before one may join the other, or
 * `undefined` for a request this runner must always send itself.
 *
 * Host and account lead the key because `runAsProfileAccount` injects that
 * profile's own token (ADR 0021), so two profiles must never share an entry
 * even when their invocations are identical; the shape mirrors `accountKey`
 * in `github-credentials.ts`. The rest is the exact invocation, argv and
 * stdin, which is what decides the response.
 *
 * Only a request this runner can prove is a read is eligible. Coalescing a
 * write would drop one of two deliberate mutations, so a REST call carrying a
 * method is excluded, and a GraphQL document is eligible only when it opens
 * with the `query` keyword -- a mutation operation cannot.
 */
function coalescingKey(
  profile: WorkspaceProfileConfig,
  request: GitHubRequest,
  command: GhCommandRequest,
): string | undefined {
  if (!provablyRead(request)) return undefined;
  return [
    profile.githubHost,
    profile.ghAccount,
    ...command.argv,
    command.stdin ?? "",
  ].join("\u0000");
}

function provablyRead(request: GitHubRequest): boolean {
  if (request.kind === "pull_request_diff") return true;
  if (request.kind === "graphql") return request.document.startsWith("query ");
  return request.method === undefined;
}

/**
 * Joins the identical read already running under `key`, or starts one and
 * publishes it for the rest of this request to join.
 *
 * Both callers await the one promise, so a failure is shared exactly as a
 * success is: they are the same call and cannot be told different answers.
 * The entry is removed in the `finally` before that promise resolves, so by
 * the time any awaiter resumes it is already gone -- a read issued after one
 * completes is its own round trip, which is what keeps every re-verification
 * in the Review path honest (`review-refresh-service.ts` reads the pull
 * request, awaits the rest of the snapshot, then reads it again to prove the
 * revision did not move).
 */
function joinInFlight<T>(
  inFlight: Map<string, Promise<Result<T, CommandFailure>>>,
  key: string,
  start: () => Promise<Result<T, CommandFailure>>,
): Promise<Result<T, CommandFailure>> {
  const joined = inFlight.get(key);
  if (joined !== undefined) return joined;
  const started = (async () => {
    try {
      return await start();
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, started);
  return started;
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
 *
 * Inside a request that entered `runWithCoalescedGitHubReads`, a read whose
 * identical twin is already running joins it instead of spawning a second
 * child (see `coalescingKey` and `joinInFlight`). That scope holds nothing
 * once a call settles, so it never answers from a completed result.
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

  /** Run a request that returns JSON as the profile's configured GitHub account. */
  async ghJson(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    const command = ghCommandFor(request);
    const start = (): Promise<Result<unknown, CommandFailure>> =>
      this.runAsProfileAccount(profile, command, (input) =>
        this.commands.runJson(input),
      );
    const scope = requestCoalescingContext.getStore();
    const key = coalescingKey(profile, request, command);
    return scope === undefined || key === undefined
      ? start()
      : joinInFlight(scope.json, key, start);
  }

  /** Run a request that returns text as the profile's configured GitHub account. */
  async ghText(
    profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<string, CommandFailure>> {
    const command = ghCommandFor(request);
    const start = (): Promise<Result<string, CommandFailure>> =>
      this.runAsProfileAccount(profile, command, (input) =>
        this.commands.runText(input),
      );
    const scope = requestCoalescingContext.getStore();
    const key = coalescingKey(profile, request, command);
    return scope === undefined || key === undefined
      ? start()
      : joinInFlight(scope.text, key, start);
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
