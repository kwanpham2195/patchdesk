import { afterEach, describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { startLoginShellEnvironmentImport } from "../../src/adapters/process/login-shell-import";

const IMPORTED_PATH_ENTRY = "/opt/patchdesk-login-shell-fixture/bin";
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("a spawn asked for while the login shell is still running", () => {
  it("waits for the import and sees the PATH it brought in", async () => {
    let closeLoginShell = (): void => undefined;
    const loginShellClosed = new Promise<void>((resolve) => {
      closeLoginShell = resolve;
    });
    // Stands in for `importLoginShellEnvironment`: it replaces PATH the way
    // the real import does, but only once the shell answers.
    const imported = startLoginShellEnvironmentImport(async () => {
      await loginShellClosed;
      process.env.PATH = `${IMPORTED_PATH_ENTRY}:${originalPath ?? ""}`;
    });

    let settled = false;
    const spawned = new CommandRunner()
      .runText({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(process.env.PATH ?? '')",
        ],
        timeoutMs: 10_000,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(settled).toBe(false);

    closeLoginShell();
    await imported;

    const result = await spawned;
    expect(result._tag).toBe("ok");
    expect(result._tag === "ok" ? result.value : "").toContain(
      IMPORTED_PATH_ENTRY,
    );
  }, 15_000);
});
