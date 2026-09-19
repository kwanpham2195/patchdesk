#!/usr/bin/env node

/**
 * Summarize the `command-spawn` log entries `NodeCommandExecutor` writes, one
 * row per normalized endpoint label.
 *
 * Every slow operation in this app was a `gh` or `git` child process, so the
 * question a performance slice has to answer is which endpoints a route hit
 * and how often it repeated one. The label collapses identical logical calls
 * (see `normalizeCommandLabel` in `src/adapters/github/command-runner.ts`), so
 * a repeated read shows up as a call count rather than as many distinct rows.
 *
 * A read the GitHub cutover moved onto HTTPS spawns nothing and writes a
 * `github-http` entry under the same label instead (issue #276). Those are
 * counted in their own section and their own per-cycle column, never added to
 * the spawns, so "spawns per cycle" keeps meaning what the program's earlier
 * measurements meant.
 *
 * Rows are ordered by label, not by cost, so two runs of this command diff
 * line by line.
 *
 * The log file accumulates across sessions, so a whole-file summary measures
 * however long the app happened to be running. `--since`/`--until` bound it to
 * a window, and `--cycles` bounds it to the requests of one route, which is
 * what makes a published baseline reproducible.
 *
 * `--shadow` reports the other stream in the same log: the `transport-shadow`
 * entries a launch with `PATCHDESK_TRANSPORT_SHADOW=1` writes, one per read
 * answered by `gh` and compared against the HTTP client (issue #292). It
 * answers one question per endpoint label — did the two transports agree —
 * which is what decides whether that label can be cut over.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  asInstantMs,
  formatCycleReport,
  formatShadowReport,
  formatSpawnReport,
  summarizeCycles,
  summarizeHttpRequests,
  summarizeShadow,
  summarizeSpawns,
} from "./gh-spawn-report-lib.mjs";

/** The route whose cycles this program's baseline is quoted against. */
export const defaultCycleRoute = "POST /v1/reviews/detect-updates";

const usage =
  "Usage: node scripts/gh-spawn-report.mjs [<log-file>] [--since <iso8601>] [--until <iso8601>] [--cycles] [--route <message>] [--shadow]\n";

const defaultLogFile = join(
  homedir(),
  ".local",
  "share",
  "patchdesk",
  "logs",
  "patchdesk.jsonl",
);

/**
 * @typedef {{
 *   readonly logFile: string;
 *   readonly since?: number;
 *   readonly until?: number;
 *   readonly route?: string;
 *   readonly shadow?: boolean;
 * }} Invocation
 */

/**
 * @param {ReadonlyArray<string>} args
 * @returns {{ readonly _tag: "ok"; readonly value: Invocation } | { readonly _tag: "err"; readonly message: string }}
 */
export function parseArguments(args) {
  /** @type {string | undefined} */
  let logFile;
  /** @type {number | undefined} */
  let since;
  /** @type {number | undefined} */
  let until;
  /** @type {string | undefined} */
  let route;
  let shadow = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (token === "--shadow") {
      shadow = true;
      continue;
    }
    if (token === "--cycles") {
      route ??= defaultCycleRoute;
      continue;
    }
    if (token === "--since" || token === "--until" || token === "--route") {
      const value = args[index + 1];
      index += 1;
      if (value === undefined) return { _tag: "err", message: usage };
      if (token === "--route") {
        route = value;
        continue;
      }
      const instant = asInstantMs(value);
      if (instant === undefined) {
        return {
          _tag: "err",
          message: `${token} needs an ISO 8601 timestamp; got "${value}".\n`,
        };
      }
      if (token === "--since") since = instant;
      else until = instant;
      continue;
    }
    if (token.startsWith("-")) return { _tag: "err", message: usage };
    if (logFile !== undefined) return { _tag: "err", message: usage };
    logFile = token;
  }

  if (since !== undefined && until !== undefined && since > until) {
    return { _tag: "err", message: "--since is after --until.\n" };
  }
  if (shadow && route !== undefined) {
    // The two read different entries; one command answering both would have to
    // say which number came from which stream.
    return {
      _tag: "err",
      message: "--shadow reports shadowed reads, not route cycles.\n",
    };
  }

  /** @type {{ logFile: string; since?: number; until?: number; route?: string; shadow?: boolean }} */
  const value = { logFile: resolve(logFile ?? defaultLogFile) };
  if (since !== undefined) value.since = since;
  if (until !== undefined) value.until = until;
  if (route !== undefined) value.route = route;
  if (shadow) value.shadow = true;
  return { _tag: "ok", value };
}

/**
 * @param {{
 *   readonly args: ReadonlyArray<string>;
 *   readonly readSource: (path: string) => Promise<string>;
 *   readonly output: {
 *     readonly stdout: (text: string) => void;
 *     readonly stderr: (text: string) => void;
 *   };
 * }} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function reportGhSpawns({ args, readSource, output }) {
  const invocation = parseArguments(args);
  if (invocation._tag === "err") {
    output.stderr(invocation.message);
    return 2;
  }
  const { logFile, since, until, route, shadow } = invocation.value;
  /** @type {string} */
  let contents;
  try {
    contents = await readSource(logFile);
  } catch {
    output.stderr(`Could not read the log file at ${logFile}.\n`);
    return 1;
  }

  /** @type {{ since?: number; until?: number }} */
  const window = {};
  if (since !== undefined) window.since = since;
  if (until !== undefined) window.until = until;

  if (shadow === true) {
    const rows = summarizeShadow(contents, window);
    if (rows.length === 0) {
      output.stderr(
        `No transport-shadow entries in ${logFile}. Run the app with PATCHDESK_TRANSPORT_SHADOW=1, then rerun this command.\n`,
      );
      return 1;
    }
    output.stdout(formatShadowReport(rows, logFile, window));
    return 0;
  }

  if (route !== undefined) {
    const { cycles, ambiguous } = summarizeCycles(contents, route, window);
    if (cycles.length === 0) {
      output.stderr(
        `No "${route}" requests in ${logFile}. Run the app, then rerun this command.\n`,
      );
      return 1;
    }
    output.stdout(formatCycleReport(cycles, ambiguous, logFile, route, window));
    return 0;
  }

  const rows = summarizeSpawns(contents, window);
  const httpRows = summarizeHttpRequests(contents, window);
  if (rows.length === 0 && httpRows.length === 0) {
    output.stderr(
      `No command-spawn or github-http entries in ${logFile}. Run the app, then rerun this command.\n`,
    );
    return 1;
  }
  output.stdout(formatSpawnReport(rows, logFile, window, httpRows));
  return 0;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  process.exitCode = await reportGhSpawns({
    args,
    readSource: (path) => readFile(path, "utf8"),
    output: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
  });
}
