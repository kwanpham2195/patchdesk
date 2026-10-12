import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFullCheckLock } from "#scripts/full-check-lock.mjs";

const fixtures: string[] = [];
afterEach(async () => {
  for (const path of fixtures.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "patchdesk-check-lock-"));
  fixtures.push(cwd);
  execFileSync("git", ["init", "--quiet", cwd]);
  return cwd;
}

describe("full check lock", () => {
  it("serializes across a real linked worktree and releases owned files", async () => {
    const cwd = await repository();
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "fixture",
      ],
      { cwd },
    );
    const worktree = join(cwd, "linked");
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", worktree], {
      cwd,
    });
    const signal = new AbortController().signal;
    const release = await acquireFullCheckLock(cwd, signal, () => {});
    let waiting!: () => void;
    const observedWait = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    let acquired = false;
    const second = acquireFullCheckLock(worktree, signal, () => waiting()).then(
      (unlock) => {
        acquired = true;
        return unlock;
      },
    );
    await observedWait;
    expect(acquired).toBe(false);
    expect(
      await readFile(
        join(cwd, ".git/patchdesk-full-check.lock/owner.txt"),
        "utf8",
      ),
    ).toContain(`cwd=${cwd}`);
    await release();
    await (
      await second
    )();
    await expect(
      readFile(join(cwd, ".git/patchdesk-full-check.lock/owner.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("interrupts a waiter without deleting the active owner's lock", async () => {
    const cwd = await repository();
    const release = await acquireFullCheckLock(
      cwd,
      new AbortController().signal,
      () => {},
    );
    const controller = new AbortController();
    const waiting = acquireFullCheckLock(cwd, controller.signal, () =>
      controller.abort(),
    );
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(
      await readFile(
        join(cwd, ".git/patchdesk-full-check.lock/owner.txt"),
        "utf8",
      ),
    ).toContain(`pid=${process.pid}`);
    await release();
  });

  it("leaves an ownerless crash lock intact rather than stealing it", async () => {
    const cwd = await repository();
    await mkdir(join(cwd, ".git/patchdesk-full-check.lock"));
    const controller = new AbortController();
    await expect(
      acquireFullCheckLock(cwd, controller.signal, () => controller.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      mkdir(join(cwd, ".git/patchdesk-full-check.lock")),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("fails when Git cannot identify a common directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "patchdesk-not-git-"));
    fixtures.push(cwd);
    await expect(
      acquireFullCheckLock(cwd, new AbortController().signal, () => {}),
    ).rejects.toThrow();
  });
});
