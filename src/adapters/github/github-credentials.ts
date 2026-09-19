import { type GitHubHost } from "../../domain/ids";
import { err, ok, type Result } from "../../domain/result";
import { type WorkspaceProfileConfig } from "../../domain/workspace-profile";
import { type CommandFailure, type CommandRunner } from "./command-runner";

const credentialTimeoutMs = 10_000;
const credentialCacheMs = 5 * 60_000;

/** Environment additions that bind one gh invocation to one GitHub account. */
export type GitHubCommandEnvironment = Readonly<Record<string, string>>;

/**
 * Resolves the credential of the account a workspace profile is configured with.
 * Every gh invocation runs as that account instead of the machine-wide active one.
 */
export interface GitHubCredentials {
  environmentFor(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<GitHubCommandEnvironment, CommandFailure>>;
  /**
   * The bearer token itself, for the HTTP transport that sends it as a request
   * header (ADR 0046). `environmentFor` stays because `git` still needs the
   * credential as a child-process environment.
   */
  tokenFor(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<string, CommandFailure>>;
  /** Drop a cached credential the host rejected so the next call re-reads it. */
  forget(profile: WorkspaceProfileConfig): void;
  /**
   * The login a live GitHub read already proved the currently cached
   * credential authenticates as, or `undefined` when nothing is proven for
   * the credential in hand. A token's identity cannot change while that same
   * token is cached, so a caller may trust this instead of asking GitHub
   * again.
   */
  verifiedAccount(profile: WorkspaceProfileConfig): string | undefined;
  /** Record what a live read proved about the credential currently cached for this profile. */
  recordVerifiedAccount(profile: WorkspaceProfileConfig, account: string): void;
}

/**
 * Reads per-account tokens from the GitHub CLI credential store.
 * Tokens stay in memory for the duration of the cache window and are never logged or persisted.
 */
export class GitHubCliCredentials implements GitHubCredentials {
  private readonly cached = new Map<
    string,
    {
      readonly token: string;
      readonly expiresAt: number;
      /** The login a live read proved this exact token authenticates as. */
      readonly verifiedAccount?: string;
    }
  >();

  constructor(private readonly commands: CommandRunner) {}

  async environmentFor(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<GitHubCommandEnvironment, CommandFailure>> {
    const token = await this.tokenFor(profile);
    return token._tag === "err"
      ? token
      : ok(tokenEnvironment(profile.githubHost, token.value));
  }

  async tokenFor(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<string, CommandFailure>> {
    const key = accountKey(profile);
    const cached = this.cached.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return ok(cached.token);
    }

    const response = await this.commands.runText({
      // `--user` reads the stored credential of that exact account, so the
      // machine-wide active account never decides who Patchdesk acts as.
      argv: [
        "gh",
        "auth",
        "token",
        "--hostname",
        profile.githubHost,
        "--user",
        profile.ghAccount,
      ],
      timeoutMs: credentialTimeoutMs,
    });
    if (response._tag === "err") return err(credentialFailure(response.error));
    const token = response.value.trim();
    if (token.length === 0)
      return err({ _tag: "CommandAuthenticationRequired" });
    this.cached.set(key, { token, expiresAt: Date.now() + credentialCacheMs });
    return ok(token);
  }

  forget(profile: WorkspaceProfileConfig): void {
    this.cached.delete(accountKey(profile));
  }

  verifiedAccount(profile: WorkspaceProfileConfig): string | undefined {
    const cached = this.cached.get(accountKey(profile));
    return cached !== undefined && cached.expiresAt > Date.now()
      ? cached.verifiedAccount
      : undefined;
  }

  recordVerifiedAccount(
    profile: WorkspaceProfileConfig,
    account: string,
  ): void {
    const key = accountKey(profile);
    const cached = this.cached.get(key);
    // Bound to the exact cached token: once it expires or `forget` drops it,
    // the proof goes with it and the next call re-reads GitHub.
    if (cached === undefined) return;
    this.cached.set(key, { ...cached, verifiedAccount: account });
  }
}

function accountKey(profile: WorkspaceProfileConfig): string {
  return `${profile.githubHost}\u0000${profile.ghAccount}`;
}

function tokenEnvironment(
  host: GitHubHost,
  token: string,
): GitHubCommandEnvironment {
  // gh reads GH_TOKEN for github.com and ghe.com hosts, and
  // GH_ENTERPRISE_TOKEN for GitHub Enterprise Server hosts.
  return isEnterpriseServerHost(host)
    ? { GH_ENTERPRISE_TOKEN: token }
    : { GH_TOKEN: token };
}

/**
 * A host that is neither github.com nor a GitHub Enterprise Cloud tenant, and
 * so carries its API under `/api/` on the host itself. Exported because the
 * HTTP client's base-URL rule splits the same three ways (ADR 0046) and must
 * not invent a second taxonomy.
 */
export function isEnterpriseServerHost(host: string): boolean {
  return host !== "github.com" && !host.endsWith(".ghe.com");
}

function credentialFailure(failure: CommandFailure): CommandFailure {
  // A missing or unreadable account credential is an authentication problem,
  // whatever exit shape gh used to report it.
  return failure._tag === "CommandUnavailable" ||
    failure._tag === "CommandTimedOut"
    ? failure
    : { _tag: "CommandAuthenticationRequired" };
}
