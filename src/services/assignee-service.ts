import { pullRequestAssigneePermission } from "../adapters/github/github-adapter";
import type {
  GitHubReader,
  GitHubReviewWriter,
  GitHubReadFailure,
} from "../adapters/github/github-adapter";
import type { ForbiddenReason } from "../adapters/github/command-runner";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type { GitHubWriteFailure } from "../domain/github-write";
import type {
  AssignableUser,
  PullRequestAssigneePermission,
} from "../domain/github-context";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type {
  ReviewWriteGate,
  ReviewWriteGateFailure,
} from "./review-write-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { RecentReviewWrite } from "./review-refresh-service";

/** GitHub's documented per-pull-request assignee limit; not independently reconfirmed against a live API call in this change. */
const MAX_ASSIGNEES = 10;

/** One assignee to add or remove; `login` travels alongside `id` purely so a confirmed write can journal a human-legible own-write fingerprint without a second lookup. */
export type AssigneeRef = {
  readonly id: string;
  readonly login: string;
};

export type AssigneeCommand =
  | {
      readonly _tag: "AddAssignees";
      readonly assignees: ReadonlyArray<AssigneeRef>;
    }
  | {
      readonly _tag: "RemoveAssignees";
      readonly assignees: ReadonlyArray<AssigneeRef>;
    };

export type AssigneeReceipt =
  | { readonly _tag: "AssigneesAdded"; readonly added: ReadonlyArray<string> }
  | {
      readonly _tag: "AssigneesRemoved";
      readonly removed: ReadonlyArray<string>;
    };

export type AssigneeWriteFailure =
  | "invalid_input"
  | "not_found"
  | "permission_denied"
  | "forbidden"
  | "github_read_failed"
  | "github_write_failed"
  | "rate_limited"
  | "review_write_in_progress"
  | "assignee_cap_exceeded";

/**
 * Outcome of listing a repository's assignable users for one current Review.
 * Mirrors `LabelListOutcome`'s read-failure vocabulary
 * (`github_auth` / `github_rate_limited` / `github_forbidden` / `github_read`)
 * so a GitHub read failure is data on the success path, not an HTTP error.
 */
export type AssigneeListOutcome =
  | {
      readonly _tag: "ready";
      readonly users: ReadonlyArray<AssignableUser>;
      /** GitHub's exact total; compare against `users.length` to detect truncation. */
      readonly totalCount: number;
      /**
       * Whether this account can assign people to this pull request, computed
       * the same way `execute`'s write gate computes it (`getRepositoryPermission`
       * evidence through `pullRequestAssigneePermission`). Carried on the read
       * path so the picker can gate its controls on real evidence instead of
       * inferring permission from a rejected write.
       */
      readonly permission: PullRequestAssigneePermission;
    }
  | { readonly _tag: "github_auth" }
  | { readonly _tag: "github_read" }
  | { readonly _tag: "github_rate_limited"; readonly resumeAt?: IsoTimestamp }
  | { readonly _tag: "github_forbidden"; readonly reason: ForbiddenReason };

/** Only the review-resolution half can fail the request outright; a GitHub read failure is conveyed as an `AssigneeListOutcome` instead. */
export type AssigneeListFailure = "not_found" | "permission_denied";

/**
 * `GitHubReader.listAssignableUsers`'s input, declared mutable here so the
 * optional search term can be added in a statement rather than through a
 * conditional empty-object spread. Mirrors `MutableGeneralThreadOverrides`
 * in `conversation.tsx`; the adapter still sees its own readonly contract.
 */
type MutableAssignableUsersRequest = {
  profile: WorkspaceProfileConfig;
  repo: PullRequestRef;
  query?: string;
};

type Gateway = Pick<
  GitHubReader,
  | "getPullRequest"
  | "resolveAuthenticatedAccount"
  | "getRepositoryPermission"
  | "listAssignableUsers"
> &
  Pick<
    GitHubReviewWriter,
    "addAssigneesToAssignable" | "removeAssigneesFromAssignable"
  >;

/**
 * Owns direct, GitHub-published assignee reads and assignment for one
 * current Review. An assignee is pull-request-level metadata, not
 * diff-anchored, so both `execute` and `list` gate on
 * `requireCurrentSession` (proves the Review is not stale/terminal) rather
 * than `requireFresh` — see ADR "Gate label writes on the current session":
 * a new commit does not invalidate an assignee any more than it invalidates
 * a label.
 */
