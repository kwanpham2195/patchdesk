import { pullRequestWritePermission } from "../adapters/github/github-adapter";
import type {
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import {
  resolveAvatarDataUris,
  withAvatarDataUri,
} from "../adapters/storage/avatar-cache-store";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type {
  AssignableUser,
  PullRequestAssigneePermission,
} from "../domain/github-context";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { AvatarRailDependencies } from "./avatar-sync-service";
import type { ReviewWriteGate } from "./review-write-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { RecentReviewWrite } from "../domain/recent-review-write";
import {
  mapGitHubReadFailure,
  mapGitHubWriteFailure,
  mapMetadataGateFailure,
  pullRequestRefForSession,
  resolvePullRequestWritePermission,
  runGuardedMetadataWrite,
  type PullRequestMetadataListFailure,
  type PullRequestMetadataReadFailure,
  type PullRequestMetadataWriteFailure,
} from "./pull-request-metadata-write";

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
    }
  | {
      // No `assignees` field: the service resolves who "self" is itself
      // (`resolveAuthenticatedAccount`), rather than trusting a caller-
      // supplied identity for a command that only ever means the current
      // account.
      readonly _tag: "AssignSelf";
    };

export type AssigneeReceipt =
  | { readonly _tag: "AssigneesAdded"; readonly added: ReadonlyArray<string> }
  | {
      readonly _tag: "AssigneesRemoved";
      readonly removed: ReadonlyArray<string>;
    };

/** The shared metadata-write vocabulary plus the one reason only assignment can produce. */
export type AssigneeWriteFailure =
  | PullRequestMetadataWriteFailure
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
       * evidence through `pullRequestWritePermission`). Carried on the read
       * path so the picker can gate its controls on real evidence instead of
       * inferring permission from a rejected write.
       */
      readonly permission: PullRequestAssigneePermission;
    }
  | PullRequestMetadataReadFailure;

