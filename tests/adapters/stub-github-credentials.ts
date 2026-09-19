import type { CommandFailure } from "../../src/adapters/github/command-runner";
import type { GitHubCredentials } from "../../src/adapters/github/github-credentials";
import { ok, type Result } from "../../src/domain/result";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";

/**
 * Resolves a fixed credential so command expectations stay about gh argv.
 *
 * The verified-account memory is real, not a stub: `GitHubCliCredentials`
 * binds that proof to the cached token, so a test asserting how many `GET
 * user` calls one flow makes needs a double that remembers the same way.
 */
export class StubCredentials implements GitHubCredentials {
  /** The `ghAccount` of every profile whose credential was dropped, in order. */
  readonly forgotten: Array<string> = [];

  private readonly verified = new Map<string, string>();

  async environmentFor(): Promise<
    Result<Readonly<Record<string, string>>, CommandFailure>
  > {
    return ok({ GH_TOKEN: "profile-token" });
  }

  async tokenFor(): Promise<Result<string, CommandFailure>> {
    return ok("profile-token");
  }

  forget(profile: WorkspaceProfileConfig): void {
    this.forgotten.push(profile.ghAccount);
    this.verified.delete(key(profile));
  }

  verifiedAccount(profile: WorkspaceProfileConfig): string | undefined {
    return this.verified.get(key(profile));
  }

  recordVerifiedAccount(
    profile: WorkspaceProfileConfig,
    account: string,
  ): void {
    this.verified.set(key(profile), account);
  }
}

function key(profile: WorkspaceProfileConfig): string {
  return `${profile.githubHost}\u0000${profile.ghAccount}`;
}
