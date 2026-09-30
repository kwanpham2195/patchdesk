import type { CommandRunner } from "../adapters/github/command-runner";
import type { AbsolutePath, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import { sameRepositoryIdentity } from "../domain/repository-identity";
import type {
  WatchedRepoConfig,
  WorkspaceProfileConfig,
} from "../domain/workspace-profile";
import type {
  DashboardController,
  DashboardControllerFailure,
} from "./dashboard-controller";
import type {
  GitHubEnvironmentProbe,
  GitHubEnvironmentSnapshot,
} from "./github-environment-probe";
import { missingCheckout, readCheckoutOrigin } from "./local-checkout";
import { detectDefaultWorkspaceProfile } from "./profile-service";
import type { GitReadExecutor } from "./review-worktree-service";

type RepositoryRef = Omit<WatchedRepoConfig, "localPath">;

type ProfileSummary = {
  readonly id: WorkspaceProfileId;
  readonly label: string;
  readonly ghAccount: string;
};

/** What `patchdesk setup status` reports: the environment, the active profile, and each repository's checkout. */
export type WorkspaceSetupStatus = GitHubEnvironmentSnapshot & {
  readonly profile?: ProfileSummary;
  readonly repositories: ReadonlyArray<
    RepositoryRef & {
      readonly localPath?: AbsolutePath;
      /** `missing` when the saved checkout is no longer a folder, as after a move. */
      readonly checkout: "chosen" | "not_chosen" | "missing";
    }
  >;
};

export type WorkspaceRepositorySet = {
  readonly profile: ProfileSummary;
  /** True when this call created the profile from the active `gh` account. */
  readonly profileCreated: boolean;
  /** False when the repository was already watched. */
  readonly repositoryAdded: boolean;
  readonly repository: RepositoryRef;
  readonly localPath: AbsolutePath;
};

export type WorkspaceSetupFailure = {
  readonly reason:
    | "no_github_account"
    | "no_profile"
    | "not_watched"
    | "checkout_not_a_repository"
    | "checkout_no_github_origin"
    /** The origin names a host other than the workspace's GitHub host, such as GitLab or an SSH host alias. */
    | "checkout_other_host"
    | "checkout_origin_mismatch"
    | "invalid_input"
    | "storage";
};

type SetupDashboard = Pick<
  DashboardController,
  | "savedProfiles"
  | "saveProfile"
  | "selectProfile"
  | "updateWatchlist"
  | "chooseWatchedRepoCheckout"
>;

/**
 * `patchdesk setup` (#702): lets a coding agent finish workspace setup from
 * its working directory. Every write goes through the controller methods the
 * Settings routes call, so a setup command is validated and saved exactly as
 * the same change made in Settings.
 */
export class WorkspaceSetupService {
  constructor(
    private readonly dependencies: {
      readonly dashboard: SetupDashboard;
      readonly git: GitReadExecutor;
      readonly commands: CommandRunner;
      readonly environment: Pick<GitHubEnvironmentProbe, "read">;
    },
  ) {}

  async status(): Promise<Result<WorkspaceSetupStatus, WorkspaceSetupFailure>> {
    const [environment, profiles] = await Promise.all([
      this.dependencies.environment.read({ recheck: false }),
      this.dependencies.dashboard.savedProfiles(),
    ]);
    if (profiles._tag === "err")
      return profiles.error.reason === "no_profile"
        ? ok({ ...environment, repositories: [] })
        : err({ reason: "storage" });
    const active = profiles.value.active;
    const repositories = await Promise.all(
      active.repos.map(async ({ localPath, ...repository }) =>
        localPath === undefined
          ? { ...repository, checkout: "not_chosen" as const }
          : {
              ...repository,
              localPath,
              checkout:
                (await missingCheckout(localPath)) === undefined
                  ? ("chosen" as const)
                  : ("missing" as const),
            },
      ),
    );
    return ok({ ...environment, profile: summary(active), repositories });
  }

  /**
   * Watches the repository whose `origin` the checkout holding `folder`
   * names, with that checkout as its local path. With no saved profile it
   * first creates the Default one from the active `gh` account, as first run
   * does.
   */
  async addRepository(
    folder: AbsolutePath,
  ): Promise<Result<WorkspaceRepositorySet, WorkspaceSetupFailure>> {
    const read = await readCheckoutOrigin(this.dependencies.git, folder);
    if (read._tag === "err") return read;
    const repository = read.value.origin;
    const profile = await this.activeOrCreatedProfile(repository.host);
    if (profile._tag === "err") return profile;
    const { active, created } = profile.value;
    const watched = active.repos.find((candidate) =>
      sameRepositoryIdentity(candidate, repository),
    );
    // An add never moves a checkout that still exists: an agent in a
    // throwaway worktree would otherwise point every Review at a folder that
    // is about to go. `set-checkout` is the explicit move.
    if (
      watched?.localPath !== undefined &&
      (await missingCheckout(watched.localPath)) === undefined
    )
      return ok({
        profile: summary(active),
        profileCreated: created,
        repositoryAdded: false,
        repository,
        localPath: watched.localPath,
      });
    if (watched === undefined) {
      const added = await this.dependencies.dashboard.updateWatchlist({
        profileId: active.id,
        add: [repository],
        remove: [],
      });
      if (added._tag === "err") return err(fromDashboard(added.error));
    }
    return await this.chooseCheckout(active, repository, read.value.root, {
      profileCreated: created,
      repositoryAdded: watched === undefined,
    });
  }

  /** Sets the checkout holding `folder` as the local path of the watched repository its `origin` names. */
  async setCheckout(
    folder: AbsolutePath,
  ): Promise<Result<WorkspaceRepositorySet, WorkspaceSetupFailure>> {
    const read = await readCheckoutOrigin(this.dependencies.git, folder);
    if (read._tag === "err") return read;
    const profiles = await this.dependencies.dashboard.savedProfiles();
    if (profiles._tag === "err") return profiles;
    const active = profiles.value.active;
    const repository = read.value.origin;
    if (repository.host !== active.githubHost)
      return err({ reason: "checkout_other_host" });
    if (!isWatched(active, repository)) return err({ reason: "not_watched" });
    return await this.chooseCheckout(active, repository, read.value.root, {
      profileCreated: false,
      repositoryAdded: false,
    });
  }

  private async chooseCheckout(
    profile: WorkspaceProfileConfig,
    repository: RepositoryRef,
    root: AbsolutePath,
    outcome: Pick<WorkspaceRepositorySet, "profileCreated" | "repositoryAdded">,
  ): Promise<Result<WorkspaceRepositorySet, WorkspaceSetupFailure>> {
    const chosen = await this.dependencies.dashboard.chooseWatchedRepoCheckout({
      profileId: profile.id,
      ...repository,
      localPath: root,
    });
    if (chosen._tag === "err") return err(fromDashboard(chosen.error));
    return ok({
      profile: summary(chosen.value),
      ...outcome,
      repository,
      localPath: root,
    });
  }

  /**
   * The saved active profile, or the Default one made from the active `gh`
   * account, when its GitHub host is `host`. It detects afresh on every call,
   * unlike first run's memo, so a user who runs `gh auth login` after a
   * refusal can run the command again. A checkout on another host is refused
   * before anything is saved.
   */
  private async activeOrCreatedProfile(
    host: string,
  ): Promise<
    Result<
      { readonly active: WorkspaceProfileConfig; readonly created: boolean },
      WorkspaceSetupFailure
    >
  > {
    const { dashboard, commands } = this.dependencies;
    const saved = await dashboard.savedProfiles();
    if (saved._tag === "ok")
      return saved.value.active.githubHost === host
        ? ok({ active: saved.value.active, created: false })
        : err({ reason: "checkout_other_host" });
    if (saved.error.reason === "storage") return err({ reason: "storage" });
    const detected = await detectDefaultWorkspaceProfile(commands);
    if (detected._tag === "err") return err({ reason: "storage" });
    const { id, label, githubHost, ghAccount, rulePaths } = detected.value;
    if (githubHost !== host) return err({ reason: "checkout_other_host" });
    if (ghAccount.length === 0) return err({ reason: "no_github_account" });
    const created = await dashboard.saveProfile({
      id,
      label,
      githubHost,
      ghAccount,
      rulePaths,
    });
    if (created._tag === "err") return err(fromDashboard(created.error));
    const selected = await dashboard.selectProfile(created.value.id);
    return selected._tag === "ok"
      ? ok({ active: selected.value, created: true })
      : err(fromDashboard(selected.error));
  }
}

function summary(profile: WorkspaceProfileConfig): ProfileSummary {
  return { id: profile.id, label: profile.label, ghAccount: profile.ghAccount };
}

function isWatched(
  profile: WorkspaceProfileConfig,
  repository: RepositoryRef,
): boolean {
  return profile.repos.some((watched) =>
    sameRepositoryIdentity(watched, repository),
  );
}

function fromDashboard(
  failure: DashboardControllerFailure,
): WorkspaceSetupFailure {
  switch (failure.reason) {
    case "checkout_not_a_repository":
    case "checkout_origin_mismatch":
    case "invalid_input":
    case "storage":
      return { reason: failure.reason };
    case "not_found":
      return { reason: "not_watched" };
  }
}
