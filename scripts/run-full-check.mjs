#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { acquireFullCheckLock } from "./full-check-lock.mjs";

/**
 * The environment for a test run. Hook repository variables must not redirect
 * Git inside the isolated test repositories.
 * @param {string} cwd
 * @returns {NodeJS.ProcessEnv}
 */
export function testEnvironment(cwd) {
  const env = { ...process.env };
  const repositoryVariables = execFileSync(
    "git",
    ["rev-parse", "--local-env-vars"],
    { cwd, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  for (const name of [
    ...repositoryVariables,
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
  ])
    delete env[name];
  return env;
}

/**
 * Stream a command and wait for its owned process group to finish on interruption.
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @param {string} cwd
 * @param {AbortSignal} signal
 * @returns {Promise<number>}
 */
export function runCheckCommand(command, args, cwd, signal) {
  if (signal.aborted) return Promise.resolve(130);
  return new Promise((finish, reject) => {
    const env =
      command === "pnpm" && args[0] === "test:all"
        ? testEnvironment(cwd)
        : { ...process.env };
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: "inherit",
      detached: true,
    });
    const interrupt = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (cause) {
          if (
            !(cause instanceof Error) ||
            !("code" in cause) ||
            cause.code !== "ESRCH"
          )
            process.stderr.write(
              `Full check interruption failed: ${String(cause)}\n`,
            );
        }
      }
    };
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) interrupt();
    child.once("error", (cause) => {
      process.stderr.write(`${command} could not start: ${cause.message}\n`);
    });
    child.once("close", async (status) => {
      signal.removeEventListener("abort", interrupt);
      try {
        if (child.pid !== undefined) {
          const deadline = Date.now() + 5_000;
          for (;;) {
            try {
              process.kill(-child.pid, 0);
            } catch (cause) {
              if (
                cause instanceof Error &&
                "code" in cause &&
                cause.code === "ESRCH"
              )
                break;
              throw Object.assign(
                new Error(
                  "Full check process group could not be inspected; retaining lock.",
                  { cause },
                ),
                { code: "CHECK_GROUP_ACTIVE" },
              );
            }
            if (Date.now() >= deadline)
              throw Object.assign(
                new Error(
                  "Full check process group still exists; retaining lock for inspection.",
                ),
                { code: "CHECK_GROUP_ACTIVE" },
              );
            await setTimeout(50);
          }
        }
        finish(
          signal.aborted ? 130 : status !== null && status >= 0 ? status : 1,
        );
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

/**
 * Preserve the full repository pipeline under one cross-worktree lock.
 * @param {string} cwd
 * @param {AbortSignal} signal
 * @param {typeof runCheckCommand} [run]
 * @returns {Promise<number>}
 */
export async function runFullCheck(cwd, signal, run = runCheckCommand) {
  const release = await acquireFullCheckLock(cwd, signal, (text) =>
    process.stderr.write(text),
  );
  let retainLock = false;
  try {
    for (const args of [
      ["typecheck"],
      ["typecheck:scripts"],
      ["check:error-ui"],
      ["check:imports"],
      ["test:all"],
      ["lint:staged"],
      ["lint:changed", "--", "origin/main"],
      ["knip:ratchet"],
    ]) {
      const status = await run("pnpm", args, cwd, signal);
      if (status !== 0) return status;
      signal.throwIfAborted();
    }
    return 0;
  } catch (cause) {
    retainLock =
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "CHECK_GROUP_ACTIVE";
    throw cause;
  } finally {
    if (!retainLock) await release();
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    process.exitCode = await runFullCheck(
      resolve(import.meta.dirname, ".."),
      controller.signal,
    );
  } catch (cause) {
    process.stderr.write(`Full check failed: ${String(cause)}\n`);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
