import { describe, expect, it } from "vitest";

import { CommandRunner, type CommandExecution, type CommandExecutor } from "../../src/adapters/github/command-runner";
import { FlueCliReviewInvoker } from "../../src/services/flue-cli-review-invoker";

class FakeExecutor implements CommandExecutor {
  readonly requests: Array<{ readonly argv: ReadonlyArray<string>; readonly cwd?: string }> = [];
  constructor(private readonly response: CommandExecution) {}
  async execute(input: { readonly argv: ReadonlyArray<string>; readonly cwd?: string }): Promise<CommandExecution> {
    this.requests.push({ argv: input.argv, ...(input.cwd === undefined ? {} : { cwd: input.cwd }) });
    return this.response;
  }
}

describe("FlueCliReviewInvoker", () => {
  it("runs only the fixed workflow and accepts a schema-backed terminal result", async () => {
    const executor = new FakeExecutor({
      _tag: "Exited",
      exitCode: 0,
      stderr: "run events stay private",
      stdout: JSON.stringify({
        changeSummary: "Adds a guarded write.",
        verdict: "comment",
        summary: "One safe finding.",
        findings: [{
          id: "guarded-write",
          severity: "P2",
          title: "Validate the guarded write path",
          explanation: "The write is safe only when the guard remains enforced.",
          confidence: "high",
          category: "bug",
        }],
        validationPlan: ["pnpm test"],
        assumptions: [],
      }),
    });
    const invoker = new FlueCliReviewInvoker(new CommandRunner(executor), "/workspace/patchdesk", "/runtime/node", "/runtime/flue.mjs");

    await expect(invoker.invoke({
      profileId: "cfw" as never,
      sessionId: "session" as never,
      attemptId: "001" as never,
      contextPath: "/tmp/context.json" as never,
      reviewInputPath: "/tmp/review-input.md" as never,
      patchPath: "/tmp/patch.diff" as never,
      worktreePath: "/tmp/worktree" as never,
    })).resolves.toMatchObject({ _tag: "ok", value: { verdict: "comment" } });
    expect(executor.requests).toEqual([{
      argv: ["/runtime/node", "/runtime/flue.mjs", "run", "workflow:review-pr", "--input", JSON.stringify({ profileId: "cfw", sessionId: "session", attemptId: "001", contextPath: "/tmp/context.json", reviewInputPath: "/tmp/review-input.md", patchPath: "/tmp/patch.diff", worktreePath: "/tmp/worktree" })],
      cwd: "/workspace/patchdesk",
    }]);
  });

  it("turns invalid model output and process failures into safe failures", async () => {
    const invalid = new FlueCliReviewInvoker(new CommandRunner(new FakeExecutor({ _tag: "Exited", exitCode: 0, stdout: "{}", stderr: "" })), "/workspace/patchdesk");
    const failed = new FlueCliReviewInvoker(new CommandRunner(new FakeExecutor({ _tag: "Exited", exitCode: 1, stdout: "model output", stderr: "credential failure" })), "/workspace/patchdesk");
    const input = { profileId: "cfw", sessionId: "session", attemptId: "001", contextPath: "/tmp/context.json", reviewInputPath: "/tmp/review-input.md", patchPath: "/tmp/patch.diff", worktreePath: "/tmp/worktree" } as never;
    await expect(invalid.invoke(input)).resolves.toEqual({ _tag: "err", error: { reason: "invalid_result" } });
    await expect(failed.invoke(input)).resolves.toEqual({ _tag: "err", error: { reason: "execution_failed" } });
  });

  it("classifies provider limits and missing runtime dependencies without exposing stderr", async () => {
    const rateLimited = new FlueCliReviewInvoker(new CommandRunner(new FakeExecutor({ _tag: "Exited", exitCode: 1, stdout: "", stderr: "HTTP 429: rate limit exceeded" })), "/workspace/patchdesk");
    const runtimeMissing = new FlueCliReviewInvoker(new CommandRunner(new FakeExecutor({ _tag: "Exited", exitCode: 1, stdout: "", stderr: "ERR_MODULE_NOT_FOUND: Cannot find package" })), "/workspace/patchdesk");
    const input = { profileId: "cfw", sessionId: "session", attemptId: "001", contextPath: "/tmp/context.json", reviewInputPath: "/tmp/review-input.md", patchPath: "/tmp/patch.diff", worktreePath: "/tmp/worktree" } as never;

    await expect(rateLimited.invoke(input)).resolves.toEqual({ _tag: "err", error: { reason: "rate_limited" } });
    await expect(runtimeMissing.invoke(input)).resolves.toEqual({ _tag: "err", error: { reason: "runtime_unavailable" } });
  });
});
