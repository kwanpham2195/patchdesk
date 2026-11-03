#!/usr/bin/env node

// T3 Code runs this on worktree creation (t3.json). It runs in the background, so agents can start
// before it ends: `setup-running` holds this PID until `setup-done` or `setup-failed` replaces it,
// and agents wait instead of racing it with their own install.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { seedWorktreeProfile } from "./dev-copy-profile-lib.mjs";
import { linkedWorktreeRoot, worktreeDevProfile } from "./dev-worktree-lib.mjs";
import { processOutput } from "./gate-command-lib.mjs";

const worktreeRoot = linkedWorktreeRoot(process.cwd());
if (worktreeRoot === undefined) {
  processOutput.stderr(
    "setup-worktree: run this inside a linked git worktree, not the main checkout\n",
  );
  process.exit(2);
}

const profile = worktreeDevProfile(worktreeRoot);
const runningMarker = join(profile.profileRoot, "setup-running");
const doneMarker = join(profile.profileRoot, "setup-done");
const failedMarker = join(profile.profileRoot, "setup-failed");
const OUTPUT_TAIL_LIMIT = 8_000;

rmSync(doneMarker, { force: true });
rmSync(failedMarker, { force: true });
mkdirSync(profile.profileRoot, { recursive: true });
writeFileSync(runningMarker, `${process.pid}\n`);

/** @type {string | undefined} */
let failureDetail;
let outputTail = "";
/** @type {import("node:child_process").ChildProcess | undefined} */
let activeChild;
/** @type {string | undefined} */
let cancelSignal;

process.on("exit", () => {
  if (failureDetail === undefined && cancelSignal === undefined)
    writeFileSync(doneMarker, "");
  else
    writeFileSync(
      failedMarker,
      `${cancelSignal === undefined ? failureDetail : `Cancelled by ${cancelSignal}.`}\n${outputTail.trimEnd().split("\n").slice(-30).join("\n")}\n`,
    );
  rmSync(runningMarker, { force: true });
});

// A cancelled setup must still leave a marker, or agents would wait forever. During a command the
// signal goes on to it and setup ends when its output closes, so no marker appears while it can still write.
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]))
  process.on(signal, () => {
    cancelSignal = signal;
    if (activeChild === undefined) process.exit(1);
    else activeChild.kill(signal);
  });

/**
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @returns {Promise<number>}
 */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: worktreeRoot,
      // CI makes pnpm fail instead of prompting; closed stdin does the same for other prompts.
      env: { ...process.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    for (const [source, target] of /** @type {const} */ ([
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ])) {
      source.setEncoding("utf8");
      source.on("data", (chunk) => {
        target.write(chunk);
        outputTail = (outputTail + chunk).slice(-OUTPUT_TAIL_LIMIT);
      });
    }
    child.on("error", (error) => {
      outputTail += `${error.message}\n`;
    });
    child.on("close", (status) => {
      activeChild = undefined;
      resolve(status ?? 1);
    });
  });
}

/**
 * @param {string} label
 * @param {ReadonlyArray<string>} command
 */
async function expectSuccess(label, [file, ...args]) {
  const status = await run(file ?? "", args);
  if (status !== 0 || cancelSignal !== undefined) {
    failureDetail = `${label} exited with status ${status}.`;
    process.exit(1);
  }
}

try {
  // A stale lockfile fails instead of being rewritten.
  await expectSuccess("pnpm install", ["pnpm", "install", "--frozen-lockfile"]);
  // pnpm can skip Electron's download hook, leaving no binary for `pnpm dev`.
  if (!existsSync(join(worktreeRoot, "node_modules/electron/path.txt")))
    await expectSuccess("electron install", [
      "node",
      "node_modules/electron/install.js",
    ]);
  await seedWorktreeProfile({
    homeDirectory: homedir(),
    configDirectory: profile.configDirectory,
    dataDirectory: profile.dataDirectory,
    output: processOutput,
  });
} catch (error) {
  failureDetail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exit(1);
}
