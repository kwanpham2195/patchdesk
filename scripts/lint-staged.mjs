#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { lintStaged } from "./lint-staged-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const exitCode = await lintStaged({
  cwd: projectRoot,
  run,
  output: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
});
process.exitCode = exitCode;

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) =>
      resolveRun({
        status,
        signal,
        stdout,
        stderr,
      }),
    );
  });
}
