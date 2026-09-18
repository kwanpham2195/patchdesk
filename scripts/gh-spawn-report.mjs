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
 * Pull the spawn duration out of one parsed log line, or return undefined for
 * every other entry in the shared stream.
 *
 * @param {unknown} entry
 * @returns {{ readonly label: string; readonly durationMs: number } | undefined}
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
  if (executable === undefined || label === undefined) return undefined;
  if (durationMs === undefined) return undefined;
  return { label: `${executable} ${label}`, durationMs };
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
 * Group the spawn entries of a whole log file into one row per label.
 *
 * @param {string} contents
 * @returns {ReadonlyArray<SpawnRow>}
 */
export function summarizeSpawns(contents) {
  /** @type {Map<string, Array<number>>} */
  const durationsByLabel = new Map();
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
    if (spawn === undefined) continue;
    const durations = durationsByLabel.get(spawn.label) ?? [];
    durations.push(spawn.durationMs);
    durationsByLabel.set(spawn.label, durations);
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
 * Render the rows as fixed-width columns with a trailing total.
 *
 * @param {ReadonlyArray<SpawnRow>} rows
 * @param {string} source
 * @returns {string}
 */
export function formatSpawnReport(rows, source) {
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
    [
      ...widths.map((width, column) => (row[column] ?? "").padStart(width)),
      row[header.length] ?? "",
    ].join("  ");

  return [
    `source: ${source}`,
    `labels: ${rows.length}`,
    "",
    line([...header, "label"]),
    ...cells.map(line),
    "",
  ].join("\n");
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
  if (args.length > 1) {
    output.stderr("Usage: node scripts/gh-spawn-report.mjs [<log-file>]\n");
    return 2;
  }
  const source = resolve(args[0] ?? defaultLogFile);
  /** @type {string} */
  let contents;
  try {
    contents = await readSource(source);
  } catch {
    output.stderr(`Could not read the log file at ${source}.\n`);
    return 1;
  }
  const rows = summarizeSpawns(contents);
  if (rows.length === 0) {
    output.stderr(
      `No command-spawn entries in ${source}. Run the app, then rerun this command.\n`,
    );
    return 1;
  }
  output.stdout(formatSpawnReport(rows, source));
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
