import {
  CommandRunner,
  normalizeCommandLabel,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import type { GitHubServedTransport } from "../../src/adapters/github/gh-request-runner";
import {
  ghInvocationFor,
  type GitHubGraphQlRequest,
  type GitHubRequest,
  type GitHubRestRequest,
} from "../../src/adapters/github/github-request";
import { err, ok, type Result } from "../../src/domain/result";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";

/**
 * The doubles the GitHub adapter suites drive now that every request it makes
 * goes over HTTPS (ADR 0046, issue #276). A suite states its expectations
 * against the requests one adapter call produced and the answers it was given,
 * never against a spawned child.
 */

/**
 * One canned answer: the response bytes GitHub returned, or the failure the
 * transport classified the response into. A body string is parsed for the two
 * JSON seams and handed over unchanged for the text one, the way
 * `GitHubHttpClient` treats it.
 */
export type CannedAnswer = string | CommandFailure;

/**
 * A served transport whose answers a test supplies. It records the request
 * objects rather than an argv, so an assertion reads the path, method, body,
 * and GraphQL variables the adapter chose.
 */
export class HttpTransportDouble implements GitHubServedTransport {
  readonly requests: Array<GitHubRequest> = [];
  /** `normalizeCommandLabel` of every request, in call order. */
  readonly labels: Array<string> = [];

  constructor(
    private readonly route: (
      label: string,
      request: GitHubRequest,
    ) => CannedAnswer,
  ) {}

  async rest(
    _profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return parsedAnswer(this.record(request));
  }

  async restText(
    _profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<string, CommandFailure>> {
    const answer = this.record(request);
    return isBody(answer) ? ok(answer) : err(answer);
  }

  async graphql(
    _profile: WorkspaceProfileConfig,
    request: GitHubGraphQlRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return parsedAnswer(this.record(request));
  }

  private record(request: GitHubRequest): CannedAnswer {
    const label = labelFor(request);
    this.requests.push(request);
    this.labels.push(label);
    return this.route(label, request);
  }
}

/** Answers each call from the next entry of `answers`, in call order. */
export function orderedTransport(
  answers: ReadonlyArray<CannedAnswer>,
): HttpTransportDouble {
  let index = 0;
  return new HttpTransportDouble(() => {
    const answer = answers[index];
    index += 1;
    if (answer === undefined) throw new Error("Missing fake GitHub answer");
    return answer;
  });
}

/**
 * Answers by normalized endpoint label, so a test can count how many requests
 * one adapter call makes without also fixing their order.
 */
export function routedTransport(
  route: (label: string, request: GitHubRequest) => CannedAnswer,
): HttpTransportDouble {
  return new HttpTransportDouble(route);
}

/** The label one request is recorded and logged under, whatever answered it. */
export function labelFor(request: GitHubRequest): string {
  return normalizeCommandLabel(ghInvocationFor(request).argv);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a fixture writer for whatever JSON one GitHub call is told to return; there is no narrower contract to parse it against.
export function jsonAnswer(value: unknown): string {
  return JSON.stringify(value);
}

export class RecordingGhExecutor implements CommandExecutor {
  /** `normalizeCommandLabel` of every gh invocation, in call order. */
  readonly labels: Array<string> = [];

  constructor(private readonly execution: CommandExecution) {}

  async execute(input: CommandRequest): Promise<CommandExecution> {
    this.labels.push(normalizeCommandLabel(input.argv));
    return this.execution;
  }
}

/**
 * The `CommandRunner` a GitHub adapter is built with when the test drives
 * every API call over the transport double. The adapter still holds one for
 * `gh auth` and for the diff reader's local Git fallback; a child that runs
 * here means a call escaped the transport, so it fails loudly.
 */
export function noChildProcesses(): CommandRunner {
  return new CommandRunner(
    new RecordingGhExecutor({
      _tag: "Exited",
      exitCode: 1,
      stdout: "",
      stderr: "no child process may run for a served GitHub request",
    }),
  );
}

/** A gh child that exited 0 with `stdout`. */
export const exited = (stdout: string): CommandExecution => ({
  _tag: "Exited",
  exitCode: 0,
  stdout,
  stderr: "",
});

/** Which of `CannedAnswer`'s two shapes a fixture chose: a response body, or a failure. */
function isBody(answer: CannedAnswer): answer is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- `CannedAnswer` is this module's own two-shape fixture value, not external input to decode against a contract.
  return typeof answer === "string";
}

function parsedAnswer(answer: CannedAnswer): Result<unknown, CommandFailure> {
  if (!isBody(answer)) return err(answer);
  try {
    // SAFETY: JSON.parse returns `any`; this cast only narrows it to `unknown`
    // so the adapter's own schemas still have to validate the shape.
    return ok(JSON.parse(answer) as unknown);
  } catch {
    return err({ _tag: "CommandInvalidJson" });
  }
}
