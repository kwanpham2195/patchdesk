import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  runWithCoalescedGitHubReads,
  type CommandExecution,
  type CommandExecutor,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import { GhRequestRunner } from "../../src/adapters/github/gh-request-runner";
import type { GitHubRequest } from "../../src/adapters/github/github-request";
import {
  parseWorkspaceProfileConfig,
  type WorkspaceProfileConfig,
} from "../../src/domain/workspace-profile";
import { StubCredentials } from "./stub-github-credentials";

function mustParse<T, E>(
  result:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err"; readonly error: E },
): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

function profileFor(account: string): WorkspaceProfileConfig {
  return mustParse(
    parseWorkspaceProfileConfig({
      id: account,
      label: account,
      githubHost: "github.com",
      ghAccount: account,
      workspaceRoots: [],
      rulePaths: [],
      repos: [],
    }),
  );
}

const profile = profileFor("pmquan2cfw");
const otherProfile = profileFor("pmquan2personal");

const pullRequest: GitHubRequest = {
  kind: "rest",
  host: "github.com",
  path: "repos/centraldigital/patchdesk/pulls/42",
};

/**
 * Counts executions and holds every one of them open until the test releases
 * it, which is what makes "two callers, one execution" a claim about
 * concurrency rather than about how fast the fake answers.
 */
class CountingExecutor implements CommandExecutor {
  readonly argvs: Array<ReadonlyArray<string>> = [];

  private readonly pending: Array<(execution: CommandExecution) => void> = [];

  constructor(private readonly answer: CommandExecution) {}

  async execute(input: CommandRequest): Promise<CommandExecution> {
    this.argvs.push(input.argv);
    return new Promise<CommandExecution>((resolve) => {
      this.pending.push(resolve);
    });
  }

  /** Lets every execution started so far finish. */
  releaseAll(): void {
    for (const resolve of this.pending.splice(0)) resolve(this.answer);
  }

  /** Resolves once `count` executions have started, and fails rather than hanging if they never do. */
  async started(count: number): Promise<void> {
    for (let turn = 0; turn < 100 && this.argvs.length < count; turn += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.argvs.length < count)
      throw new Error(
        `Only ${this.argvs.length} of ${count} executions started`,
      );
  }
}

function exited(stdout: string): CommandExecution {
  return { _tag: "Exited", exitCode: 0, stdout, stderr: "" };
}

function runnerFor(executor: CommandExecutor): GhRequestRunner {
  return new GhRequestRunner(
    new CommandRunner(executor),
    new StubCredentials(),
  );
}

describe("in-flight coalescing", () => {
  it("spends one execution on two concurrent identical reads, and answers both", async () => {
    const executor = new CountingExecutor(exited('{"number":42}'));
    const runner = runnerFor(executor);

    const results = await runWithCoalescedGitHubReads(async () => {
      const first = runner.ghJson(profile, pullRequest);
      const second = runner.ghJson(profile, pullRequest);
      await executor.started(1);
      executor.releaseAll();
      return Promise.all([first, second]);
    });

    expect(executor.argvs).toHaveLength(1);
    expect(results[0]).toEqual({ _tag: "ok", value: { number: 42 } });
    expect(results[1]).toEqual(results[0]);
  });

  /**
   * The invariant that keeps this from turning into a result cache. Every
   * deliberate re-verification in the Review path — the refresh service's
   * second pull request read, the observation service's identity recheck —
   * is separated from the read it verifies by an `await`, so it must reach
   * GitHub again. A completed entry left behind for even a moment would make
   * those guards prove nothing.
   */
  it("re-executes a read issued after the first one finished", async () => {
    const executor = new CountingExecutor(exited('{"number":42}'));
    const runner = runnerFor(executor);

    await runWithCoalescedGitHubReads(async () => {
      const first = runner.ghJson(profile, pullRequest);
      await executor.started(1);
      executor.releaseAll();
      await first;

      const second = runner.ghJson(profile, pullRequest);
      await executor.started(2);
      executor.releaseAll();
      await second;
    });

    expect(executor.argvs).toHaveLength(2);
  });

  it("keeps two profiles apart, because each call runs as its own account", async () => {
    const executor = new CountingExecutor(exited('{"number":42}'));
    const runner = runnerFor(executor);

    await runWithCoalescedGitHubReads(async () => {
      const mine = runner.ghJson(profile, pullRequest);
      const theirs = runner.ghJson(otherProfile, pullRequest);
      await executor.started(2);
      executor.releaseAll();
      await Promise.all([mine, theirs]);
    });

    expect(executor.argvs).toHaveLength(2);
  });

  it("gives both callers the same failure", async () => {
    const executor = new CountingExecutor({
      _tag: "Exited",
      exitCode: 1,
      stdout: "",
      stderr: "HTTP 500",
    });
    const runner = runnerFor(executor);

    const results = await runWithCoalescedGitHubReads(async () => {
      const first = runner.ghJson(profile, pullRequest);
      const second = runner.ghJson(profile, pullRequest);
      await executor.started(1);
      executor.releaseAll();
      return Promise.all([first, second]);
    });

    expect(executor.argvs).toHaveLength(1);
    expect(results[0]).toMatchObject({ _tag: "err" });
    expect(results[1]).toBe(results[0]);
  });

  it("sends a mutation twice, because two writes are two intents", async () => {
    const executor = new CountingExecutor(exited('{"data":{}}'));
    const runner = runnerFor(executor);
    const resolveThread: GitHubRequest = {
      kind: "graphql",
      host: "github.com",
      document: "mutation ResolveThread($id: ID!) { resolve(id: $id) { id } }",
      variables: [{ kind: "typed", name: "id", value: "PRRT_1" }],
    };

    await runWithCoalescedGitHubReads(async () => {
      const first = runner.ghJson(profile, resolveThread);
      const second = runner.ghJson(profile, resolveThread);
      await executor.started(2);
      executor.releaseAll();
      await Promise.all([first, second]);
    });

    expect(executor.argvs).toHaveLength(2);
  });

  it("does not coalesce outside a request scope", async () => {
    const executor = new CountingExecutor(exited('{"number":42}'));
    const runner = runnerFor(executor);

    const first = runner.ghJson(profile, pullRequest);
    const second = runner.ghJson(profile, pullRequest);
    await executor.started(2);
    executor.releaseAll();
    await Promise.all([first, second]);

    expect(executor.argvs).toHaveLength(2);
  });
});
