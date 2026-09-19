import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import { GitHubEnvironmentProbe } from "../../src/services/github-environment-probe";

/** Records every argv it is given, so a test can count `gh auth status` spawns. */
class RecordingCommandExecutor implements CommandExecutor {
  readonly argvs: Array<ReadonlyArray<string>> = [];

  constructor(
    private readonly respond: (argv: ReadonlyArray<string>) => CommandExecution,
  ) {}

  execute(input: CommandRequest): Promise<CommandExecution> {
    this.argvs.push(input.argv);
    return Promise.resolve(this.respond(input.argv));
  }

  authStatusSpawns(): number {
    return this.argvs.filter(
      (argv) => argv[0] === "gh" && argv[1] === "auth" && argv[2] === "status",
    ).length;
  }
}

function authenticated(argv: ReadonlyArray<string>): CommandExecution {
  if (!argv.includes("--json"))
    return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" };
  const hosts = {
    "github.com": [
      {
        active: true,
        host: "github.com",
        login: "kwanpham2195",
        state: "success",
      },
    ],
  };
  return {
    _tag: "Exited",
    exitCode: 0,
    stdout: JSON.stringify({ hosts }),
    stderr: "",
  };
}

function unauthenticated(argv: ReadonlyArray<string>): CommandExecution {
  if (!argv.includes("auth"))
    return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" };
  return {
    _tag: "Exited",
    exitCode: 1,
    stdout: argv.includes("--json") ? JSON.stringify({ hosts: {} }) : "",
    stderr:
      "You are not logged into any GitHub hosts. To log in, run: gh auth login",
  };
}

describe("GitHubEnvironmentProbe", () => {
  it("runs gh auth status once across four sequential reads", async () => {
    const executor = new RecordingCommandExecutor(authenticated);
    const probe = new GitHubEnvironmentProbe(new CommandRunner(executor));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(probe.read({ recheck: false })).resolves.toMatchObject({
        githubAuth: "ready",
        githubAccounts: [
          { host: "github.com", login: "kwanpham2195", active: true },
        ],
      });
    }

    expect(executor.authStatusSpawns()).toBe(1);
  });

  it("runs gh auth status once for concurrent reads", async () => {
    const executor = new RecordingCommandExecutor(authenticated);
    const probe = new GitHubEnvironmentProbe(new CommandRunner(executor));

    await Promise.all([
      probe.read({ recheck: false }),
      probe.read({ recheck: false }),
    ]);

    expect(executor.authStatusSpawns()).toBe(1);
  });

  it("does not hold an unauthenticated answer", async () => {
    const executor = new RecordingCommandExecutor(unauthenticated);
    const probe = new GitHubEnvironmentProbe(new CommandRunner(executor));

    await expect(probe.read({ recheck: false })).resolves.toMatchObject({
      githubAuth: "authentication_required",
      githubAccounts: [],
    });
    await probe.read({ recheck: false });

    // Two reads, and each one falls through to the plain probe because no
    // account was listed: four spawns rather than one held answer.
    expect(executor.authStatusSpawns()).toBe(4);
  });

  it("asks gh again on an explicit re-check", async () => {
    const executor = new RecordingCommandExecutor(authenticated);
    const probe = new GitHubEnvironmentProbe(new CommandRunner(executor));

    await probe.read({ recheck: false });
    await probe.read({ recheck: true });
    await probe.read({ recheck: false });

    expect(executor.authStatusSpawns()).toBe(2);
  });
});
