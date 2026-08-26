import * as v from "valibot";

import type { GitHubReader } from "../adapters/github/github-adapter";
import { CommandRunner } from "../adapters/github/command-runner";
import type { ProfileStore } from "../adapters/storage/profile-store";
import { MaintainerInboxCacheStore } from "../adapters/storage/maintainer-inbox-cache-store";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseWorkspaceProfileId,
} from "../domain/ids";
import {
  parsePatchdeskSettingsPatch,
  type PatchdeskConfigFile,
} from "../domain/contracts";
import type { InboxPageRequest } from "../domain/maintainer-inbox";
import { err, ok, type Result } from "../domain/result";
import type {
  WatchedRepoConfig,
  WorkspaceProfileConfig,
} from "../domain/workspace-profile";
import { parseWorkspaceProfileConfig } from "../domain/workspace-profile";
import {
  DashboardService,
  type DashboardPrList,
  type DiscoveredRepo,
} from "./dashboard-service";
import {
  MaintainerInboxService,
  type InboxRepositoryRef,
  type MaintainerInbox,
} from "./maintainer-inbox-service";
import { InboxRefreshCoordinator } from "./inbox-refresh-coordinator";
import {
  addWatchedRepo,
  detectDefaultWorkspaceProfile,
  ProfileSettingsService,
  removeWatchedRepo,
  updateWatchedRepoPath,
} from "./profile-service";
import { sameRepositoryIdentity } from "../domain/repository-identity";
import type { ProfileMutationFailure, WatchedRepoRef } from "./profile-service";
import type { OriginFinder } from "./dashboard-service";

export type DashboardControllerFailure = {
  readonly _tag: "DashboardControllerFailure";
  readonly reason: "invalid_input" | "not_found" | "storage";
};

// This class is the main-process composition root: every schema below parses
// the raw JSON body `local-api.ts` hands it (`await jsonBody(context)`, or a
// single extracted field), the earliest point any of these requests are
// decoded. Fields kept as `v.unknown()` are re-validated by the specific
// domain parser (`parseGitHubHost`, `parseAbsolutePath`, ...) that already
// owns that invariant; the schema's job here is only to give a genuine
// object shape to narrow against, without resorting to `typeof` or a
// `Record<string, unknown>` dictionary type.
const rawObjectSchema = v.object({});
const repoRefInputSchema = v.object({
  host: v.unknown(),
  owner: v.unknown(),
  repo: v.unknown(),
});
const watchlistRepoInputSchema = v.object({
  host: v.unknown(),
  owner: v.unknown(),
  repo: v.unknown(),
  localPath: v.optional(v.unknown()),
});
const localPathInputSchema = v.object({
  localPath: v.optional(v.unknown()),
});
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const saveProfileInputSchema = v.object({
  id: v.unknown(),
  label: v.unknown(),
  githubHost: v.unknown(),
  ghAccount: v.unknown(),
  ownerFilters: v.unknown(),
  workspaceRoots: v.unknown(),
  rulePaths: v.unknown(),
});
/** Main-process composition root for the renderer's profile and dashboard actions. */
export class DashboardController {
  private readonly settings: ProfileSettingsService;
  private readonly dashboard: DashboardService;
  private readonly inbox: MaintainerInboxService;
  private readonly inboxRefresh: InboxRefreshCoordinator;
  /**
   * Memoized first-run detection, kept for this controller instance's
   * lifetime (one per process; see `local-api.ts`). Detection is only ever
   * consulted while unpersisted (`listProfiles` short-circuits on a
   * non-empty store), and a successful detection immediately persists and
   * selects the profile, so the memo naturally stops mattering the moment a
   * real account is found. Storing the in-flight promise (not just its
   * resolved value) also coalesces concurrent callers onto one `gh` probe.
   */
  private detectionMemo:
    | Promise<Result<WorkspaceProfileConfig, ProfileMutationFailure>>
    | undefined;

