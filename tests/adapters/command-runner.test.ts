import type { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  CommandRunner,
  NodeCommandExecutor,
  normalizeCommandLabel,
  type CommandExecution,
  type CommandExecutor,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import {
  addLabelsToLabelableMutation,
  maintainerInboxQuery,
} from "../../src/adapters/github/github-graphql-queries";

class FakeCommandExecutor implements CommandExecutor {
  constructor(private readonly execution: CommandExecution) {}

  execute(_input: CommandRequest): Promise<CommandExecution> {
    return Promise.resolve(this.execution);
  }
}

describe("CommandRunner", () => {
  it("does not spawn when cancellation happens during executable discovery", async () => {
    let resolveDiscovery!: (path: string) => void;
    const discoverCalls: Array<string> = [];
    let spawnCallCount = 0;
    // SAFETY: this fake is asserted never invoked (spawnCallCount stays 0 for
    // this test), so it never needs to satisfy spawn's real return contract.
    const fakeSpawn = (() => {
      spawnCallCount += 1;
      throw new Error("spawn must not be called when discovery is cancelled");
    }) as typeof spawn;
    const executor = new NodeCommandExecutor((executable) => {
      discoverCalls.push(executable);
      return new Promise<string | undefined>((resolve) => {
        resolveDiscovery = resolve;
      });
    }, fakeSpawn);
    const controller = new AbortController();

    const pending = new CommandRunner(executor).runText({
      argv: ["runtime"],
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(discoverCalls).toEqual(["runtime"]));

    controller.abort();
    resolveDiscovery("/usr/bin/runtime");

    await expect(pending).resolves.toEqual({
      _tag: "err",
      error: { _tag: "CommandUnavailable" },
    });
    expect(spawnCallCount).toBe(0);
  });

  it("classifies a 403 rate-limit response as CommandRateLimited, not CommandForbidden", async () => {
    const executor = new FakeCommandExecutor({
      _tag: "Exited",
      exitCode: 1,
      stdout: "",
      stderr: "gh: API rate limit exceeded (HTTP 403)",
    });

    const result = await new CommandRunner(executor).runText({
      argv: ["gh", "api", "graphql"],
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "CommandRateLimited" },
    });
  });
});

describe("normalizeCommandLabel", () => {
  it("strips the query string and collapses the owner, repo and pull request number", () => {
    expect(
      normalizeCommandLabel([
        "gh",
        "api",
        "--hostname",
        "github.com",
        "repos/kwanpham2195/patchdesk/pulls/246/comments?per_page=100&page=1",
      ]),
    ).toBe("api GET repos/:owner/:repo/pulls/:n/comments");
  });

  it("keeps the method so a read and a write on one path stay distinct", () => {
    const path = "repos/kwanpham2195/patchdesk/pulls/246/reviews";
    expect(normalizeCommandLabel(["gh", "api", path])).toBe(
      "api GET repos/:owner/:repo/pulls/:n/reviews",
    );
    expect(normalizeCommandLabel(["gh", "api", "--method", "POST", path])).toBe(
      "api POST repos/:owner/:repo/pulls/:n/reviews",
    );
  });

  it("collapses a branch, a commit sha and a compare range", () => {
    expect(
      normalizeCommandLabel([
        "gh",
        "api",
        "repos/o/r/branches/feat%2Fspawn-log/protection",
      ]),
    ).toBe("api GET repos/:owner/:repo/branches/:branch/protection");
    expect(
      normalizeCommandLabel([
        "gh",
        "api",
        "repos/o/r/commits/8f2a1c9d4b6e0a3f5c7d9e1b2a4c6e8f0d2b4a69/check-runs",
      ]),
    ).toBe("api GET repos/:owner/:repo/commits/:sha/check-runs");
    expect(
      normalizeCommandLabel([
        "gh",
        "api",
        "repos/o/r/compare/abc1234...def5678",
      ]),
    ).toBe("api GET repos/:owner/:repo/compare/:range");
  });

  it("names a GraphQL call by its operation, and an anonymous one by its root field", () => {
    expect(
      normalizeCommandLabel([
        "gh",
        "api",
        "graphql",
        "-f",
        `query=${maintainerInboxQuery}`,
        "-F",
        "owner=kwanpham2195",
      ]),
    ).toBe("api graphql MaintainerInbox");
    expect(
      normalizeCommandLabel([
        "gh",
        "api",
        "graphql",
        "-f",
        `query=${addLabelsToLabelableMutation}`,
      ]),
    ).toBe("api graphql addLabelsToLabelable");
  });

  it("reduces a git command to its subcommand, never reading the credential helper", () => {
    const label = normalizeCommandLabel([
      "git",
      "-c",
      "credential.https://github.com.helper=!'/opt/homebrew/bin/gh' auth git-credential",
      "-C",
      "/Users/someone/worktrees/patchdesk",
      "fetch",
      "origin",
      "8f2a1c9:refs/patchdesk/head",
      "--no-tags",
    ]);
    expect(label).toBe("fetch");
  });

  it("labels a gh subcommand that is not api", () => {
    expect(normalizeCommandLabel(["gh", "auth", "status"])).toBe("auth status");
    expect(normalizeCommandLabel(["gh", "--version"])).toBe("version");
  });
});
