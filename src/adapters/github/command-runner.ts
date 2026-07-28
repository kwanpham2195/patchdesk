import { spawn } from "node:child_process";

import { err, ok, type Result } from "../../domain/result";
import { discoverExecutable } from "../../main/executable-discovery";

/** An explicit executable and argument vector owned by an external adapter. */
export type CommandRequest = {
  readonly argv: ReadonlyArray<string>;
  readonly timeoutMs: number;
  /** Optional adapter-owned working directory; never supplied by the renderer or model. */
  readonly cwd?: string;
  /** Non-secret JSON payload supplied directly to the child process, never through a shell. */
  readonly stdin?: string;
  /** Adapter-owned environment additions; renderer input never reaches this field. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Caller-owned cancellation; the adapter terminates only its own child process. */
  readonly signal?: AbortSignal;
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
  | { readonly _tag: "OutputExceeded" }
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
    const resolvedExecutable = await discoverExecutable(executable);
    if (resolvedExecutable === undefined) return { _tag: "Unavailable" };

    return new Promise((resolve) => {
      const child = spawn(resolvedExecutable, input.argv.slice(1), {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        shell: false,
        detached: process.platform !== "win32",
        env: input.environment === undefined ? process.env : { ...process.env, ...input.environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let outputExceeded = false;
      const maxOutputBytes = 2 * 1024 * 1024;

      const onAbort = (): void => {
        terminateOwnedProcess(child.pid);
      };
      const finish = (execution: CommandExecution): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(execution);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminateOwnedProcess(child.pid);
      }, input.timeoutMs);

      if (input.signal?.aborted) {
        terminateOwnedProcess(child.pid);
      } else {
        input.signal?.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > maxOutputBytes) {
          outputExceeded = true;
          terminateOwnedProcess(child.pid);
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > maxOutputBytes) {
          outputExceeded = true;
          terminateOwnedProcess(child.pid);
        }
      });
      child.stdin?.end(input.stdin);
      child.once("error", () => finish({ _tag: "Unavailable" }));
      child.once("close", (exitCode) => {
        if (outputExceeded) {
          finish({ _tag: "OutputExceeded" });
          return;
        }
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
  if (execution._tag === "OutputExceeded") return { _tag: "CommandFailed" };
  if (execution.exitCode === 0) return undefined;
  if (isAuthenticationFailure(execution.stderr)) {
    return { _tag: "CommandAuthenticationRequired" };
  }
  return { _tag: "CommandFailed" };
}

function terminateOwnedProcess(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
  } catch {
    // The process may already have exited between the timeout/output event and termination.
  }
}

function isAuthenticationFailure(stderr: string): boolean {
  return /(?:gh auth login|not logged in|not logged into|authentication required|authentication failed)/i.test(
    stderr,
  );
}
