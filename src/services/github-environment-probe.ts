import type { CommandRunner } from "../adapters/github/command-runner";
import {
  listAuthenticatedGitHubAccounts,
  type GitHubAuthAccount,
} from "../adapters/github/github-auth-accounts";

const TOOL_VERSION_TIMEOUT_MS = 5_000;
const GITHUB_AUTH_TIMEOUT_MS = 10_000;

/** The local tool and GitHub authentication state `GET /v1/environment` reports. */
export type GitHubEnvironmentSnapshot = {
  readonly git: "ready" | "missing";
  readonly gh: "ready" | "missing";
  readonly githubAuth: "ready" | "authentication_required" | "unavailable";
  readonly githubAccounts: ReadonlyArray<GitHubAuthAccount>;
};

/**
 * Answers `GET /v1/environment`, running `gh auth status` once per launch.
 *
 * `gh auth status` takes about 1.6 s on the maintainer's machine and several
 * screens ask for this state, so a ready answer is held for the life of this
 * instance (one per local API start) and concurrent callers share the one
 * probe. Only a ready answer is held: a maintainer who runs `gh auth login`
 * and comes back is re-probed, and the Re-check button bypasses the held
 * answer through `recheck` whatever it says.
 */
export class GitHubEnvironmentProbe {
  /** The launch's ready answer, or the probe still in flight. */
  private held: Promise<GitHubEnvironmentSnapshot> | undefined;

  constructor(private readonly commands: CommandRunner) {}

  async read(options: {
    readonly recheck: boolean;
  }): Promise<GitHubEnvironmentSnapshot> {
    if (options.recheck) this.held = undefined;
    const probe = this.held ?? this.probe();
    this.held = probe;
    // Every failure below is a value, so an awaited probe never rejects.
    const snapshot = await probe;
    if (snapshot.githubAuth !== "ready" && this.held === probe)
      this.held = undefined;
    return snapshot;
  }

  private async probe(): Promise<GitHubEnvironmentSnapshot> {
    const [git, gh, githubAccounts] = await Promise.all([
      this.commands.runText({
        argv: ["git", "--version"],
        timeoutMs: TOOL_VERSION_TIMEOUT_MS,
      }),
      this.commands.runText({
        argv: ["gh", "--version"],
        timeoutMs: TOOL_VERSION_TIMEOUT_MS,
      }),
      listAuthenticatedGitHubAccounts(this.commands, GITHUB_AUTH_TIMEOUT_MS),
    ]);
    return {
      git: git._tag === "ok" ? "ready" : "missing",
      gh: gh._tag === "ok" ? "ready" : "missing",
      githubAuth: await this.githubAuth(githubAccounts),
      githubAccounts,
    };
  }

  /**
   * A working account decides readiness on its own — plain `gh auth status`
   * exits nonzero when any listed account is invalid — so it runs only when
   * the JSON probe listed none. That is a second 1.6 s `gh auth status`
   * spawn, and all it still decides is whether an empty list means "not
   * authenticated" or "gh could not answer".
   */
  private async githubAuth(
    accounts: ReadonlyArray<GitHubAuthAccount>,
  ): Promise<GitHubEnvironmentSnapshot["githubAuth"]> {
    if (accounts.length > 0) return "ready";
    const status = await this.commands.runText({
      argv: ["gh", "auth", "status"],
      timeoutMs: GITHUB_AUTH_TIMEOUT_MS,
    });
    if (status._tag === "ok") return "ready";
    return status.error._tag === "CommandAuthenticationRequired"
      ? "authentication_required"
      : "unavailable";
  }
}
