import type { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  CommandRunner,
  NodeCommandExecutor,
  type CommandExecution,
  type CommandExecutor,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";

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