  constructor(
    private readonly profiles: ProfileStore,
    private readonly github: GitHubReader,
    origins?: OriginFinder,
    paths: PatchdeskPaths = PatchdeskPaths.default(),
    private readonly commands: CommandRunner = new CommandRunner(),
  ) {
    this.settings = new ProfileSettingsService(profiles);
    this.dashboard = new DashboardService(github, origins);
    this.inbox = new MaintainerInboxService(
      github,
      new ReviewSessionStore(paths),
      new MaintainerInboxCacheStore(paths),
      {
        // SAFETY: Date.prototype.toISOString() always returns a valid ISO
        // 8601 instant, satisfying the branded IsoTimestamp contract this
        // callback fills.
        now: () => new Date().toISOString() as never,
      },
    );
    this.inboxRefresh = new InboxRefreshCoordinator(this.inbox);
  }

  /**
   * `forceDetection` discards a cached negative/ephemeral detection and
   * re-probes `gh` immediately. Only `testGitHubAccess` passes `true` — it
   * backs the setup checklist's explicit "Re-check" action, the one place a
   * user expects a stale "not authenticated" reading to update the moment
   * they fix it in a terminal. Every other caller (inbox/dashboard polling,
   * `GET /v1/profiles`) takes the memoized reading, since those happen on a
   * timer rather than in response to the user just having taken an action.
   */
  async listProfiles(
    forceDetection = false,
  ): Promise<
    Result<ReadonlyArray<WorkspaceProfileConfig>, DashboardControllerFailure>
  > {
    const existing = await this.profiles.list();
    if (existing._tag === "err") return failure("storage");
    if (existing.value.length > 0) return ok(existing.value);
    if (forceDetection) this.detectionMemo = undefined;
    if (this.detectionMemo === undefined) {
      this.detectionMemo = detectDefaultWorkspaceProfile(this.commands);
    }
    const detected = await this.detectionMemo;
    if (detected._tag === "err") return failure("invalid_input");
    if (detected.value.ghAccount.length === 0) {
      // Detection found no real account on this machine. The persisted-profile
      // schema requires a non-empty ghAccount (see workspace-profile.ts), so
      // there is nothing valid to save yet; hand the renderer this ephemeral,
      // neutral profile so it can prompt for an account instead of writing an
      // unusable record or auto-selecting a profile that was never saved.
      // The negative reading is memoized (see `detectionMemo`) until either
      // a real profile is saved or `forceDetection` re-probes explicitly.
      return ok([detected.value]);
    }
    const saved = await this.settings.saveProfile(detected.value);
    if (saved._tag === "err") return failure("storage");
    const selected = await this.settings.selectProfile(detected.value.id);
    return selected._tag === "ok" ? ok([detected.value]) : failure("storage");
  }

  async selectProfile(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the local API's boundary: `local-api.ts` extracts `id` from the raw JSON body and hands it here unparsed; there is no earlier boundary to run it at.
    rawId: unknown,
  ): Promise<Result<WorkspaceProfileConfig, DashboardControllerFailure>> {
    const id = parseWorkspaceProfileId(rawId);
    if (id._tag === "err") return failure("invalid_input");
    const profile = await this.profiles.load(id.value);
    if (profile._tag === "err")
      return failure(
        profile.error.reason === "not_found" ? "not_found" : "storage",
      );
    const selected = await this.settings.selectProfile(profile.value.id);
    return selected._tag === "ok" ? ok(profile.value) : failure("storage");
  }

  /** Returns normalized global settings without creating a first-run config file. */
  async getSettings(): Promise<
    Result<PatchdeskConfigFile, DashboardControllerFailure>
  > {
    const settings = await this.settings.loadSettings();
    return settings._tag === "ok" ? settings : failure("storage");
  }

  /** Applies one validated global-settings patch while preserving profile selection. */
  async updateSettings(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for `PATCH /v1/settings`; there is no earlier boundary to run it at.
    input: unknown,
  ): Promise<Result<PatchdeskConfigFile, DashboardControllerFailure>> {
    const patch = parsePatchdeskSettingsPatch(input);
    if (patch._tag === "err") return failure("invalid_input");
    const settings = await this.settings.updateSettings(patch.value);
    return settings._tag === "ok" ? settings : failure("storage");
  }

