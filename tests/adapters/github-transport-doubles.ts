import {
  normalizeCommandLabel,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import type { GitHubServedTransport } from "../../src/adapters/github/gh-request-runner";
import type {
  GitHubGraphQlRequest,
  GitHubRequest,
  GitHubRestRequest,
} from "../../src/adapters/github/github-request";
import { ok, type Result } from "../../src/domain/result";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";

/**
 * The two recording seams the transport-routing suites state their assertions
 * over: which transport a request reached, and under which label. Shared
 * because the read routing and the write routing assert the same thing about
 * different requests.
 */

export class RecordingGhExecutor implements CommandExecutor {
  /** `normalizeCommandLabel` of every gh invocation, in call order. */
  readonly labels: Array<string> = [];

  constructor(private readonly execution: CommandExecution) {}

  async execute(input: CommandRequest): Promise<CommandExecution> {
    this.labels.push(normalizeCommandLabel(input.argv));
    return this.execution;
  }
}

export class RecordingHttpTransport implements GitHubServedTransport {
  readonly requests: Array<GitHubRequest> = [];

  constructor(
    private readonly answer: Result<unknown, CommandFailure> = ok({}),
  ) {}

  async rest(
    _profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    this.requests.push(request);
    return this.answer;
  }

  async restText(
    _profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<string, CommandFailure>> {
    this.requests.push(request);
    return this.answer._tag === "err" ? this.answer : ok("");
  }

  async graphql(
    _profile: WorkspaceProfileConfig,
    request: GitHubGraphQlRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    this.requests.push(request);
    return this.answer;
  }
}

/** A gh child that exited 0 with `stdout`. */
export const exited = (stdout: string): CommandExecution => ({
  _tag: "Exited",
  exitCode: 0,
  stdout,
  stderr: "",
});
