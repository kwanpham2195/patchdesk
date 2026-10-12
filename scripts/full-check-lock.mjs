import { execFileSync } from "node:child_process";
import { mkdir, writeFile, unlink, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

/**
 * Acquire the shared Git-directory lock without stealing an existing owner.
 * A crash leaves the lock for manual inspection; waiting expires after ten minutes.
 * @param {string} cwd
 * @param {AbortSignal} signal
 * @param {(text: string) => void} output
 * @returns {Promise<() => Promise<void>>}
 */
export async function acquireFullCheckLock(cwd, signal, output) {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  }).trim();
  if (common.length === 0)
    throw new Error("Full check lock: Git returned no common directory.");
  const directory = resolve(cwd, common, "patchdesk-full-check.lock");
  const deadline = Date.now() + 600_000;
  let waiting = false;
  for (;;) {
    signal.throwIfAborted();
    try {
      await mkdir(directory);
      break;
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        cause.code !== "EEXIST"
      )
        throw cause;
      if (!waiting) {
        output(
          `Full check waiting for ${directory}. Never remove it while a check is active.\n`,
        );
        waiting = true;
      }
      if (Date.now() >= deadline)
        throw new Error(
          `Full check lock wait expired: ${directory}. Inspect the owner and its children before manually removing a crashed owner's lock.`,
        );
      await setTimeout(250, undefined, { signal });
    }
  }
  const owner = resolve(directory, "owner.txt");
  try {
    await writeFile(owner, `pid=${process.pid}\ncwd=${cwd}\n`, { flag: "wx" });
    signal.throwIfAborted();
  } catch (cause) {
    await unlink(owner).catch(() => {});
    await rmdir(directory);
    throw cause;
  }
  return async () => {
    await unlink(owner);
    await rmdir(directory);
  };
}
