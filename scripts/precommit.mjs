#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  execute,
  hasExit,
  processOutput,
  replay,
  spawnCommand,
} from "./gate-command-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

const RENDERER_PREFIX = "src/renderer/";

const RENDERER_STAGED_MESSAGE =
  "React Doctor cannot scan: package.json differs between index and worktree, and renderer files are staged. Stage or restore package.json, then retry.\n";

const SKIPPED_MESSAGE =
  "React Doctor skipped: package.json differs between index and worktree. Nothing was scanned.\n";

/**
 * @typedef {{ readonly action: "run" }
 *   | { readonly action: "skip"; readonly message: string }
 *   | { readonly action: "fail"; readonly message: string }} ReactDoctorDecision
 */

/**
 * What the commit gate does about React Doctor.
 *
 * React Doctor reads `package.json`, and it aborts when that file differs
 * between the index and the working tree. Several agent sessions share this
 * checkout, so the file differing usually means another session staged an
 * edit -- a fact about the checkout, not about this commit. Letting the abort
 * through fails commits for somebody else's reason; ignoring it lets a commit
 * pass while nothing was scanned. So the condition is decided here:
 *
 * - Renderer files staged: fail. The scan that mattered is exactly the one
 *   that cannot run, and the remedy is one `git` command away.
 * - No renderer files staged: skip, and say nothing was scanned. A skip
 *   reported as a skip is honest; a skip reported as a pass is not.
 * - `package.json` agrees: run React Doctor, as before.
 *
 * @param {{
 *   readonly packageJsonDiffers: boolean;
 *   readonly stagedPaths: ReadonlyArray<string>;
 * }} change
 * @returns {ReactDoctorDecision}
 */
export function decideReactDoctor({ packageJsonDiffers, stagedPaths }) {
  if (!packageJsonDiffers) return { action: "run" };
  if (stagedPaths.some((path) => path.startsWith(RENDERER_PREFIX)))
    return { action: "fail", message: RENDERER_STAGED_MESSAGE };
  return { action: "skip", message: SKIPPED_MESSAGE };
}

/**
 * Runs one command with the hook's own streams, so its output reaches the
 * terminal as it is produced rather than in one block at the end.
 *
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @param {string} cwd
 * @returns {Promise<number>}
 */
function runInherited(command, args, cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit" });
    child.once("error", (cause) => {
      process.stderr.write(`${command} could not start: ${cause.message}\n`);
      resolveRun(1);
    });
    child.once("close", (status) => resolveRun(status ?? 1));
  });
}

/**
 * Whether `package.json` differs between the index and the working tree.
 *
 * @param {string} cwd
 * @returns {Promise<boolean | undefined>} `undefined` means git itself failed,
 *   already reported to the output.
 */
async function packageJsonDiffers(cwd) {
  const result = await execute(
    spawnCommand,
    "git",
    ["diff", "--quiet", "--", "package.json"],
    cwd,
    processOutput,
  );
  if (result === undefined) return undefined;
  if (hasExit(result, 0)) return false;
  if (hasExit(result, 1)) return true;
  processOutput.stderr(
    `git could not compare package.json between the index and the working tree (status=${String(result.status)}).\n`,
  );
  replay(result, processOutput);
  return undefined;
}

/**
 * @param {string} cwd
 * @returns {Promise<ReadonlyArray<string> | undefined>}
 */
async function stagedPaths(cwd) {
  const result = await execute(
    spawnCommand,
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    cwd,
    processOutput,
  );
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) {
    processOutput.stderr(
      `git staged-file discovery failed (status=${String(result.status)}).\n`,
    );
    replay(result, processOutput);
    return undefined;
  }
  return result.stdout.split("\u0000").filter((path) => path.length > 0);
}

async function main() {
  const lintExit = await runInherited("pnpm", ["lint:staged"], projectRoot);
  if (lintExit !== 0) {
    process.exitCode = lintExit;
    return;
  }

  const differs = await packageJsonDiffers(projectRoot);
  if (differs === undefined) {
    process.exitCode = 1;
    return;
  }
  const staged = await stagedPaths(projectRoot);
  if (staged === undefined) {
    process.exitCode = 1;
    return;
  }

  const decision = decideReactDoctor({
    packageJsonDiffers: differs,
    stagedPaths: staged,
  });
  if (decision.action === "fail") {
    processOutput.stderr(decision.message);
    process.exitCode = 1;
    return;
  }
  if (decision.action === "skip") {
    processOutput.stdout(decision.message);
    return;
  }

  process.exitCode = await runInherited(
    "pnpm",
    ["exec", "react-doctor", "--staged", "--blocking", "warning", "--yes"],
    projectRoot,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
)
  await main();