/** Only the review-resolution half can fail the request outright; a GitHub read failure is conveyed as an `AssigneeListOutcome` instead. */
export type AssigneeListFailure = PullRequestMetadataListFailure;

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
    /** Best-effort; see `AvatarRailDependencies`. Absent in tests/paths that never exercise avatar behaviour, in which case `list` returns every user with no `avatarDataUri`. */
    private readonly avatars?: AvatarRailDependencies,
  ) {}

  async execute(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly command: AssigneeCommand;
  }): Promise<Result<AssigneeReceipt, AssigneeWriteFailure>> {
    return await runGuardedMetadataWrite({
      profileId: input.profileId,
      reviewId: input.reviewId,
      coordinator: this.writeCoordinator,
      recentWrites: this.recentWrites,
      now: this.now,
      validate: () => validateLocalCommand(input.command),
      write: () => this.executeUnlocked(input),
      journalEntry: journalEntryFor,
    });
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
    if (current._tag === "err")
      return err(mapMetadataGateFailure(current.error));
    const pr = pullRequestRefForSession(current.value.session.key);
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
    if (listed._tag !== "ok") return ok(mapGitHubReadFailure(listed.error));
    const users = await this.withResolvedAvatars(
      input.profileId,
      current.value.profile,
      pr,
      listed.value.users,
    );
    return ok({
      _tag: "ready",
      users,
      totalCount: listed.value.totalCount,
      permission,
    });
  }

  /**
   * Attaches each assignable user's cached `avatarDataUri`, warming the
   * cache for them first — the honest, main-process equivalent of the
   * projection's `resolveAvatars` for a route that has no workbench
   * projection of its own (see `AvatarRailDependencies`/`avatars` above). A
   * missing `this.avatars` (no live `AvatarSyncService`/`PatchdeskPaths`
   * wired) is the only early-return: every other failure inside this method
   * is already absorbed by `AvatarSyncService.warmAvatarUrls` or
   * `resolveAvatarDataUris`'s own per-URL fallback, so `users` is returned
   * unresolved rather than the whole read failing.
   *
   * Currently-assigned people are warmed ahead of the rest of the candidate
   * list (`GET /v1/reviews/assignees` doubles as the assignee picker's
   * candidate roster) so a cap-bounded warm never starves the rail's own
   * Assignees section for the sake of someone who only appears in the
   * picker. The returned `users` keep GitHub's original order — only the
   * warm order is reprioritized.
   *
   * The whole body below is wrapped in a try/catch: an avatar is decorative,
   * so nothing here may fail this read. `AvatarSyncService.warmAvatarUrls`
   * and `resolveAvatarDataUris` already never throw on their own account;
   * this is defense in depth against a misbehaving injected `avatars`
   * dependency, mirroring `ReviewRefreshService`'s identical guard around
   * `syncCommentAuthors`.
   */
  private async withResolvedAvatars(
    profileId: WorkspaceProfileId,
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
    users: ReadonlyArray<AssignableUser>,
  ): Promise<ReadonlyArray<AssignableUser>> {
    const avatars = this.avatars;
    if (avatars === undefined) return users;
    try {
      const pullRequest = await this.github.getPullRequest({ profile, pr });
      const currentAssigneeLogins = new Set(
        pullRequest._tag === "ok" ? (pullRequest.value.assignees ?? []) : [],
      );
      const prioritized = [...users].sort((a, b) => {
        const aAssigned = currentAssigneeLogins.has(a.login);
        const bAssigned = currentAssigneeLogins.has(b.login);
        if (aAssigned === bAssigned) return 0;
        return aAssigned ? -1 : 1;
      });
      const avatarUrls = prioritized.flatMap((user) =>
        user.avatarUrl === undefined ? [] : [user.avatarUrl],
      );
      await avatars.sync.warmAvatarUrls({ profileId, avatarUrls });
      const resolved = await resolveAvatarDataUris(
        avatars.paths,
        profileId,
        avatarUrls,
      );
      return users.map((user) => withAvatarDataUri(user, resolved));
    } catch {
      return users;
    }
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
    return await resolvePullRequestWritePermission({
      github: this.github,
      profile,
      pr,
      project: pullRequestWritePermission,
    });
  }

  /**
   * Resolves the authenticated account's own `AssigneeRef` for `AssignSelf`:
   * `resolveAuthenticatedAccount` gives the login, but assignment needs the
   * GraphQL node ID that only `listAssignableUsers` carries (mirrors why
   * `AssignableUser.id` exists at all — see its doc comment). Searching by
   * the login and requiring an exact match avoids assigning a lookalike
   * account if GitHub's substring search returns more than one result.
   */
  private async resolveSelfAssignee(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
  ): Promise<Result<AssigneeRef, AssigneeWriteFailure>> {
    const account = await this.github.resolveAuthenticatedAccount(profile);
    if (account._tag === "err") return err("github_read_failed");
    const listed = await this.github.listAssignableUsers({
      profile,
      repo: pr,
      query: account.value.account,
    });
    if (listed._tag === "err") return err("github_read_failed");
    const match = listed.value.users.find(
      (user) => user.login === account.value.account,
    );
    if (match === undefined) return err("github_read_failed");
    return ok({ id: match.id, login: match.login });
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
    if (current._tag === "err")
      return err(mapMetadataGateFailure(current.error));
    const pr = pullRequestRefForSession(current.value.session.key);

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

    // `AssignSelf` carries no `assignees` of its own: resolve the
    // authenticated account's own `AssigneeRef` here, then fall through the
    // same add path as `AddAssignees` below (cap check included — a
    // self-assign is not exempt from the ten-assignee cap).
    let assignees: ReadonlyArray<AssigneeRef>;
    if (input.command._tag === "AssignSelf") {
      const resolved = await this.resolveSelfAssignee(
        current.value.profile,
        pr,
      );
      if (resolved._tag === "err") return resolved;
      assignees = [resolved.value];
    } else {
      assignees = input.command.assignees;
    }
    const assigneeIds = assignees.map((assignee) => assignee.id);
    const assigneeLogins = assignees.map((assignee) => assignee.login);

    if (
      input.command._tag === "AddAssignees" ||
      input.command._tag === "AssignSelf"
    ) {
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
        ? err(mapGitHubWriteFailure(written.error))
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
      ? err(mapGitHubWriteFailure(written.error))
      : ok({ _tag: "AssigneesRemoved", removed: assigneeLogins });
  }
}

function journalEntryFor(receipt: AssigneeReceipt): RecentReviewWrite {
  return receipt._tag === "AssigneesAdded"
    ? { _tag: "AssigneeChange", added: receipt.added, removed: [] }
    : { _tag: "AssigneeChange", added: [], removed: receipt.removed };
}

function validateLocalCommand(
  command: AssigneeCommand,
): Result<void, AssigneeWriteFailure> {
  // `AssignSelf` carries no `assignees` to validate locally; its identity is
  // resolved against GitHub itself in `resolveSelfAssignee`.
  if (command._tag === "AssignSelf") return ok(undefined);
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
