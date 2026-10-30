import type {
  LocalRepositoryService,
  LocalRepositoryFailure,
  RegisteredCheckout,
  RelocatedCheckout,
  RelocationFailure,
} from "./local-repository-service";
import {
  parseLocalRepositoryId,
  type LocalRepositoryRegistration,
} from "#src/domain/local-repository";
import type { GitHubConnection } from "#src/domain/workspace-profile";
import type { CommandRunner } from "#src/adapters/github/command-runner";
import type { AbsolutePath, WorkspaceProfileId } from "#src/domain/ids";
import { definedProps } from "#src/domain/defined-props";
import { err, ok, type Result } from "#src/domain/result";
import { sameRepositoryIdentity } from "#src/domain/repository-identity";
import type {
  WatchedRepoConfig,
  WorkspaceProfileConfig,
} from "#src/domain/workspace-profile";
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
  readonly ghAccount?: string;
};

/** What `patchdesk setup status` reports: the environment, the active profile, and each repository's checkout. */
export type WorkspaceSetupStatus = Omit<
  GitHubEnvironmentSnapshot,
  "gh" | "githubAuth"
> & {
  readonly gh: GitHubEnvironmentSnapshot["gh"] | "not_checked";
  readonly githubAuth: GitHubEnvironmentSnapshot["githubAuth"] | "not_checked";
  readonly github: GitHubConnection;
  readonly localRepositories: ReadonlyArray<LocalRepositoryRegistration>;
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
    | "storage"
    | LocalRepositoryFailure["reason"]
    | RelocationFailure["reason"];
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
      readonly repositories: Pick<
        LocalRepositoryService,
        "register" | "list" | "setWatchedCheckout" | "relocate"
      >;
      readonly git: GitReadExecutor;
      readonly commands: CommandRunner;
      readonly environment: Pick<GitHubEnvironmentProbe, "read">;
    },
  ) {}

  async status(): Promise<Result<WorkspaceSetupStatus, WorkspaceSetupFailure>> {
    const profiles = await this.dependencies.dashboard.savedProfiles();
    const github =
      profiles._tag === "ok"
        ? profiles.value.active.github
        : ({ kind: "disconnected" } as const);
    const environment =
      github.kind === "connected"
        ? await this.dependencies.environment.read({ recheck: false })
        : {
            git:
              (
                await this.dependencies.commands.runText({
                  argv: ["git", "--version"],
                  timeoutMs: 5_000,
                })
              )._tag === "ok"
                ? ("ready" as const)
                : ("missing" as const),
            gh: "not_checked" as const,
            githubAuth: "not_checked" as const,
            githubAccounts: [],
          };
    if (profiles._tag === "err")
      return profiles.error.reason === "no_profile"
        ? ok({
            ...environment,
            github,
            localRepositories: [],
            repositories: [],
          })
        : err({ reason: "storage" });
    const active = profiles.value.active;
    const [repositories, local] = await Promise.all([
      Promise.all(
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
      ),
      this.dependencies.repositories.list(active.id),
    ]);
    if (local._tag === "err") return local;
    return ok({
      ...environment,
      github,
      localRepositories: local.value,
      profile: summary(active),
      repositories,
    });
  }

  async addCheckout(
    folder: AbsolutePath,
  ): Promise<Result<RegisteredCheckout, WorkspaceSetupFailure>> {
    return this.dependencies.repositories.register(folder);
  }

  async relocateCheckout(
    repositoryId: string,
    folder: AbsolutePath,
    confirm: boolean,
  ): Promise<Result<RelocatedCheckout, WorkspaceSetupFailure>> {
    const id = parseLocalRepositoryId(repositoryId);
    if (id._tag === "err") return err({ reason: "invalid_input" });
    return this.dependencies.repositories.relocate(id.value, folder, confirm);
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
    if (
      active.github.kind !== "connected" ||
      repository.host !== active.github.host
    )
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
    const chosen = await this.dependencies.dashboard.chooseWatchedRepoCheckout(
      { profileId: profile.id, ...repository, localPath: root },
      this.dependencies.repositories,
    );
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
      return saved.value.active.github.kind === "connected" &&
        saved.value.active.github.host === host
        ? ok({ active: saved.value.active, created: false })
        : err({ reason: "checkout_other_host" });
    if (saved.error.reason === "storage") return err({ reason: "storage" });
    const detected = await detectDefaultWorkspaceProfile(commands);
    if (detected._tag === "err") return err({ reason: "storage" });
    const { id, label, github, rulePaths } = detected.value;
    if (github.kind !== "connected")
      return err({ reason: "no_github_account" });
    const { host: githubHost, account: ghAccount } = github;
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
  return {
    id: profile.id,
    label: profile.label,
    ...definedProps({
      ghAccount:
        profile.github.kind === "connected"
          ? profile.github.account
          : undefined,
    }),
  };
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
    case "registration_conflict":
      return { reason: failure.reason };
    case "not_found":
      return { reason: "not_watched" };
  }
}
