#!/usr/bin/env node

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { devProfileFor } from "./dev-worktree-lib.mjs";

// A worktree's dev app listens on its own socket; the main checkout's on the main dev root's.
const profile = devProfileFor(process.cwd(), process.env);
const socket =
  process.env["PATCHDESK_MCP_SOCKET"] ??
  profile?.mcpSocket ??
  join(homedir(), ".local", "share", "patchdesk-dev", "mcp", "patchdesk.sock");

// `setup` and `triage` are shim commands; anything else is an argument to `mcp`.
const [first, ...rest] = process.argv.slice(2);
const args =
  first === "setup" || first === "triage"
    ? [first, ...rest]
    : ["mcp", ...process.argv.slice(2)];

// stdout is the MCP channel, so this wrapper writes nothing to it. PATCHDESK_DEV_SHIM
// and the profile root tell `triage` which app's roots to describe.
/** @type {NodeJS.ProcessEnv} */
const env = {
  ...process.env,
  PATCHDESK_MCP_SOCKET: socket,
  PATCHDESK_DEV_SHIM: "1",
};
if (profile !== undefined)
  env["PATCHDESK_DEV_PROFILE_ROOT"] = profile.profileRoot;
const child = spawn(process.execPath, ["out/main/mcp-shim.js", ...args], {
  env,
  stdio: "inherit",
});
child.on("exit", (code) => {
  if (code !== null && code !== 0) process.exitCode = code;
});
