import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { version } from "../../package.json";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { createPatchdeskMcpServer } from "./patchdesk-mcp-server";
import { runSetupCommand } from "./setup-cli";
import { callPatchdeskApp } from "./socket-client";
import { MCP_SOCKET_ENV, resolveMcpSocketPath } from "./socket-protocol";

/**
 * `patchdesk`, the command the launcher at `Contents/Resources/bin/patchdesk`
 * runs (ADR 0052 "Packaging"). stdout carries the MCP protocol, so every
 * diagnostic goes to stderr.
 */
const usage = `Usage: patchdesk mcp [--check]
       patchdesk setup <status | add-repo | set-checkout> [--cwd <path>] [--json]

  patchdesk mcp                 Serve Patchdesk's tools to a coding agent over MCP (stdio).
  patchdesk mcp --check         Call list_repositories on the running app and print the result.
  patchdesk setup status        Print the GitHub account, workspace, and repositories, and the steps left.
  patchdesk setup add-repo      Watch the repository of the checkout at --cwd (default: here), with that
                                checkout. Creates the workspace from the active gh account if there is none.
  patchdesk setup set-checkout  Use the checkout at --cwd for the repository it belongs to, as after a move.
`;

// The shim runs from the installed launcher or from `pnpm mcp:shim`; only the latter names the dev app's socket, through PATCHDESK_MCP_SOCKET.
const socketPath = resolveMcpSocketPath(
  process.env[MCP_SOCKET_ENV],
  PatchdeskPaths.forBuild({ packaged: true, environment: {} }),
);
const report = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const args = process.argv.slice(2);
const command = args.join(" ");

if (command === "mcp") {
  serveStdio(
    () =>
      createPatchdeskMcpServer({
        socketPath,
        version,
        report,
        debug: process.env.PATCHDESK_MCP_DEBUG === "1",
      }),
    { onerror: (cause) => report(`patchdesk mcp: ${cause.message}`) },
  );
} else if (command === "mcp --check") {
  process.exitCode = await check();
} else if (args[0] === "setup") {
  const exitCode = await runSetupCommand(args.slice(1), {
    socketPath,
    cwd: process.cwd(),
    out: (text) => process.stdout.write(text),
    report,
  });
  if (exitCode === undefined) process.stderr.write(usage);
  process.exitCode = exitCode ?? 2;
} else if (command === "") {
  process.stdout.write(usage);
} else {
  process.stderr.write(usage);
  process.exitCode = 2;
}

/** The first thing to run when a client reports the server as failed; non-zero when the app is not reachable. */
async function check(): Promise<number> {
  process.stdout.write(`socket: ${socketPath}\n`);
  const call = await callPatchdeskApp(socketPath, {
    tool: "list_repositories",
    arguments: {},
  });
  if (call.reply.ok) {
    process.stdout.write(`${JSON.stringify(call.reply.result, null, 2)}\n`);
    return 0;
  }
  const failure = call.failure === undefined ? "" : ` (${call.failure})`;
  report(`${call.reply.error}: ${call.reply.message}${failure}`);
  return 1;
}
