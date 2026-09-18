#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Summarize the `command-spawn` log entries `NodeCommandExecutor` writes, one
 * row per normalized endpoint label.
 *
 * Every slow operation in this app is a `gh` or `git` child process, so the
 * question a performance slice has to answer is which endpoints a route hit
 * and how often it repeated one. The label collapses identical logical calls
 * (see `normalizeCommandLabel` in `src/adapters/github/command-runner.ts`), so
 * a repeated read shows up as a call count rather than as many distinct rows.
 *
 * Rows are ordered by label, not by cost, so two runs of this command diff
 * line by line.
 *
 * The log file accumulates across sessions, so a whole-file summary measures
 * however long the app happened to be running. `--since`/`--until` bound it to
 * a window, and `--cycles` bounds it to the requests of one route, which is
 * what makes a published baseline reproducible.
 */

/**
 * @typedef {{
 *   readonly calls: number;
 *   readonly totalMs: number;
 *   readonly p50Ms: number;
 *   readonly p95Ms: number;
 *   readonly label: string;
 * }} SpawnRow
 */

/**
 * One settled child process. `startedAtMs` is derived, not logged: the entry is
 * written when the process finishes, so the start is `at` minus its duration.
 *
 * @typedef {{
 *   readonly label: string;
 *   readonly durationMs: number;
 *   readonly startedAtMs: number;
 * }} SpawnSample
 */

/**
 * One served HTTP request, derived the same way as a spawn's start.
 *
 * @typedef {{
 *   readonly correlationId: string;
 *   readonly startedAtMs: number;
 *   readonly endedAtMs: number;
 * }} RequestWindow
 */

/**
 * @typedef {{
 *   readonly request: RequestWindow;
 *   readonly calls: number;
 *   readonly subprocessMs: number;
 *   readonly rows: ReadonlyArray<SpawnRow>;
 * }} Cycle
 */

/** The route whose cycles this program's baseline is quoted against. */
export const defaultCycleRoute = "POST /v1/reviews/detect-updates";

const usage =
  "Usage: node scripts/gh-spawn-report.mjs [<log-file>] [--since <iso8601>] [--until <iso8601>] [--cycles] [--route <message>]\n";

