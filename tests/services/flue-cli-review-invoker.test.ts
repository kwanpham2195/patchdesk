import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
} from "../../src/adapters/github/command-runner";
import { FlueCliReviewInvoker } from "../../src/services/flue-cli-review-invoker";

class FakeExecutor implements CommandExecutor {
  readonly requests: Array<{
    readonly argv: ReadonlyArray<string>;
    readonly environment?: Record<string, string>;
    readonly signal?: AbortSignal;
  }> = [];
  constructor(private readonly response: CommandExecution) {}
  async execute(input: {
    readonly argv: ReadonlyArray<string>;
    readonly environment?: Record<string, string>;
    readonly signal?: AbortSignal;
  }): Promise<CommandExecution> {
    this.requests.push({
      argv: input.argv,
      ...(input.environment === undefined
        ? {}
        : { environment: input.environment }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return this.response;
  }
}

const input = {
  profileId: "cfw",
  sessionId:
    "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__0123456789ab",
  contextPath: "/tmp/context.json",
  reviewInputPath: "/tmp/review-input.md",
  patchPath: "/tmp/patch.diff",
  worktreePath: "/tmp/worktree",
  model: "model",
  reasoning: "medium" as const,
};
const result = {
  changeSummary: "Adds a guarded write.",
  verdict: "comment",
  summary: "One safe finding.",
  findings: [
    {
      id: "guarded-write",
      severity: "P2",
      title: "Validate the guard",
      explanation: "The write needs the guard.",
      confidence: "high",
    },
  ],
  validationPlan: [],
  assumptions: [],
};

describe("FlueCliReviewInvoker", () => {
  it("passes only current session-level inputs to the fixed finite workflow", async () => {
    const executor = new FakeExecutor({
      _tag: "Exited",
      exitCode: 0,
      stdout: JSON.stringify(result),
      stderr: "private events",
    });
    const invoker = new FlueCliReviewInvoker(
      new CommandRunner(executor),
      "/workspace/patchdesk",
      "/runtime/node",
      "/runtime/flue.mjs",
    );
    await expect(invoker.invoke(input)).resolves.toMatchObject({
      _tag: "ok",
      value: { verdict: "comment" },
    });
    expect(executor.requests).toEqual([
      {
        argv: [
          "/runtime/node",
          "/runtime/flue.mjs",
          "run",
          "workflow:review-pr",
          "--input",
          JSON.stringify(input),
        ],
        environment: { ELECTRON_RUN_AS_NODE: "1" },
      },
    ]);
    const request = JSON.stringify(executor.requests[0]?.argv).toLowerCase();
    for (const removed of [
      "att" + "empt",
      "incre" + "mental",
      "completion",
      "ba" + "tch",
    ])
      expect(request).not.toContain(removed);
  });

  it("does not launch a process when cancellation was requested first", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = new FakeExecutor({
      _tag: "Exited",
      exitCode: 0,
      stdout: JSON.stringify(result),
      stderr: "",
    });
    const invoker = new FlueCliReviewInvoker(
      new CommandRunner(executor),
      "/workspace/patchdesk",
    );
    await expect(
      invoker.invoke(input, { signal: controller.signal }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "cancelled" } });
    expect(executor.requests).toEqual([]);
  });

  it("maps invalid output and runtime failures without returning command output", async () => {
    const invalid = new FlueCliReviewInvoker(
      new CommandRunner(
        new FakeExecutor({
          _tag: "Exited",
          exitCode: 0,
          stdout: "{}",
          stderr: "provider secret",
        }),
      ),
      "/workspace/patchdesk",
    );
    const unavailable = new FlueCliReviewInvoker(
      {
        async runJson() {
          return { _tag: "err", error: { _tag: "CommandRuntimeUnavailable" } };
        },
      } as never,
      "/workspace/patchdesk",
    );
    await expect(invalid.invoke(input)).resolves.toEqual({
      _tag: "err",
      error: { reason: "invalid_result" },
    });
    await expect(unavailable.invoke(input)).resolves.toEqual({
      _tag: "err",
      error: { reason: "runtime_unavailable" },
    });
  });
});
