#!/usr/bin/env node

import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { seedWorktreeProfile } from "./dev-copy-profile-lib.mjs";
import {
  MAIN_CDP_PORT,
  MAIN_VITE_PORT,
  devProfileFor,
  worktreeDevEnvironment,
} from "./dev-worktree-lib.mjs";
import { processOutput } from "./gate-command-lib.mjs";

const profile = devProfileFor(process.cwd(), process.env);
/** @type {Record<string, string | undefined>} */
let environment = process.env;

if (profile === undefined) {
  const cdp = process.env["REMOTE_DEBUGGING_PORT"];
  processOutput.stdout(
    `dev: main checkout, CDP ${cdp ?? "off (set REMOTE_DEBUGGING_PORT)"}, Vite ${MAIN_VITE_PORT}, default dev roots (maintainer app uses CDP ${MAIN_CDP_PORT})\n`,
  );
} else {
  await seedWorktreeProfile({
    homeDirectory: homedir(),
    configDirectory: profile.configDirectory,
    dataDirectory: profile.dataDirectory,
    output: processOutput,
  });
  environment = { ...process.env, ...worktreeDevEnvironment(profile) };
  processOutput.stdout(
    `dev: worktree ${profile.worktreeRoot}, CDP ${profile.cdpPort}, Vite ${profile.vitePort}, profile ${profile.profileRoot}\n`,
  );
}

const child = spawn("electron-vite", ["dev", ...process.argv.slice(2)], {
  env: environment,
  stdio: "inherit",
});
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"]))
  process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  // Assigned inside the handler because a top-level `process.exitCode = ...` counts as a `scripts/` type error.
  if (signal !== null) process.exitCode = 1;
  else if (code !== null && code !== 0) process.exitCode = code;
});