const defaultLogFile = join(
  homedir(),
  ".local",
  "share",
  "patchdesk",
  "logs",
  "patchdesk.jsonl",
);

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
const asRecord = (value) =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSONL line at this exact I/O boundary; no earlier parser exists for this primitive shape.
  typeof value === "object" && value !== null
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw log meta field at this exact I/O boundary; no earlier parser exists for this primitive shape.
const asText = (value) => (typeof value === "string" ? value : undefined);

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
const asFiniteNumber = (value) =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw log meta field at this exact I/O boundary; no earlier parser exists for this primitive shape.
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
const asInstantMs = (value) => {
  const text = asText(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * Pull the spawn duration and derived start out of one parsed log line, or
 * return undefined for every other entry in the shared stream.
 *
 * @param {unknown} entry
 * @returns {SpawnSample | undefined}
 */
export function readSpawnEntry(entry) {
  const record = asRecord(entry);
  if (record === undefined || record["topic"] !== "command-spawn") {
    return undefined;
  }
  const fields = asRecord(record["meta"]);
  if (fields === undefined) return undefined;
  const executable = asText(fields["executable"]);
  const label = asText(fields["label"]);
  const durationMs = asFiniteNumber(fields["durationMs"]);
  const endedAtMs = asInstantMs(record["at"]);
  if (executable === undefined || label === undefined) return undefined;
  if (durationMs === undefined || endedAtMs === undefined) return undefined;
  return {
    label: `${executable} ${label}`,
    durationMs,
    startedAtMs: endedAtMs - durationMs,
  };
}

/**
 * Pull one served request's window out of a parsed log line. Only the main
 * process's `http` entries are read: the renderer logs the same request again
 * under `api`, and counting both would double every cycle.
 *
 * @param {unknown} entry
 * @param {string} route
 * @returns {RequestWindow | undefined}
 */
export function readRequestEntry(entry, route) {
  const record = asRecord(entry);
  if (record === undefined || record["topic"] !== "http") return undefined;
  if (record["message"] !== route) return undefined;
  const fields = asRecord(record["meta"]);
  if (fields === undefined) return undefined;
  const durationMs = asFiniteNumber(fields["durationMs"]);
  const endedAtMs = asInstantMs(record["at"]);
  if (durationMs === undefined || endedAtMs === undefined) return undefined;
  return {
    correlationId: asText(fields["correlationId"]) ?? "unknown",
    startedAtMs: endedAtMs - durationMs,
    endedAtMs,
  };
}

/**
 * Read the spawns, and the windows of `route` when one is asked for, in one
 * pass over the file.
 *
 * @param {string} contents
 * @param {string | undefined} route
 * @returns {{ readonly samples: ReadonlyArray<SpawnSample>; readonly requests: ReadonlyArray<RequestWindow> }}
 */
export function collectLog(contents, route) {
  /** @type {Array<SpawnSample>} */
  const samples = [];
  /** @type {Array<RequestWindow>} */
  const requests = [];
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const spawn = readSpawnEntry(parsed);
    if (spawn !== undefined) {
      samples.push(spawn);
      continue;
    }
    if (route === undefined) continue;
    const request = readRequestEntry(parsed, route);
    if (request !== undefined) requests.push(request);
  }
  return { samples, requests };
}

/**
 * Nearest-rank percentile: the smallest sample at or above the requested
 * share of the sorted durations. With few samples this reports a real
 * observed duration rather than an interpolated one that never happened.
 *
 * @param {ReadonlyArray<number>} sorted
 * @param {number} share
 * @returns {number}
 */
export function percentile(sorted, share) {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(share * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? 0;
}

/**
 * Collapse samples into one row per label, ordered by label.
 *
 * @param {ReadonlyArray<SpawnSample>} samples
 * @returns {ReadonlyArray<SpawnRow>}
 */
export function rowsFor(samples) {
  /** @type {Map<string, Array<number>>} */
  const durationsByLabel = new Map();
  for (const sample of samples) {
    const durations = durationsByLabel.get(sample.label) ?? [];
    durations.push(sample.durationMs);
    durationsByLabel.set(sample.label, durations);
  }

  /** @type {Array<SpawnRow>} */
  const rows = [];
  for (const [label, durations] of durationsByLabel) {
    const sorted = [...durations].sort((left, right) => left - right);
    rows.push({
      calls: sorted.length,
      totalMs: sorted.reduce((total, value) => total + value, 0),
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      label,
    });
  }
  return rows.sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Group the spawn entries of a log file into one row per label, optionally
 * bounded to a window. A spawn is in the window when it *started* inside it,
 * which is the same rule cycle membership uses.
 *
 * @param {string} contents
 * @param {{ readonly since?: number; readonly until?: number }} [window]
 * @returns {ReadonlyArray<SpawnRow>}
 */
export function summarizeSpawns(contents, window = {}) {
  const { samples } = collectLog(contents, undefined);
  const since = window.since;
  const until = window.until;
  return rowsFor(
    samples.filter(
      (sample) =>
        (since === undefined || sample.startedAtMs >= since) &&
        (until === undefined || sample.startedAtMs <= until),
    ),
  );
}

/**
 * Attribute each spawn to the request it ran inside, and report one cycle per
 * request of `route`.
 *
 * A spawn belongs to a request when its start falls between that request's
 * start and end. Requests of one route can overlap, so a spawn matching more
 * than one is attributed to the latest-starting match and counted in
 * `ambiguous`; a nonzero count means the app served concurrent requests and
 * the per-cycle split is an attribution, not a measurement.
 *
 * `--since`/`--until` bound which requests are reported, by their start. A
 * cycle is reported whole or not at all, so the window never cuts a cycle in
 * half and leaves a partial count that reads like a real one.
 *
 * @param {string} contents
 * @param {string} route
 * @param {{ readonly since?: number; readonly until?: number }} [window]
 * @returns {{ readonly cycles: ReadonlyArray<Cycle>; readonly ambiguous: number }}
 */
export function summarizeCycles(contents, route, window = {}) {
  const { samples, requests } = collectLog(contents, route);
  const since = window.since;
  const until = window.until;
  const ordered = [...requests]
    .filter(
      (request) =>
        (since === undefined || request.startedAtMs >= since) &&
        (until === undefined || request.startedAtMs <= until),
    )
    .sort((left, right) => left.startedAtMs - right.startedAtMs);
  /** @type {Map<RequestWindow, Array<SpawnSample>>} */
  const samplesByRequest = new Map(ordered.map((request) => [request, []]));
  let ambiguous = 0;
  for (const sample of samples) {
    const matches = ordered.filter(
      (request) =>
        sample.startedAtMs >= request.startedAtMs &&
        sample.startedAtMs <= request.endedAtMs,
    );
    const owner = matches.at(-1);
    if (owner === undefined) continue;
    if (matches.length > 1) ambiguous += 1;
    samplesByRequest.get(owner)?.push(sample);
  }

  const cycles = ordered.map((request) => {
    const owned = samplesByRequest.get(request) ?? [];
    return {
      request,
      calls: owned.length,
      subprocessMs: owned.reduce((total, one) => total + one.durationMs, 0),
      rows: rowsFor(owned),
    };
  });
  return { cycles, ambiguous };
}

/**
 * Render rows as fixed-width columns with a trailing total.
 *
 * @param {ReadonlyArray<SpawnRow>} rows
 * @param {string} indent
 * @returns {ReadonlyArray<string>}
 */
function tableLines(rows, indent) {
  const header = ["calls", "total_ms", "p50_ms", "p95_ms"];
  const totals = {
    calls: rows.reduce((total, row) => total + row.calls, 0),
    totalMs: rows.reduce((total, row) => total + row.totalMs, 0),
  };
  const cells = [
    ...rows.map((row) => [
      String(row.calls),
      String(row.totalMs),
      String(row.p50Ms),
      String(row.p95Ms),
      row.label,
    ]),
    [String(totals.calls), String(totals.totalMs), "-", "-", "TOTAL"],
  ];
  const widths = header.map((name, column) =>
    cells.reduce(
      (width, row) => Math.max(width, (row[column] ?? "").length),
      name.length,
    ),
  );
  /**
   * @param {ReadonlyArray<string>} row
   * @returns {string}
   */
  const line = (row) =>
    indent +
    [
      ...widths.map((width, column) => (row[column] ?? "").padStart(width)),
      row[header.length] ?? "",
    ].join("  ");

  return [line([...header, "label"]), ...cells.map(line)];
}

/**
 * @param {{ readonly since?: number; readonly until?: number }} window
 * @returns {ReadonlyArray<string>}
 */
function boundLines(window) {
  return [
    window.since === undefined
      ? undefined
      : `since: ${new Date(window.since).toISOString()}`,
    window.until === undefined
      ? undefined
      : `until: ${new Date(window.until).toISOString()}`,
  ].filter((entry) => entry !== undefined);
}

/**
 * Render the rows as fixed-width columns with a trailing total.
 *
 * @param {ReadonlyArray<SpawnRow>} rows
 * @param {string} source
 * @param {{ readonly since?: number; readonly until?: number }} [window]
 * @returns {string}
 */
export function formatSpawnReport(rows, source, window = {}) {
  return [
    `source: ${source}`,
    ...boundLines(window),
    `labels: ${rows.length}`,
    "",
    ...tableLines(rows, ""),
    "",
  ].join("\n");
}

/**
 * Render one block per cycle, plus the per-cycle means the program's baseline
 * is quoted as.
 *
 * @param {ReadonlyArray<Cycle>} cycles
 * @param {number} ambiguous
 * @param {string} source
 * @param {string} route
 * @param {{ readonly since?: number; readonly until?: number }} [window]
 * @returns {string}
 */
export function formatCycleReport(
  cycles,
  ambiguous,
  source,
  route,
  window = {},
) {
  const calls = cycles.reduce((total, cycle) => total + cycle.calls, 0);
  const subprocessMs = cycles.reduce(
    (total, cycle) => total + cycle.subprocessMs,
    0,
  );
  const wallMs = cycles.reduce(
    (total, cycle) =>
      total + (cycle.request.endedAtMs - cycle.request.startedAtMs),
    0,
  );
  /**
   * @param {number} total
   * @returns {string}
   */
  const mean = (total) =>
    cycles.length === 0 ? "-" : String(Math.round(total / cycles.length));

  return [
    `source: ${source}`,
    `route: ${route}`,
    ...boundLines(window),
    `cycles: ${cycles.length}`,
    `ambiguous spawns: ${ambiguous}`,
    "",
    ...cycles.flatMap((cycle, index) => [
      `cycle ${index + 1}  ${new Date(cycle.request.startedAtMs).toISOString()}  ${cycle.request.correlationId}`,
      `  wall ${cycle.request.endedAtMs - cycle.request.startedAtMs} ms  spawns ${cycle.calls}  subprocess ${cycle.subprocessMs} ms`,
      ...tableLines(cycle.rows, "  "),
      "",
    ]),
    `mean per cycle: spawns ${mean(calls)}  subprocess ${mean(subprocessMs)} ms  wall ${mean(wallMs)} ms`,
    "",
  ].join("\n");
}

/**
 * @typedef {{
 *   readonly logFile: string;
 *   readonly since?: number;
 *   readonly until?: number;
 *   readonly route?: string;
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

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
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

  /** @type {{ logFile: string; since?: number; until?: number; route?: string }} */
  const value = { logFile: resolve(logFile ?? defaultLogFile) };
  if (since !== undefined) value.since = since;
  if (until !== undefined) value.until = until;
  if (route !== undefined) value.route = route;
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
  const { logFile, since, until, route } = invocation.value;
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
  if (rows.length === 0) {
    output.stderr(
      `No command-spawn entries in ${logFile}. Run the app, then rerun this command.\n`,
    );
    return 1;
  }
  output.stdout(formatSpawnReport(rows, logFile, window));
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
