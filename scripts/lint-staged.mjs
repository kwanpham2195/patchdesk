#!/usr/bin/env node

import { resolve } from "node:path";

import { processOutput, spawnCommand } from "./gate-command-lib.mjs";
import { lintStaged } from "./lint-staged-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
process.exitCode = await lintStaged({
  cwd: projectRoot,
  run: spawnCommand,
  output: processOutput,
});