export class AssigneeService {
  constructor(
    private readonly gate: Pick<ReviewWriteGate, "requireCurrentSession">,
    private readonly github: Gateway,
    private readonly writeCoordinator: ReviewOperationCoordinator,
    private readonly now: () => IsoTimestamp,
    private readonly recentWrites: Pick<RecentWriteJournalStore, "append">,
  ) {}

  async execute(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: AssigneeCommand;
  }): Promise<Result<AssigneeReceipt, AssigneeWriteFailure>> {
    const localValidation = validateLocalCommand(input.command);
    if (localValidation._tag === "err") return localValidation;
    const key = `${input.profileId}:${input.reviewId}`;
    if (!this.writeCoordinator.acquire(key))
      return err("review_write_in_progress");
    try {
      const result = await this.executeUnlocked(input);
      if (result._tag === "ok") {
        // Best effort: the GitHub write already succeeded, so a durable
        // journal failure here must not fail the confirmed command.
        await this.recentWrites.append(
          input.profileId,
          input.reviewId,
          journalEntryFor(result.value),
          this.now(),
        );
      }
      return result;
    } finally {
      this.writeCoordinator.release(key);
    }
  }

  /**
   * Read-only counterpart to `execute`: the repository collaborators
   * assignable on the current Review's pull request, for populating an
   * assignee picker. `query` filters server-side by login/name substring.
   */
  async list(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly query?: string;
  }): Promise<Result<AssigneeListOutcome, AssigneeListFailure>> {
    const current = await this.gate.requireCurrentSession(
      input.profileId,
      input.reviewId,
    );
    // Reuses `mapGateFailure`'s exact reason mapping, but that function is
    // typed to `AssigneeWriteFailure` (a strictly wider union than
    // `AssigneeListFailure`), so the two-value read result is spelled out
    // here rather than widening the read failure type to match it.
    if (current._tag === "err")
      return err(
        current.error.reason === "not_found" ||
          current.error.reason === "storage"
          ? "not_found"
          : "permission_denied",
      );
    const pr = {
      host: current.value.session.key.host,
      owner: current.value.session.key.owner,
      repo: current.value.session.key.repo,
      number: current.value.session.key.prNumber,
    };
    // Built in statements rather than by spreading a conditional empty
    // object: the search term is omitted entirely when the caller supplied
    // none, so GitHub's `query:` argument stays unset instead of being sent
    // as an explicit empty filter.
    const listInput: MutableAssignableUsersRequest = {
      profile: current.value.profile,
      repo: pr,
    };
    if (input.query !== undefined) listInput.query = input.query;
    const [listed, permission] = await Promise.all([
      this.github.listAssignableUsers(listInput),
      this.resolvePermission(current.value.profile, pr),
    ]);
    return ok(
      listed._tag === "ok"
        ? {
            _tag: "ready",
            users: listed.value.users,
            totalCount: listed.value.totalCount,
            permission,
          }
        : mapReadFailure(listed.error),
    );
  }

  /**
   * Resolves the real three-state assignee-write permission for one
   * profile's pull request, shared by `execute`'s write gate and `list`'s
   * read projection so the picker sees the same signal the write path
   * enforces. `getRepositoryPermission` is an optional adapter read; when it
   * is unavailable, or the resolved account does not match the configured
   * profile account, the answer is `unknown` — never `permitted`.
   */
  private async resolvePermission(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
  ): Promise<PullRequestAssigneePermission> {
    const account = await this.github.resolveAuthenticatedAccount(profile);
    const permissionEvidence =
      account._tag === "ok" &&
      account.value.account === profile.ghAccount &&
      this.github.getRepositoryPermission !== undefined
        ? await this.github.getRepositoryPermission({
            profile,
            pr,
            account: account.value.account,
          })
        : undefined;
    return pullRequestAssigneePermission(permissionEvidence);
  }

  private async executeUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: AssigneeCommand;
  }): Promise<Result<AssigneeReceipt, AssigneeWriteFailure>> {
    const current = await this.gate.requireCurrentSession(
      input.profileId,
      input.reviewId,
    );
    if (current._tag === "err") return err(mapGateFailure(current.error));
    const pr = {
      host: current.value.session.key.host,
      owner: current.value.session.key.owner,
      repo: current.value.session.key.repo,
      number: current.value.session.key.prNumber,
    };

    // A write attempted without `permitted` is refused here, not only in the
    // UI. `unknown` (missing/failed evidence) must never be treated as
    // permitted — only an explicit `permitted` proceeds.
    const permission = await this.resolvePermission(current.value.profile, pr);
    if (permission !== "permitted") return err("permission_denied");

    const pullRequest = await this.github.getPullRequest({
      profile: current.value.profile,
      pr,
    });
    if (pullRequest._tag === "err") return err("github_read_failed");
    const assignableId = pullRequest.value.nodeId;
    if (assignableId === undefined) return err("github_read_failed");

    const assigneeIds = input.command.assignees.map((assignee) => assignee.id);
    const assigneeLogins = input.command.assignees.map(
      (assignee) => assignee.login,
    );

    if (input.command._tag === "AddAssignees") {
      const resultantLogins = new Set(pullRequest.value.assignees ?? []);
      for (const login of assigneeLogins) resultantLogins.add(login);
      // Enforced before ever calling GitHub so a request that would exceed
      // the cap fails with a distinct, nameable reason instead of a generic
      // write failure.
      if (resultantLogins.size > MAX_ASSIGNEES)
        return err("assignee_cap_exceeded");
      if (this.github.addAssigneesToAssignable === undefined)
        return err("github_write_failed");
      const written = await this.github.addAssigneesToAssignable({
        profile: current.value.profile,
        assignableId,
        assigneeIds,
      });
      return written._tag === "err"
        ? err(mapWriteFailure(written.error))
        : ok({ _tag: "AssigneesAdded", added: assigneeLogins });
    }
    if (this.github.removeAssigneesFromAssignable === undefined)
      return err("github_write_failed");
    const written = await this.github.removeAssigneesFromAssignable({
      profile: current.value.profile,
      assignableId,
      assigneeIds,
    });
    return written._tag === "err"
      ? err(mapWriteFailure(written.error))
      : ok({ _tag: "AssigneesRemoved", removed: assigneeLogins });
  }
}

