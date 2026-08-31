import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import { WorkspaceOriginFinder } from "../../src/adapters/github/workspace-origin-finder";

class FakeCommandExecutor implements CommandExecutor {
  readonly requests: CommandRequest[] = [];

  constructor(
    private readonly executeRequest: (
      input: CommandRequest,
    ) => CommandExecution,
  ) {}

  execute(input: CommandRequest): Promise<CommandExecution> {
    this.requests.push(input);
    return Promise.resolve(this.executeRequest(input));
  }
}

function exited(stdout: string): CommandExecution {
  return { _tag: "Exited", exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string): CommandExecution {
  return { _tag: "Exited", exitCode: 1, stdout: "", stderr };
}

type FinderFixture = {
  readonly finder: WorkspaceOriginFinder;
  readonly executor: FakeCommandExecutor;
};

function finderFor(
  executeRequest: (input: CommandRequest) => CommandExecution,
): FinderFixture {
  const executor = new FakeCommandExecutor(executeRequest);
  return {
    finder: new WorkspaceOriginFinder(new CommandRunner(executor)),
    executor,
  };
}

describe("WorkspaceOriginFinder", () => {
  it("keeps a failed root beside a ready root without exposing command output", async () => {
    const { finder } = finderFor((input) => {
      if (input.argv[0] === "find" && input.argv[1] === "/failed")
        return failed("/secret/path: permission denied");
      if (input.argv[0] === "find") return exited("/ready/repo/.git\n");
      return exited("git@github.com:patchdesk/ready.git\n");
    });

    const result = await finder.find(["/failed", "/ready"]);

    expect(result).toEqual([
      { root: "/failed", state: "failed", reason: "scan_failed" },
      {
        root: "/ready",
        state: "ready",
        origins: [
          {
            origin: "git@github.com:patchdesk/ready.git",
            localPath: "/ready/repo",
          },
        ],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("/secret/path");
  });

  it("returns one failed result per root when every scan fails", async () => {
    const { finder } = finderFor(() => failed("private stderr"));

    await expect(finder.find(["/first", "/second"])).resolves.toEqual([
      { root: "/first", state: "failed", reason: "scan_failed" },
      { root: "/second", state: "failed", reason: "scan_failed" },
    ]);
  });

  it("scans duplicate roots once and preserves first-input order", async () => {
    const { finder, executor } = finderFor((input) => {
      if (input.argv[0] === "find") return exited("");
      throw new Error("No remote should be read for an empty root");
    });

    await expect(
      finder.find(["/second", "/first", "/second"]),
    ).resolves.toEqual([
      { root: "/second", state: "ready", origins: [] },
      { root: "/first", state: "ready", origins: [] },
    ]);
    expect(executor.requests.map((request) => request.argv)).toEqual([
      [
        "find",
        "/second",
        "-maxdepth",
        "4",
        "-type",
        "d",
        "-name",
        ".git",
        "-print",
      ],
      [
        "find",
        "/first",
        "-maxdepth",
        "4",
        "-type",
        "d",
        "-name",
        ".git",
        "-print",
      ],
    ]);
  });

  it("skips failed remotes and retains the first directory for duplicate origins", async () => {
    const { finder } = finderFor((input) => {
      if (input.argv[0] === "find")
        return exited(
          "/root/first/.git\n/root/broken/.git\n/root/second/.git\n/root/other/.git\n",
        );
      const directory = input.argv[2];
      if (directory === "/root/broken") return failed("remote command failed");
      if (directory === "/root/first" || directory === "/root/second")
        return exited("https://github.com/patchdesk/same.git\n");
      return exited("https://github.com/patchdesk/other.git\n");
    });

    await expect(finder.find(["/root"])).resolves.toEqual([
      {
        root: "/root",
        state: "ready",
        origins: [
          {
            origin: "https://github.com/patchdesk/same.git",
            localPath: "/root/first",
          },
          {
            origin: "https://github.com/patchdesk/other.git",
            localPath: "/root/other",
          },
        ],
      },
    ]);
  });
});
