import { describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";

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
});
