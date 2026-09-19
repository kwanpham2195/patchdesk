import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { discoverExecutable } from "../../src/adapters/process/executable-discovery";
import { startLoginShellEnvironmentImport } from "../../src/adapters/process/login-shell-import";

/** Named so nothing on the real PATH or on the macOS fallback list can resolve it. */
const IMPORTED_TOOL = "patchdesk-login-shell-fixture-tool";
const originalPath = process.env.PATH;

/** The directory the fake login shell puts on PATH, holding one executable. */
let importedPathEntry = "";

beforeAll(async () => {
  importedPathEntry = await mkdtemp(join(tmpdir(), "patchdesk-login-shell-"));
  await writeFile(
    join(importedPathEntry, IMPORTED_TOOL),
    "#!/bin/sh\nexit 0\n",
    {
      mode: 0o755,
    },
  );
  return async () => {
    await rm(importedPathEntry, { recursive: true, force: true });
  };
});

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("readers asked for while the login shell is still running", () => {
  // One test for both readers on purpose: the launch imports once, so the
  // window in which anything can be caught waiting exists only once too.
  it("wait for the import and see the PATH it brought in", async () => {
    let closeLoginShell = (): void => undefined;
    const loginShellClosed = new Promise<void>((resolve) => {
      closeLoginShell = resolve;
    });
    // Stands in for `importLoginShellEnvironment`: it replaces PATH the way
    // the real import does, but only once the shell answers.
    const imported = startLoginShellEnvironmentImport(async () => {
      await loginShellClosed;
      process.env.PATH = `${importedPathEntry}:${originalPath ?? ""}`;
    });

    let spawnSettled = false;
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
        spawnSettled = true;
        return result;
      });
    let discoverySettled = false;
    const discovered = discoverExecutable(IMPORTED_TOOL).then((path) => {
      discoverySettled = true;
      return path;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(spawnSettled).toBe(false);
    expect(discoverySettled).toBe(false);

    closeLoginShell();
    await imported;

    const result = await spawned;
    expect(result._tag).toBe("ok");
    expect(result._tag === "ok" ? result.value : "").toContain(
      importedPathEntry,
    );
    await expect(discovered).resolves.toBe(
      join(importedPathEntry, IMPORTED_TOOL),
    );
  }, 15_000);
});