  /** Creates or updates a profile through the typed profile JSON boundary. */
  async saveProfile(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for `POST /PUT /v1/profiles`; there is no earlier boundary to run it at.
    input: unknown,
  ): Promise<Result<WorkspaceProfileConfig, DashboardControllerFailure>> {
    const parsedInput = v.safeParse(saveProfileInputSchema, input);
    if (!parsedInput.success) return failure("invalid_input");
    const fields = parsedInput.output;
    const id = parseWorkspaceProfileId(fields.id);
    if (id._tag === "err") return failure("invalid_input");
    const existing = await this.profiles.load(id.value);
    if (existing._tag === "err" && existing.error.reason !== "not_found")
      return failure("storage");
    const current = existing._tag === "ok" ? existing.value : undefined;
    const profile = parseWorkspaceProfileConfig({
      id: fields.id,
      label: fields.label,
      githubHost: fields.githubHost,
      ghAccount: fields.ghAccount,
      ownerFilters: fields.ownerFilters,
      workspaceRoots: fields.workspaceRoots,
      rulePaths: fields.rulePaths,
      repos: current?.repos ?? [],
    });
    if (profile._tag === "err") return failure("invalid_input");
    const saved = await this.settings.saveProfile(profile.value);
    return saved._tag === "ok" ? ok(profile.value) : failure("storage");
  }

  async dashboardForActiveProfile(): Promise<
    Result<
      {
        readonly profile: WorkspaceProfileConfig;
        readonly dashboard: DashboardPrList;
      },
      DashboardControllerFailure
    >
  > {
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    const dashboard = await this.dashboard.listPendingPullRequests(
      profile.value,
    );
    if (dashboard._tag === "err") return failure("storage");
    return ok({ profile: profile.value, dashboard: dashboard.value });
  }

  /**
   * Returns one parsed read-only maintainer inbox page without starting a
   * review, for the given repository and structured filter.
   *
   * `repository` is `undefined` only for the renderer's bootstrap request,
   * sent before it has learned the active profile's watchlist (profile
   * selection is resolved here, server-side, and only revealed to the
   * renderer through this response's `profile` field — there is no earlier
   * point the renderer could know which repository to ask for). That case
   * falls back to the first watched repository, same as every other
   * omitted-and-defaulted field on this request (`pageToken`, `pageSize`).
   *
   * A caller-supplied repository is different: it must already be a member
   * of the active profile's watchlist, or the request is rejected before any
   * GitHub call. Without this check the renderer could point the
   * maintainer's token at a repository they never watched — the same class
   * of hole `buildInboxSearchQuery` guards against for the filter string.
   */
  async inboxForActiveProfile(
    repository: InboxRepositoryRef | undefined,
    input: InboxPageRequest,
  ): Promise<
    Result<
      {
        readonly profile: WorkspaceProfileConfig;
        readonly inbox: MaintainerInbox;
      },
      DashboardControllerFailure
    >
  > {
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    if (
      repository !== undefined &&
      !isWatchedRepository(profile.value, repository)
    )
      return failure("invalid_input");
    const target = repository ?? profile.value.repos[0];
    // An empty watchlist has no repository to read. That must stay a
    // successful, empty inbox rather than a failure: the renderer's
    // first-run setup checklist (`inbox-flow.tsx`) only renders on screen
    // state "empty", which requires an `ok` response, and a brand-new
    // profile with no watched repositories is exactly the state that screen
    // exists for. No GitHub call is made — there is no repository to read.
    if (target === undefined)
      return ok({
        profile: profile.value,
        inbox: {
          state: input.filter.state,
          pageSize: input.pageSize,
          rows: [],
          repositories: [],
          dataFreshness: "fresh",
          snapshot: { state: "current" },
        },
      });
    const inbox = await this.inboxRefresh.refresh(profile.value, target, input);
    if (inbox._tag === "err") return failure("invalid_input");
    return ok({ profile: profile.value, inbox: inbox.value });
  }

