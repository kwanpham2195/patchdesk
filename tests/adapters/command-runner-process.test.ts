import { describe, expect, it } from "vitest";

import {
  CommandRunner,
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
    const startedAt = Date.now();
    const controller = new AbortController();
    // No caller passes `signal` on the CommandRequest itself here — this
    // proves a route's abort reaches the child process via
    // `runWithRequestAbortSignal` alone, the mechanism `local-api.ts` uses
    // instead of threading `signal` through every GitHubReader call site.
    const pending = runWithRequestAbortSignal(controller.signal, () =>
      new CommandRunner().runText({
        argv: [process.execPath, "-e", "setInterval(() => undefined, 1_000);"],
        timeoutMs: 30_000,
        inheritEnvironment: false,
        environment: {},
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    controller.abort();

    await expect(pending).resolves.toEqual({
      _tag: "err",
      error: { _tag: "CommandAborted" },
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 6_000);
});
