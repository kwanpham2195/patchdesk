import { homedir } from "node:os";

import {
  parseAbsolutePath,
  parseGitHubHost,
  parseWorkspaceProfileId,
  type AbsolutePath,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
} from "../domain/ids";
import { sameRepositoryIdentity } from "../domain/repository-identity";
import type {
  PatchdeskConfigFile,
  PatchdeskSettingsPatch,
} from "../domain/contracts";
import type { StorageFailure } from "../adapters/storage/json-file";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { CommandRunner } from "../adapters/github/command-runner";
import type {
  WatchedRepoConfig,
  WorkspaceProfileConfig,
} from "../domain/workspace-profile";
import { err, ok, type Result } from "../domain/result";

/** One watched repository as the main process holds it: branded, because
 * this is the side that parses GitHub identifiers. Structurally the same as
 * `InboxRepositoryRef` in `maintainer-inbox-service.ts` — see the note in
 * `repository-identity.ts`. */
export type WatchedRepoRef = {
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
};

export type ProfileMutationFailure = {
  readonly _tag: "ProfileMutationFailure";
  readonly reason: "duplicate_repo" | "repo_not_found" | "invalid_local_path";
};

/** Persists profile and active-profile choices through the only JSON storage boundary. */
export class ProfileSettingsService {
  private configMutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly store: ProfileStore) {}

  async saveProfile(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<void, StorageFailure>> {
    return await this.store.save(profile);
  }

  async selectProfile(
    profileId: WorkspaceProfileConfig["id"],
  ): Promise<Result<WorkspaceProfileConfig["id"], StorageFailure>> {
    return await this.runConfigMutation(async () => {
      const current = await this.store.loadConfig();
      if (current._tag === "err" && current.error.reason !== "not_found") {
        return current;
      }
      const config =
        current._tag === "ok"
          ? { ...current.value, lastSelectedProfileId: profileId }
          : { lastSelectedProfileId: profileId };
      const saved = await this.store.saveConfig(config);
      return saved._tag === "ok" ? ok(profileId) : saved;
    });
  }

  /** Loads normalized global settings, treating a missing first-run file as an empty config. */
  async loadSettings(): Promise<Result<PatchdeskConfigFile, StorageFailure>> {
    const stored = await this.store.loadConfig();
    if (stored._tag === "ok") return stored;
    return stored.error.reason === "not_found" ? ok({}) : stored;
  }

  /** Persists a parsed settings patch without changing the selected workspace profile. */
  async updateSettings(
    patch: PatchdeskSettingsPatch,
  ): Promise<Result<PatchdeskConfigFile, StorageFailure>> {
    return await this.runConfigMutation(async () => {
      const current = await this.loadSettings();
      if (current._tag === "err") return current;
      const next = { ...current.value, ...patch };
      const saved = await this.store.saveConfig(next);
      return saved._tag === "ok" ? ok(next) : saved;
    });
  }

  private async runConfigMutation<T>(
    mutation: () => Promise<Result<T, StorageFailure>>,
  ): Promise<Result<T, StorageFailure>> {
    const scheduled = this.configMutationTail.then(mutation, mutation);
    this.configMutationTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return await scheduled;
  }
}

/**
 * Bounded, non-blocking best-effort probe: bound chosen to match how
 * `GET /v1/environment` bounds its own `gh` probes (local-api.ts), so first-run
 * detection cannot hang startup on a stuck `gh`.
 */
const accountDetectionTimeoutMs = 5_000;

/**
 * Best-effort read of the login `gh` would authenticate API calls as right
 * now — no configured profile, no `--user` override, so it reflects
 * whichever account the local GitHub CLI is currently active as. Mirrors the
 * `gh api ... user --jq .login` shape `GitHubAdapter.resolveAuthenticatedAccount`
 * already uses to confirm a *known* profile's account
 * (`src/adapters/github/github-adapter.ts`), reusing the same `CommandRunner`
 * boundary rather than shelling out ad hoc. Unlike that method, this runs
 * before any profile exists, so there is no account to confirm against yet.
 * Returns `undefined` on any failure — missing `gh`, no `gh auth login`,
 * timeout, or unexpected output — since an undetectable account is a normal
 * first-run state, not an error worth surfacing.
 */
