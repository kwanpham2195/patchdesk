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

// stdout is the MCP channel, so this wrapper writes nothing to it.
const child = spawn(
  process.execPath,
  ["out/main/mcp-shim.js", "mcp", ...process.argv.slice(2)],
  { env: { ...process.env, PATCHDESK_MCP_SOCKET: socket }, stdio: "inherit" },
);
child.on("exit", (code) => {
  if (code !== null && code !== 0) process.exitCode = code;
});
