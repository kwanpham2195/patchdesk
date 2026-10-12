import { execFileSync, spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheckCommand, runFullCheck } from "#scripts/run-full-check.mjs";

const fixtures: string[] = [];
afterEach(async () => {
  for (const path of fixtures.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "patchdesk-full-check-"));
  fixtures.push(cwd);
  execFileSync("git", ["init", "--quiet", cwd]);
  return cwd;
}

describe("full check runner", () => {
  it("runs the complete pipeline sequentially and releases the lock", async () => {
    const cwd = await repository();
    const commands: string[] = [];
    let active = false;
    expect(
      await runFullCheck(
        cwd,
        new AbortController().signal,
        async (command, args) => {
          expect(command).toBe("pnpm");
          expect(active).toBe(false);
          active = true;
          await Promise.resolve();
          commands.push(args.join(" "));
          active = false;
          return 0;
        },
      ),
    ).toBe(0);
    expect(commands).toEqual([
      "typecheck",
      "typecheck:scripts",
      "check:error-ui",
      "check:imports",
      "--dir runtime/insight typecheck",
      "exec oxlint --deny-warnings runtime/insight",
      "test:all",
      "lint:staged",
      "lint:changed -- origin/main",
      "knip:ratchet",
    ]);
    await expect(
      readFile(join(cwd, ".git/patchdesk-full-check.lock/owner.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks at a failing command and permits the next independent check", async () => {
    const cwd = await repository();
    const commands: string[] = [];
    expect(
      await runFullCheck(
        cwd,
        new AbortController().signal,
        async (_command, args) => {
          commands.push(args.join(" "));
          return commands.length === 2 ? 9 : 0;
        },
      ),
    ).toBe(9);
    expect(commands).toEqual(["typecheck", "typecheck:scripts"]);
    expect(
      await runFullCheck(cwd, new AbortController().signal, async () => 0),
    ).toBe(0);
  });

  it("releases after interrupted work settles before executing another command", async () => {
    const cwd = await repository();
    const controller = new AbortController();
    let entered!: () => void;
    let settle!: (status: number) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const owned = new Promise<number>((resolve) => {
      settle = resolve;
    });
    const check = runFullCheck(cwd, controller.signal, async () => {
      entered();
      return owned;
    });
    await started;
    controller.abort();
    expect(
      await readFile(
        join(cwd, ".git/patchdesk-full-check.lock/owner.txt"),
        "utf8",
      ),
    ).toContain(`cwd=${cwd}`);
    settle(130);
    expect(await check).toBe(130);
    expect(
      await runFullCheck(cwd, new AbortController().signal, async () => 0),
    ).toBe(0);
  });

  it("streams real process success and propagates real process failure", async () => {
    const cwd = await repository();
    const signal = new AbortController().signal;
    expect(
      await runCheckCommand(
        process.execPath,
        ["-e", "console.log('fixture streamed'); process.exit(6)"],
        cwd,
        signal,
      ),
    ).toBe(6);
    expect(
      await runCheckCommand(join(cwd, "missing-command"), [], cwd, signal),
    ).toBe(1);
  });

  it("isolates test repositories from hook Git variables while preserving lint's index", async () => {
    const cwd = await repository();
    await writeFile(
      join(cwd, "pnpm"),
      `#!/bin/sh\nprintf '%s/%s' "\${GIT_INDEX_FILE-unset}" "\${GIT_AUTHOR_NAME-unset}" > "$1.env"\n`,
      { mode: 0o755 },
    );
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runCheckCommand } from ${JSON.stringify(new URL("../../scripts/run-full-check.mjs", import.meta.url).href)};
         const signal = new AbortController().signal;
         for (const arg of ['test:all', 'lint:staged']) {
           if (await runCheckCommand('pnpm', [arg], process.cwd(), signal) !== 0) process.exit(1);
         }`,
      ],
      {
        cwd,
        env: {
          ...process.env,
          PATH: `${cwd}:${process.env.PATH}`,
          GIT_INDEX_FILE: ".git/index",
          GIT_AUTHOR_NAME: "Hook author",
        },
      },
    );
    expect(await readFile(join(cwd, "test:all.env"), "utf8")).toBe(
      "unset/unset",
    );
    expect(await readFile(join(cwd, "lint:staged.env"), "utf8")).toBe(
      ".git/index/Hook author",
    );
  });

  it("interrupts only its owned process group", async () => {
    const cwd = await repository();
    const controller = new AbortController();
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    try {
      // The child signals readiness through a file, so interruption cannot race startup.
      const marker = join(cwd, "ready");
      const ready = new Promise<void>((resolve) => {
        const watcher = watch(cwd, (_event, name) => {
          if (name === "ready") {
            watcher.close();
            resolve();
          }
        });
      });
      const run = runCheckCommand(
        process.execPath,
        [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000)`,
        ],
        cwd,
        controller.signal,
      );
      await ready;
      controller.abort();
      expect(await run).toBe(130);
      expect(unrelated.exitCode).toBeNull();
    } finally {
      const closed = new Promise<void>((resolve) =>
        unrelated.once("close", () => resolve()),
      );
      unrelated.kill();
      await closed;
    }
  });
});
