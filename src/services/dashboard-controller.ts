import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import { MaintainerInboxCacheStore } from "../adapters/storage/maintainer-inbox-cache-store";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseWorkspaceProfileId,
} from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { parseWorkspaceProfileConfig } from "../domain/workspace-profile";
import {
  DashboardService,
  type DashboardPrList,
  type DiscoveredRepo,
} from "./dashboard-service";
import { MaintainerInboxService, type MaintainerInbox } from "./maintainer-inbox-service";
import { InboxRefreshCoordinator } from "./inbox-refresh-coordinator";
import {
  addWatchedRepo,
  createDefaultCfwProfile,
  ProfileSettingsService,
  removeWatchedRepo,
  setWatchedRepoArchived,
  updateWatchedRepoPath,
} from "./profile-service";
import type { WatchedRepoRef } from "./profile-service";
import type { OriginFinder } from "./dashboard-service";
import {
  parsePullRequestEntry,
  profileSwitchConfirmation,
  suggestProfile,
} from "./pull-request-input-service";

export type DashboardControllerFailure = {
  readonly _tag: "DashboardControllerFailure";
  readonly reason: "invalid_input" | "not_found" | "storage";
};

/** Main-process composition root for the renderer's profile, dashboard, and direct-entry actions. */
export class DashboardController {
  private readonly settings: ProfileSettingsService;
  private readonly dashboard: DashboardService;
  private readonly inbox: MaintainerInboxService;
  private readonly inboxRefresh: InboxRefreshCoordinator;

  constructor(
    private readonly profiles: ProfileStore,
    github: GitHubReader,
    origins?: OriginFinder,
    paths: PatchdeskPaths = PatchdeskPaths.default(),
  ) {
    this.settings = new ProfileSettingsService(profiles);
    this.dashboard = new DashboardService(github, origins);
    this.inbox = new MaintainerInboxService(
      github,
      new ReviewSessionStore(paths),
      new MaintainerInboxCacheStore(paths),
      { now: () => new Date().toISOString() as never },
    );
    this.inboxRefresh = new InboxRefreshCoordinator(this.inbox);
  }

  async listProfiles(): Promise<
    Result<ReadonlyArray<WorkspaceProfileConfig>, DashboardControllerFailure>
  > {
    const existing = await this.profiles.list();
    if (existing._tag === "err") return failure("storage");
    if (existing.value.length > 0) return ok(existing.value);
    const initial = createDefaultCfwProfile();
    if (initial._tag === "err") return failure("invalid_input");
    const saved = await this.settings.saveProfile(initial.value);
    if (saved._tag === "err") return failure("storage");
    const selected = await this.settings.selectProfile(initial.value.id);
    return selected._tag === "ok" ? ok([initial.value]) : failure("storage");
  }

