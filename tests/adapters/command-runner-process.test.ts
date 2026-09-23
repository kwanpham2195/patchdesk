import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  NodeCommandExecutor,
  runWithRequestAbortSignal,
} from "../../src/adapters/github/command-runner";

describe("CommandRunner owned-process termination", () => {
  it("force-kills an owned process group that ignores SIGTERM", async () => {
    const startedAt = Date.now();
    const result = await new CommandRunner().runText({
      argv: [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1_000);",
      ],
      timeoutMs: 250,
      inheritEnvironment: false,
      environment: {},
    });

    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "CommandTimedOut" },
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 6_000);

  it("terminates a running process through the ambient request abort signal, well before its timeout", async () => {
    const controller = new AbortController();
    let markSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const observeSpawn = (...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      child.once("spawn", markSpawned);
      return child;
    };
    const executor = new NodeCommandExecutor(
      async (executable) => executable,
      // SAFETY: the executor calls only spawn's three-argument form. This
      // wrapper forwards those arguments to the real Node implementation.
      observeSpawn as typeof spawn,
    );
    // No caller passes `signal` on the CommandRequest itself here — this
    // proves a route's abort reaches the child process via
    // `runWithRequestAbortSignal` alone, the mechanism `local-api.ts` uses
    // instead of threading `signal` through every GitHubReader call site.
    const pending = runWithRequestAbortSignal(controller.signal, () =>
      new CommandRunner(executor).runText({
        argv: [process.execPath, "-e", "setInterval(() => undefined, 1_000);"],
        timeoutMs: 30_000,
        inheritEnvironment: false,
        environment: {},
      }),
    );
    await spawned;

    controller.abort();

    await expect(pending).resolves.toEqual({
      _tag: "err",
      error: { _tag: "CommandAborted" },
    });
  }, 6_000);
});
