#!/usr/bin/env node

import { rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  defaultFileExists,
  processOutput,
  spawnCommand,
} from "./gate-command-lib.mjs";
import { installPackagedMacApp } from "./install-mac-lib.mjs";

const status = await installPackagedMacApp({
  args: process.argv.slice(2),
  projectRoot: resolve(import.meta.dirname, ".."),
  arch: process.arch,
  environment: process.env,
  run: spawnCommand,
  output: processOutput,
  fileSystem: {
    exists: defaultFileExists,
    rename,
    remove: (path) => rm(path, { recursive: true, force: true }),
  },
  sleep,
});
// Assigned inside the branch because a top-level `process.exitCode = ...` counts as a `scripts/` type error (see scripts/prepare-release.mjs).
if (status !== 0) process.exitCode = status;