  /**
   * Resolves the active profile and its target repository for a
   * repository-scoped local-API read that is not `GET /v1/inbox` itself
   * (currently `GET /v1/inbox/labels`) — the same fallback-to-first-watched
   * and watchlist-membership rules `inboxForActiveProfile` applies, so a
   * repository outside the watchlist is rejected before any GitHub call the
   * same way it is there. `repository` absent from the result (rather than
   * the whole call failing) means the watchlist itself is empty; the caller
   * decides what an empty watchlist means for its own read.
   */
  async activeProfileRepository(
    repository: InboxRepositoryRef | undefined,
  ): Promise<
    Result<
      {
        readonly profile: WorkspaceProfileConfig;
        readonly repository?: InboxRepositoryRef;
      },
      DashboardControllerFailure
    >
  > {
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    if (
      repository !== undefined &&
      !isWatchedRepository(profile.value, repository)
    )
      return failure("invalid_input");
    const target = repository ?? profile.value.repos[0];
    return ok(
      target === undefined
        ? { profile: profile.value }
        : { profile: profile.value, repository: target },
    );
  }

  /** Refreshes one persisted repo while leaving other watchlist reads untouched. */
  async refreshWatchlistRepo(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser (via `repoRef`) for repo-scoped watchlist requests; there is no earlier boundary to run it at.
    input: unknown,
  ): Promise<Result<DashboardPrList, DashboardControllerFailure>> {
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    const ref = repoRef(input);
    if (ref._tag === "err") return ref;
    const target = profile.value.repos.find(
      (repo) =>
        repo.host === ref.value.host &&
        repo.owner === ref.value.owner &&
        repo.repo === ref.value.repo,
    );
    if (target === undefined) return failure("not_found");
    const refreshed = await this.dashboard.refreshRepository(
      profile.value,
      target,
    );
    return refreshed._tag === "ok" ? refreshed : failure("storage");
  }

  async addWatchlistRepo(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for `POST /v1/watchlist`; there is no earlier boundary to run it at.
    input: unknown,
  ): Promise<Result<WorkspaceProfileConfig, DashboardControllerFailure>> {
    if (!v.safeParse(rawObjectSchema, input).success)
      return failure("invalid_input");
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    const parsedInput = v.safeParse(watchlistRepoInputSchema, input);
    if (!parsedInput.success) return failure("invalid_input");
    const fields = parsedInput.output;
    const host = parseGitHubHost(fields.host);
    const owner = parseGitHubOwner(fields.owner);
    const repo = parseGitHubRepoName(fields.repo);
    // `localPath` really is optional here (unlike `setLocalPath`, there is no
    // existing association to "clear"): omit it when absent, but once
    // present it must parse as a genuine absolute path — no longer smuggled
    // through as `localPath as never`, which previously bypassed validation
    // entirely and could persist an unusable path.
    const localPath =
      fields.localPath === undefined
        ? undefined
        : parseAbsolutePath(fields.localPath);
    if (
      host._tag === "err" ||
      owner._tag === "err" ||
      repo._tag === "err" ||
      (localPath !== undefined && localPath._tag === "err")
    )
      return failure("invalid_input");
    const repoToAdd: WatchedRepoConfig = {
      host: host.value,
      owner: owner.value,
      repo: repo.value,
    };
    const changed = addWatchedRepo(
      profile.value,
      localPath === undefined
        ? repoToAdd
        : { ...repoToAdd, localPath: localPath.value },
    );
    if (changed._tag === "err") return failure("invalid_input");
    const saved = await this.settings.saveProfile(changed.value);
    return saved._tag === "ok" ? ok(changed.value) : failure("storage");
  }

  async setLocalPath(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for `PATCH /v1/watchlist/path`; there is no earlier boundary to run it at.
    input: unknown,
  ): Promise<Result<WorkspaceProfileConfig, DashboardControllerFailure>> {
    if (!v.safeParse(rawObjectSchema, input).success)
      return failure("invalid_input");
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    const ref = repoRef(input);
    if (ref._tag === "err") return ref;
    const parsedLocalPath = v.safeParse(localPathInputSchema, input);
    const rawLocalPath = parsedLocalPath.success
      ? parsedLocalPath.output.localPath
      : undefined;
    // A missing/blank/non-string `localPath` means "clear the association",
    // not "invalid request" — `updateWatchedRepoPath` below is what actually
    // validates a present value as a real absolute path.
    const nonEmptyLocalPath = v.safeParse(nonEmptyStringSchema, rawLocalPath);
    const changed = updateWatchedRepoPath(
      profile.value,
      ref.value,
      nonEmptyLocalPath.success ? nonEmptyLocalPath.output : undefined,
    );
    if (changed._tag === "err") return failure("invalid_input");
    const saved = await this.settings.saveProfile(changed.value);
    return saved._tag === "ok" ? ok(changed.value) : failure("storage");
  }

