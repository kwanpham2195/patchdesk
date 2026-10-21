import { spawn, type ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";

import {
  GUIDE_MAX_FRAME_BYTES,
  encodeGuideFrameLine,
  guideChildFrameSchema,
  parseGuideFrameLine,
  type GuideAppOutcome,
  type GuideChildFrame,
} from "#src/domain/guide-protocol";
import type { InsightArtifactRunId } from "#src/domain/insight-artifact-scalars";
import { whenLoginShellEnvironmentImported } from "./login-shell-import";

const FORCE_KILL_AFTER_MS = 5_000;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** The identity every frame on this connection must repeat; any other value is a protocol violation. */
export type GuideChannelIdentity = {
  readonly runId: InsightArtifactRunId;
  readonly generation: number;
  readonly cancelEpoch: number;
  readonly connection: string;
};

/** Receives one validated frame at a time, in order, and returns the app's answer. */
export type GuideChannelHandler = (
  frame: GuideChildFrame,
) => Promise<GuideAppOutcome>;

/** How the child ended. `Violation` means the child sent an unparseable, oversized or mis-identified frame. */
export type GuideChildExit =
  | {
      readonly _tag: "Exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly _tag: "Aborted" }
  | { readonly _tag: "OutputExceeded" }
  | { readonly _tag: "Violation" }
  | { readonly _tag: "Unavailable" };

/**
 * Runs the runtime child, which has no total deadline (the run policy is `no-total-deadline/1`); only cancellation,
 * shutdown or the child ending stops it. It runs with a private bidirectional channel on descriptor 3. The invocation is written to stdin and
 * closed, as for every other child; the child answers on stdout once. Frames travel as one JSON object per line,
 * each at most 32 KiB including identity fields and escaping, and the app answers each in order. The channel is not
 * a public MCP server and exposes no shell, filesystem or arbitrary path: the only requests it accepts are the closed
 * frame schema's. A bad frame, identity mismatch or oversized line terminates the child's process group.
 */
export async function runGuideChild(input: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly signal?: AbortSignal | undefined;
  readonly identity: GuideChannelIdentity;
  readonly handler: GuideChannelHandler;
}): Promise<GuideChildExit> {
  // The child's environment carries credentials the login shell may still be importing (ADR 0038).
  await whenLoginShellEnvironmentImported();
  if (input.signal?.aborted) return { _tag: "Aborted" };
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(input.executable, [...input.args], {
        cwd: input.cwd,
        shell: false,
        detached: process.platform !== "win32",
        env: { ...input.environment },
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({ _tag: "Unavailable" });
      return;
    }
    // SAFETY: an extra stdio entry spawned as "pipe" is a duplex socket pair on the parent side.
    const channel = child.stdio[3] as Duplex | null | undefined;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let outcome: GuideChildExit | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let pending = Promise.resolve();

    const terminate = (): void => {
      terminateGroup(child.pid, "SIGTERM");
      forceKill ??= setTimeout(
        () => terminateGroup(child.pid, "SIGKILL"),
        FORCE_KILL_AFTER_MS,
      );
    };
    const stopWith = (exit: GuideChildExit): void => {
      outcome ??= exit;
      terminate();
    };
    const onAbort = (): void => stopWith({ _tag: "Aborted" });
    const finish = (exit: GuideChildExit): void => {
      if (settled) return;
      settled = true;
      if (forceKill !== undefined) clearTimeout(forceKill);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(exit);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES)
        stopWith({ _tag: "OutputExceeded" });
    });
    child.stderr?.on("data", (chunk: string) => {
      // Diagnostics are best effort: an overlong stderr is cut, never a reason to kill a paid run.
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
    });

    const reply = (frame: GuideChildFrame, answer: GuideAppOutcome): void => {
      const line = encodeGuideFrameLine({
        kind: "reply",
        runId: input.identity.runId,
        generation: input.identity.generation,
        cancelEpoch: input.identity.cancelEpoch,
        connection: input.identity.connection,
        correlation: frame.correlation,
        outcome: answer,
      });
      if (line._tag === "err") {
        stopWith({ _tag: "Violation" });
        return;
      }
      channel?.write(`${line.value}\n`);
    };
    const accept = (line: string): void => {
      const parsed = parseGuideFrameLine(guideChildFrameSchema, line);
      if (
        parsed._tag === "err" ||
        parsed.value.runId !== input.identity.runId ||
        parsed.value.generation !== input.identity.generation ||
        parsed.value.cancelEpoch !== input.identity.cancelEpoch ||
        parsed.value.connection !== input.identity.connection
      ) {
        stopWith({ _tag: "Violation" });
        return;
      }
      const frame = parsed.value;
      // Frames are answered strictly in arrival order, one at a time.
      pending = pending.then(async () => {
        if (outcome !== undefined || input.signal?.aborted === true) return;
        let answer: GuideAppOutcome;
        try {
          answer = await input.handler(frame);
        } catch {
          answer = { status: "refused", reason: "storage" };
        }
        if (outcome === undefined) reply(frame, answer);
      });
    };

    let buffered = "";
    channel?.setEncoding("utf8");
    channel?.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        accept(line);
      }
      // A line that outgrows the frame bound without a newline can never become valid.
      if (buffered.length > GUIDE_MAX_FRAME_BYTES)
        stopWith({ _tag: "Violation" });
    });
    channel?.on("error", () => undefined);
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input.stdin);
    child.once("error", () => finish({ _tag: "Unavailable" }));
    child.once("close", (exitCode) => {
      // The app answers every frame it accepted before the child's result is considered final.
      void pending.then(() =>
        finish(
          outcome ?? {
            _tag: "Exited",
            exitCode: exitCode ?? 1,
            stdout,
            stderr,
          },
        ),
      );
    });
  });
}

function terminateGroup(
  pid: number | undefined,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // The process may already have exited.
  }
}
