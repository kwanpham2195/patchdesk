#!/usr/bin/env node

import { homedir } from "node:os";

import { processOutput } from "./gate-command-lib.mjs";
import { copyInstalledProfileToDev } from "./dev-copy-profile-lib.mjs";

const status = await copyInstalledProfileToDev({
  args: process.argv.slice(2),
  homeDirectory: homedir(),
  output: processOutput,
});
// Assigned inside the branch because a top-level `process.exitCode = ...` counts as a `scripts/` type error (see scripts/prepare-release.mjs).
if (status !== 0) process.exitCode = status;
