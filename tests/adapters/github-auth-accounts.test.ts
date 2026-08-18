import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import { listAuthenticatedGitHubAccounts } from "../../src/adapters/github/github-auth-accounts";

class FakeCommandExecutor implements CommandExecutor {
  constructor(private readonly execution: CommandExecution) {}

  execute(_input: CommandRequest): Promise<CommandExecution> {
    return Promise.resolve(this.execution);
  }
}

function exited(stdout: string): CommandExecution {
  return { _tag: "Exited", exitCode: 0, stdout, stderr: "" };
}

describe("listAuthenticatedGitHubAccounts", () => {
  it("parses multiple successful accounts across hosts", async () => {
    // Real shape observed against gh 2.96.0, `gh auth status --json hosts`
    // on a machine with three github.com accounts.
    const stdout = JSON.stringify({
      hosts: {
        "github.com": [
          {
            active: true,
            host: "github.com",
            login: "pmquan2cfw",
            state: "success",
            scopes: ["repo", "read:org"],
            gitProtocol: "https",
            tokenSource: "/Users/kwanpham/.config/gh/hosts.yml",
          },
          {
            active: false,
            host: "github.com",
            login: "kwanpham2195",
            state: "success",
            scopes: ["repo"],
            gitProtocol: "https",
            tokenSource: "keyring",
          },
          {
            active: false,
            host: "github.com",
            login: "matthew-opn",
            state: "success",
            scopes: ["repo"],
            gitProtocol: "https",
            tokenSource: "keyring",
          },
        ],
      },
    });
    const commands = new CommandRunner(new FakeCommandExecutor(exited(stdout)));

    const accounts = await listAuthenticatedGitHubAccounts(commands, 10_000);

    expect(accounts).toEqual([
      { host: "github.com", login: "pmquan2cfw", active: true },
      { host: "github.com", login: "kwanpham2195", active: false },
      { host: "github.com", login: "matthew-opn", active: false },
    ]);
  });

  it("drops an account whose state is not success", async () => {
    const stdout = JSON.stringify({
      hosts: {
        "github.com": [
          {
            active: true,
            host: "github.com",
            login: "good-account",
            state: "success",
            tokenSource: "keyring",
          },
          {
            active: false,
            host: "github.com",
            login: "stale-account",
            state: "invalid token",
            tokenSource: "keyring",
          },
        ],
      },
    });
    const commands = new CommandRunner(new FakeCommandExecutor(exited(stdout)));

    const accounts = await listAuthenticatedGitHubAccounts(commands, 10_000);

    expect(accounts).toEqual([
      { host: "github.com", login: "good-account", active: true },
    ]);
  });

  it("degrades to an empty list for malformed gh output", async () => {
    const commands = new CommandRunner(
      new FakeCommandExecutor(exited("not json at all")),
    );

    const accounts = await listAuthenticatedGitHubAccounts(commands, 10_000);

    expect(accounts).toEqual([]);
  });

  it("degrades to an empty list when the JSON does not match the expected shape", async () => {
    const commands = new CommandRunner(
      new FakeCommandExecutor(exited(JSON.stringify({ unexpected: true }))),
    );

    const accounts = await listAuthenticatedGitHubAccounts(commands, 10_000);

    expect(accounts).toEqual([]);
  });

  it("degrades to an empty list when gh is missing entirely", async () => {
    const commands = new CommandRunner(
      new FakeCommandExecutor({ _tag: "Unavailable" }),
    );

    const accounts = await listAuthenticatedGitHubAccounts(commands, 10_000);

    expect(accounts).toEqual([]);
  });

  it("never exposes tokenSource or scopes on the returned accounts", async () => {
    const stdout = JSON.stringify({
      hosts: {
        "github.com": [
          {
            active: true,
            host: "github.com",
            login: "pmquan2cfw",
            state: "success",
            scopes: ["repo", "read:org"],
            gitProtocol: "https",
            tokenSource: "/Users/kwanpham/.config/gh/hosts.yml",
          },
        ],
      },
    });
    const commands = new CommandRunner(new FakeCommandExecutor(exited(stdout)));

    const accounts = await listAuthenticatedGitHubAccounts(commands, 10_000);

    expect(accounts).toEqual([
      { host: "github.com", login: "pmquan2cfw", active: true },
    ]);
    for (const account of accounts) {
      expect(Object.keys(account).sort()).toEqual(["active", "host", "login"]);
      expect(JSON.stringify(account)).not.toContain("tokenSource");
      expect(JSON.stringify(account)).not.toContain("scopes");
      expect(JSON.stringify(account)).not.toContain("hosts.yml");
      expect(JSON.stringify(account)).not.toContain("keyring");
    }
  });
});
