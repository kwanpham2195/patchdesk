import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { version } from "../../package.json";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { createPatchdeskMcpServer } from "./patchdesk-mcp-server";
import { callPatchdeskApp } from "./socket-client";
import { MCP_SOCKET_ENV, resolveMcpSocketPath } from "./socket-protocol";

/**
 * `patchdesk`, the command the launcher at `Contents/Resources/bin/patchdesk`
 * runs (ADR 0052 "Packaging"). stdout carries the MCP protocol, so every
 * diagnostic goes to stderr.
 */
const usage = `Usage: patchdesk mcp [--check]

  patchdesk mcp          Serve Patchdesk's tools to a coding agent over MCP (stdio).
  patchdesk mcp --check  Call list_repositories on the running app and print the result.
`;

const socketPath = resolveMcpSocketPath(
  process.env[MCP_SOCKET_ENV],
  PatchdeskPaths.default(),
);
const report = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const command = process.argv.slice(2).join(" ");

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