  async selectProfile(
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

  /** Creates or updates a profile through the typed profile JSON boundary. */
  async saveProfile(
    input: unknown,
  ): Promise<Result<WorkspaceProfileConfig, DashboardControllerFailure>> {
    if (!isObject(input)) return failure("invalid_input");
    const id = parseWorkspaceProfileId(input.id);
    if (id._tag === "err") return failure("invalid_input");
    const existing = await this.profiles.load(id.value);
    if (existing._tag === "err" && existing.error.reason !== "not_found")
      return failure("storage");
    const current = existing._tag === "ok" ? existing.value : undefined;
    const profile = parseWorkspaceProfileConfig({
      id: input.id,
      label: input.label,
      githubHost: input.githubHost,
      ghAccount: input.ghAccount,
      ownerFilters: current?.ownerFilters ?? [],
      workspaceRoots: Array.isArray(input.workspaceRoots)
        ? input.workspaceRoots
        : (current?.workspaceRoots ?? []),
      rulePaths: current?.rulePaths ?? [],
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

  /** Returns the read-only maintainer inbox for the active profile without starting a review. */
  async inboxForActiveProfile(): Promise<
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
    const inbox = await this.inboxRefresh.refresh(profile.value);
    if (inbox._tag === "err") return failure("storage");
    return ok({ profile: profile.value, inbox: inbox.value });
  }

  /** Refreshes one persisted repo while leaving other watchlist reads untouched. */
  async refreshWatchlistRepo(
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
    const refreshed = await this.dashboard.refreshRepository(profile.value, target);
    return refreshed._tag === "ok" ? refreshed : failure("storage");
  }

  async addWatchlistRepo(
    input: unknown,
  ): Promise<Result<WorkspaceProfileConfig, DashboardControllerFailure>> {
    if (!isObject(input)) return failure("invalid_input");
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    const host = parseGitHubHost(input.host);
    const owner = parseGitHubOwner(input.owner);
    const repo = parseGitHubRepoName(input.repo);
    if (host._tag === "err" || owner._tag === "err" || repo._tag === "err")
      return failure("invalid_input");
    const changed = addWatchedRepo(profile.value, {
      host: host.value,
      owner: owner.value,
      repo: repo.value,
      ...(typeof input.localPath === "string"
        ? { localPath: input.localPath as never }
        : {}),
    });
    if (changed._tag === "err") return failure("invalid_input");
    const saved = await this.settings.saveProfile(changed.value);
    return saved._tag === "ok" ? ok(changed.value) : failure("storage");
  }

  async setLocalPath(
    input: unknown,
  ): Promise<Result<WorkspaceProfileConfig, DashboardControllerFailure>> {
    if (!isObject(input)) return failure("invalid_input");
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    const ref = repoRef(input);
    if (ref._tag === "err") return ref;
    const changed = updateWatchedRepoPath(
      profile.value,
      ref.value,
      typeof input.localPath === "string" && input.localPath.length > 0
        ? input.localPath
        : undefined,
    );
    if (changed._tag === "err") return failure("invalid_input");
    const saved = await this.settings.saveProfile(changed.value);
    return saved._tag === "ok" ? ok(changed.value) : failure("storage");
  }

  async removeWatchlistRepo(
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

  async archiveWatchlistRepo(
    input: unknown,
  ): Promise<Result<WorkspaceProfileConfig, DashboardControllerFailure>> {
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    const ref = repoRef(input);
    if (
      ref._tag === "err" ||
      !isObject(input) ||
      typeof input.archived !== "boolean"
    )
      return failure("invalid_input");
    const changed = setWatchedRepoArchived(
      profile.value,
      ref.value,
      input.archived,
    );
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

  async previewDirectEntry(
    value: unknown,
  ): Promise<Result<unknown, DashboardControllerFailure>> {
    if (!isObject(value) || typeof value.reference !== "string")
      return failure("invalid_input");
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    const pr = parsePullRequestEntry(value.reference, profile.value.githubHost);
    if (pr._tag === "err") return failure("invalid_input");
    const profiles = await this.listProfiles();
    if (profiles._tag === "err") return profiles;
    const suggestedId = suggestProfile(pr.value, profiles.value);
    const suggested =
      suggestedId._tag === "ok"
        ? profiles.value.find((candidate) => candidate.id === suggestedId.value)
        : undefined;
    return ok({
      pr: pr.value,
      confirmation: profileSwitchConfirmation(
        profile.value,
        suggested,
        pr.value,
      ),
    });
  }

  async testGitHubAccess(): Promise<
    Result<
      { readonly state: "available" | "github_auth" },
      DashboardControllerFailure
    >
  > {
    const profile = await this.activeProfile();
    if (profile._tag === "err") return profile;
    const dashboard = await this.dashboard.listPendingPullRequests(
      profile.value,
    );
    if (dashboard._tag === "err") return failure("storage");
    return ok({
      state: dashboard.value.repos.some((repo) => repo.state === "github_auth")
        ? "github_auth"
        : "available",
    });
  }

  private async activeProfile(): Promise<
    Result<WorkspaceProfileConfig, DashboardControllerFailure>
  > {
    const profiles = await this.listProfiles();
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

function repoRef(
  input: unknown,
): Result<WatchedRepoRef, DashboardControllerFailure> {
  if (!isObject(input)) return failure("invalid_input");
  const host = parseGitHubHost(input.host);
  const owner = parseGitHubOwner(input.owner);
  const repo = parseGitHubRepoName(input.repo);
  return host._tag === "ok" && owner._tag === "ok" && repo._tag === "ok"
    ? ok({ host: host.value, owner: owner.value, repo: repo.value })
    : failure("invalid_input");
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function failure(
  reason: DashboardControllerFailure["reason"],
): Result<never, DashboardControllerFailure> {
  return err({ _tag: "DashboardControllerFailure", reason });
}
