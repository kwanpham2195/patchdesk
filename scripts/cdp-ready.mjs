#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { processOutput } from "./gate-command-lib.mjs";

/**
 * @typedef {import("./gate-command-lib.mjs").CommandOutput} CommandOutput
 */

/**
 * The part of a `fetch` response this check reads. Narrower than `Response` so
 * a test can hand in a plain object without asserting it into one, and
 * `globalThis.fetch` still satisfies it.
 *
 * @typedef {{
 *   readonly ok: boolean;
 *   readonly json: () => Promise<unknown>;
 * }} VersionResponse
 */

/**
 * @typedef {(
 *   url: string,
 *   init: { readonly signal: AbortSignal },
 * ) => Promise<VersionResponse>} FetchJson
 */

/** The port `pnpm dev` opens CDP on when `REMOTE_DEBUGGING_PORT` is unset. */
export const DEFAULT_CDP_PORT = 9233;

/**
 * Long enough for a local Electron main process to answer, short enough that
 * a down port is reported rather than waited on.
 */
const REQUEST_TIMEOUT_MS = 2000;

/**
 * The CDP port this session should ask about: `REMOTE_DEBUGGING_PORT` when it
 * names one, and 9233 otherwise.
 *
 * 9233 is the maintainer's own app. A session that needs its own dev app sets
 * `REMOTE_DEBUGGING_PORT` (924N) and its own user-data dir, and this check
 * follows it there rather than reporting on somebody else's window.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function cdpPort(env) {
  const configured = env["REMOTE_DEBUGGING_PORT"];
  if (configured === undefined) return DEFAULT_CDP_PORT;
  const port = Number.parseInt(configured.trim(), 10);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_CDP_PORT;
}

/**
 * Whether the dev app is reachable over CDP, as an exit code.
 *
 * Live verification of the running app starts here. `pnpm dev` dies quietly,
 * and an agent that never asks goes on describing an app that is not there --
 * or dispatches a live-verification subagent against a dead port and gets
 * "blocked" back twenty minutes later. One request settles it, so the failure
 * message is the remedy rather than a diagnosis.
 *
 * @param {{
 *   readonly port: number;
 *   readonly fetchJson?: FetchJson;
 *   readonly timeoutMs?: number;
 *   readonly output: CommandOutput;
 * }} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function checkCdpReady({
  port,
  fetchJson = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  output,
}) {
  try {
    const response = await fetchJson(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return reportDown(port, output);
    const version = await response.json();
    output.stdout(`CDP ${port} ready: ${browserOf(version)}\n`);
    return 0;
  } catch {
    return reportDown(port, output);
  }
}

/**
 * The `Browser` field CDP's `/json/version` answers with, naming the Electron
 * or Chrome build on the other end. Anything else that answered this endpoint
 * is still something to drive, so it reports as unnamed rather than as down.
 *
 * @param {unknown} version
 * @returns {string}
 */
function browserOf(version) {
  if (version === null || version === undefined) return "unnamed browser";
  const browser = Object(version)["Browser"];
  return Object.prototype.toString.call(browser) === "[object String]" &&
    browser.length > 0
    ? browser
    : "unnamed browser";
}

/**
 * @param {number} port
 * @param {CommandOutput} output
 * @returns {number}
 */
function reportDown(port, output) {
  output.stderr(
    `CDP ${port} down. Start the app: REMOTE_DEBUGGING_PORT=${port} pnpm dev (in herdr's dev tab).\n`,
  );
  return 1;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await checkCdpReady({
    port: cdpPort(process.env),
    output: processOutput,
  });
}
