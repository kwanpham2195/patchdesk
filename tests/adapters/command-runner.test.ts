import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { discoverExecutable } from "../../src/main/executable-discovery";
import { CommandRunner } from "../../src/adapters/github/command-runner";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../src/main/executable-discovery", () => ({
  discoverExecutable: vi.fn(),
}));

describe("CommandRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not spawn when cancellation happens during executable discovery", async () => {
    let resolveDiscovery!: (path: string) => void;
    vi.mocked(discoverExecutable).mockImplementation(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveDiscovery = resolve;
        }),
    );
    const controller = new AbortController();

    const pending = new CommandRunner().runText({
      argv: ["runtime"],
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(discoverExecutable).toHaveBeenCalledWith("runtime"),
    );

    controller.abort();
    resolveDiscovery("/usr/bin/runtime");

    await expect(pending).resolves.toEqual({
      _tag: "err",
      error: { _tag: "CommandUnavailable" },
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