function mapGateFailure(failure: ReviewWriteGateFailure): AssigneeWriteFailure {
  if (failure.reason === "not_found" || failure.reason === "storage")
    return "not_found";
  // "terminal": the Review is closed/merged. "stale"/"not_fresh": the stored
  // session no longer matches the Review's own identity, an inconsistency
  // this write must refuse rather than act on. Neither invents new
  // vocabulary; both collapse into the closed taxonomy's `permission_denied`.
  return "permission_denied";
}

function mapWriteFailure(failure: GitHubWriteFailure): AssigneeWriteFailure {
  if (failure.category === "rate_limited") return "rate_limited";
  if (failure.category === "forbidden") return "forbidden";
  return "github_write_failed";
}

/** Keeps a forbidden or rate-limited assignee read specific instead of collapsing it to a generic read failure. */
function mapReadFailure(failure: GitHubReadFailure): AssigneeListOutcome {
  if (failure._tag === "GitHubRateLimited") {
    const resumeAtField =
      failure.resumeAt === undefined ? {} : { resumeAt: failure.resumeAt };
    return { _tag: "github_rate_limited", ...resumeAtField };
  }
  if (failure._tag === "GitHubForbidden")
    return { _tag: "github_forbidden", reason: failure.reason };
  if (failure._tag === "GitHubAuthenticationFailed")
    return { _tag: "github_auth" };
  return { _tag: "github_read" };
}

function journalEntryFor(receipt: AssigneeReceipt): RecentReviewWrite {
  return receipt._tag === "AssigneesAdded"
    ? { _tag: "AssigneeChange", added: receipt.added, removed: [] }
    : { _tag: "AssigneeChange", added: [], removed: receipt.removed };
}

function validateLocalCommand(
  command: AssigneeCommand,
): Result<void, AssigneeWriteFailure> {
  if (command.assignees.length === 0) return err("invalid_input");
  if (
    command.assignees.some(
      (assignee) =>
        assignee.id.trim().length === 0 || assignee.login.trim().length === 0,
    )
  )
    return err("invalid_input");
  return ok(undefined);
}