async function detectActiveGitHubAccount(
  commands: CommandRunner,
  host: GitHubHost,
): Promise<string | undefined> {
  const response = await commands.runText({
    argv: ["gh", "api", "--hostname", host, "user", "--jq", ".login"],
    timeoutMs: accountDetectionTimeoutMs,
  });
  if (response._tag === "err") return undefined;
  const login = response.value.trim();
  return login.length === 0 ? undefined : login;
}

/** The user's home directory, only if it validates as an absolute path. */
function detectHomeWorkspaceRoot(): AbsolutePath | undefined {
  const parsed = parseAbsolutePath(homedir());
  return parsed._tag === "ok" ? parsed.value : undefined;
}

/**
 * Derives the first-run profile from the actual machine instead of a
 * fabricated identity: the GitHub CLI's currently active account, if `gh` is
 * installed, authenticated, and answers within the bound; and the caller's
 * home directory, if it validates as an absolute path. `ownerFilters` is
 * always left empty — nobody's org is guessed. Detection is best-effort and
 * never fabricates a value: a field that cannot be derived stays empty so
 * the UI can prompt for it instead of silently inheriting someone else's
 * identity. The profile still never conveys a credential (no token is ever
 * read, logged, or persisted here).
 */
export async function detectDefaultWorkspaceProfile(
  commands: CommandRunner,
): Promise<Result<WorkspaceProfileConfig, ProfileMutationFailure>> {
  const id = parseWorkspaceProfileId("default");
  const host = parseGitHubHost("github.com");
  if (id._tag === "err" || host._tag === "err") {
    return err({
      _tag: "ProfileMutationFailure",
      reason: "invalid_local_path",
    });
  }
  const ghAccount = await detectActiveGitHubAccount(commands, host.value);
  const workspaceRoot = detectHomeWorkspaceRoot();
  return ok({
    id: id.value,
    label: "Default",
    githubHost: host.value,
    ghAccount: ghAccount ?? "",
    ownerFilters: [],
    workspaceRoots: workspaceRoot === undefined ? [] : [workspaceRoot],
    rulePaths: [],
    repos: [],
    analysisMergePolicy: "require_acknowledgement",
  });
}

/** Adds an explicitly chosen repo; discovery suggestions cannot enter the watchlist implicitly. */
export function addWatchedRepo(
  profile: WorkspaceProfileConfig,
  repo: WatchedRepoConfig,
): Result<WorkspaceProfileConfig, ProfileMutationFailure> {
  if (
    profile.repos.some((candidate) => sameRepositoryIdentity(candidate, repo))
  ) {
    return err({ _tag: "ProfileMutationFailure", reason: "duplicate_repo" });
  }
  return ok({ ...profile, repos: [...profile.repos, repo] });
}

/** Changes only the optional local checkout association for one watched GitHub repo. */
export function updateWatchedRepoPath(
  profile: WorkspaceProfileConfig,
  target: WatchedRepoRef,
  localPath: string | undefined,
): Result<WorkspaceProfileConfig, ProfileMutationFailure> {
  const parsedPath =
    localPath === undefined ? undefined : parseAbsolutePath(localPath);
  if (parsedPath !== undefined && parsedPath._tag === "err") {
    return err({
      _tag: "ProfileMutationFailure",
      reason: "invalid_local_path",
    });
  }
  if (
    !profile.repos.some((candidate) =>
      sameRepositoryIdentity(candidate, target),
    )
  ) {
    return err({ _tag: "ProfileMutationFailure", reason: "repo_not_found" });
  }
  const path: AbsolutePath | undefined =
    parsedPath === undefined ? undefined : parsedPath.value;
  return ok({
    ...profile,
    repos: profile.repos.map((repo) => {
      if (!sameRepositoryIdentity(repo, target)) return repo;
      const updated: WatchedRepoConfig = {
        host: repo.host,
        owner: repo.owner,
        repo: repo.repo,
      };
      return path === undefined ? updated : { ...updated, localPath: path };
    }),
  });
}

/** Removes one repo from the user-maintained watchlist without affecting other profile settings. */
export function removeWatchedRepo(
  profile: WorkspaceProfileConfig,
  target: WatchedRepoRef,
): Result<WorkspaceProfileConfig, ProfileMutationFailure> {
  if (
    !profile.repos.some((candidate) =>
      sameRepositoryIdentity(candidate, target),
    )
  ) {
    return err({ _tag: "ProfileMutationFailure", reason: "repo_not_found" });
  }
  return ok({
    ...profile,
    repos: profile.repos.filter(
      (repo) => !sameRepositoryIdentity(repo, target),
    ),
  });
}
