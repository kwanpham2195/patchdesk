import { spawn } from "node:child_process";

import { err, ok, type Result } from "../../domain/result";

/** An explicit executable and argument vector owned by an external adapter. */
export type CommandRequest = {
  readonly argv: ReadonlyArray<string>;
  readonly timeoutMs: number;
  /** Optional adapter-owned working directory; never supplied by the renderer or model. */
  readonly cwd?: string;
  /** Non-secret JSON payload supplied directly to the child process, never through a shell. */
  readonly stdin?: string;
};

/** Captured completion state from a process execution boundary. */
export type CommandExecution =
  | {
      readonly _tag: "Exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly _tag: "TimedOut";
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly _tag: "Unavailable" };

/** The narrow process seam used by CommandRunner. */
export interface CommandExecutor {
  execute(input: CommandRequest): Promise<CommandExecution>;
}

/** Safe, product-facing classifications for command execution failures. */
export type CommandFailure =
  | { readonly _tag: "CommandTimedOut" }
  | { readonly _tag: "CommandUnavailable" }
  | { readonly _tag: "CommandAuthenticationRequired" }
  | { readonly _tag: "CommandFailed" }
  | { readonly _tag: "CommandInvalidJson" };

/**
 * Execute explicitly-formed argv commands while retaining raw process output inside the boundary.
 * Expected failures intentionally expose tags only, never stdout, stderr, or command credentials.
 */
export class CommandRunner {
  constructor(
    private readonly executor: CommandExecutor = new NodeCommandExecutor(),
  ) {}

  /** Run a command whose stdout is an opaque text artifact. */
  async runText(
    input: CommandRequest,
  ): Promise<Result<string, CommandFailure>> {
    const execution = await this.executor.execute(input);
    const failure = classifyExecution(execution);
    if (failure !== undefined) return err(failure);
    if (execution._tag !== "Exited") return err({ _tag: "CommandFailed" });
    return ok(execution.stdout);
  }

  /** Run a command whose stdout must be one valid JSON value. */
  async runJson(
    input: CommandRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    const text = await this.runText(input);
    if (text._tag === "err") return text;

    try {
      return ok(JSON.parse(text.value) as unknown);
    } catch {
      return err({ _tag: "CommandInvalidJson" });
    }
  }
}

class NodeCommandExecutor implements CommandExecutor {
  async execute(input: CommandRequest): Promise<CommandExecution> {
    const executable = input.argv[0];
    if (executable === undefined) return { _tag: "Unavailable" };

    return new Promise((resolve) => {
      const child = spawn(executable, input.argv.slice(1), {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const finish = (execution: CommandExecution): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(execution);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, input.timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdin?.end(input.stdin);
      child.once("error", () => finish({ _tag: "Unavailable" }));
      child.once("close", (exitCode) => {
        if (timedOut) {
          finish({ _tag: "TimedOut", stdout, stderr });
          return;
        }
        finish({ _tag: "Exited", exitCode: exitCode ?? 1, stdout, stderr });
      });
    });
  }
}

function classifyExecution(
  execution: CommandExecution,
): CommandFailure | undefined {
  if (execution._tag === "TimedOut") return { _tag: "CommandTimedOut" };
  if (execution._tag === "Unavailable") return { _tag: "CommandUnavailable" };
  if (execution.exitCode === 0) return undefined;
  if (isAuthenticationFailure(execution.stderr)) {
    return { _tag: "CommandAuthenticationRequired" };
  }
  return { _tag: "CommandFailed" };
}

function isAuthenticationFailure(stderr: string): boolean {
  return /(?:gh auth login|not logged in|not logged into|authentication required|authentication failed)/i.test(
    stderr,
  );
}