  async removeWatchlistRepo(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser (via `repoRef`) for `DELETE /v1/watchlist`; there is no earlier boundary to run it at.
    input: unknown,
  ): Promise<Result<WorkspaceProfileConfig, DashboardControllerFailure>> {
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    const ref = repoRef(input);
    if (ref._tag === "err") return ref;
    const changed = removeWatchedRepo(profile.value, ref.value);
    if (changed._tag === "err") return failure("not_found");
    const saved = await this.settings.saveProfile(changed.value);
    return saved._tag === "ok" ? ok(changed.value) : failure("storage");
  }

  async discoverWorkspaceRepos(): Promise<
    Result<ReadonlyArray<DiscoveredRepo>, DashboardControllerFailure>
  > {
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    const discovered = await this.dashboard.discoverWorkspaceRepos(
      profile.value,
    );
    return discovered._tag === "ok" ? discovered : failure("storage");
  }

  async testGitHubAccess(): Promise<
    Result<
      { readonly state: "available" | "github_auth" },
      DashboardControllerFailure
    >
  > {
    // Force a fresh detection probe: this is the setup checklist's
    // "Confirm GitHub access" / "Re-check" flow, so a user who just ran
    // `gh auth login` in a terminal must see it reflected immediately
    // rather than a memoized pre-login reading (see `detectionMemo`).
    const profile = await this.activeProfile(true);
    if (profile._tag === "err") return profile;
    // Consult authentication directly rather than inferring it from
    // per-repo dashboard state: on an empty watchlist `listPendingPullRequests`
    // has no repos to attach an auth failure to, so its `repos` array is `[]`
    // regardless of whether `gh` is authenticated. That would report a false
    // "available" on first run, before any repo has been added.
    const auth = await this.github.resolveAuthenticatedAccount(profile.value);
    return ok({ state: auth._tag === "err" ? "github_auth" : "available" });
  }

  private async activeProfile(
    forceDetection = false,
  ): Promise<Result<WorkspaceProfileConfig, DashboardControllerFailure>> {
    const profiles = await this.listProfiles(forceDetection);
    if (profiles._tag === "err") return profiles;
    const config = await this.profiles.loadConfig();
    const selected =
      config._tag === "ok"
        ? profiles.value.find(
            (profile) => profile.id === config.value.lastSelectedProfileId,
          )
        : undefined;
    const first = profiles.value[0];
    if (selected !== undefined) return ok(selected);
    return first === undefined ? failure("not_found") : ok(first);
  }
}

/** Whether `repository` is one of `profile`'s watched repositories. */
function isWatchedRepository(
  profile: WorkspaceProfileConfig,
  repository: InboxRepositoryRef,
): boolean {
  return profile.repos.some((repo) => sameRepositoryIdentity(repo, repository));
}

function repoRef(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for the `{ host, owner, repo }` shape shared by several watchlist endpoints; there is no earlier boundary to run it at.
  input: unknown,
): Result<WatchedRepoRef, DashboardControllerFailure> {
  const parsed = v.safeParse(repoRefInputSchema, input);
  if (!parsed.success) return failure("invalid_input");
  const host = parseGitHubHost(parsed.output.host);
  const owner = parseGitHubOwner(parsed.output.owner);
  const repo = parseGitHubRepoName(parsed.output.repo);
  return host._tag === "ok" && owner._tag === "ok" && repo._tag === "ok"
    ? ok({ host: host.value, owner: owner.value, repo: repo.value })
    : failure("invalid_input");
}
function failure(
  reason: DashboardControllerFailure["reason"],
): Result<never, DashboardControllerFailure> {
  return err({ _tag: "DashboardControllerFailure", reason });
}
