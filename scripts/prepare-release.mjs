#!/usr/bin/env node

import { resolve } from "node:path";

import { processOutput, spawnCommand } from "./gate-command-lib.mjs";
import { prepareRelease } from "./prepare-release-lib.mjs";

const status = await prepareRelease({
  args: process.argv.slice(2),
  projectRoot: resolve(import.meta.dirname, ".."),
  today: new Date(),
  run: spawnCommand,
  output: processOutput,
});
// Assigned inside the branch on purpose: a top-level `process.exitCode = ...`
// in a `.mjs` file reads to TypeScript as a redeclared export of Node's own
// `exitCode`, which the `scripts/` type ratchet counts as an error.
if (status !== 0) process.exitCode = status;
