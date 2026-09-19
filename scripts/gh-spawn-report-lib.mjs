/**
 * The analysis behind `scripts/gh-spawn-report.mjs`: read `command-spawn` and
 * `http` entries out of a JSONL log, group them into rows and per-request
 * cycles, and render either as text.
 *
 * Nothing here touches the filesystem or the process, so the report of a given
 * log is a pure function of its contents and the window asked for.
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
export const asInstantMs = (value) => {
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
 * One shadowed read, as `TransportShadow` logged it (issue #292). The entry is
 * written once both transports have settled, so `atMs` is when the comparison
 * finished rather than when the read started.
 *
 * @typedef {{
 *   readonly label: string;
 *   readonly outcome: string;
 *   readonly firstDifference: string | undefined;
 *   readonly atMs: number;
 * }} ShadowSample
 */

/**
 * @typedef {{
 *   readonly label: string;
 *   readonly calls: number;
 *   readonly match: number;
 *   readonly diverged: number;
 *   readonly skipped: number;
 *   readonly firstDifference: string;
 * }} ShadowRow
 */

const SHADOW_OUTCOMES = ["match", "diverged", "skipped"];

/**
 * Pull one `transport-shadow` entry out of a parsed log line, or return
 * undefined for every other entry in the shared stream.
 *
 * @param {unknown} entry
 * @returns {ShadowSample | undefined}
 */
export function readShadowEntry(entry) {
  const record = asRecord(entry);
  if (record === undefined || record["topic"] !== "transport-shadow") {
    return undefined;
  }
  const fields = asRecord(record["meta"]);
  if (fields === undefined) return undefined;
  const label = asText(fields["label"]);
  const outcome = asText(fields["outcome"]);
  const atMs = asInstantMs(record["at"]);
  if (label === undefined || atMs === undefined) return undefined;
  if (outcome === undefined || !SHADOW_OUTCOMES.includes(outcome)) {
    return undefined;
  }
  return {
    label,
    outcome,
    firstDifference: asText(fields["firstDifference"]),
    atMs,
  };
}

/**
 * Group the shadow entries of a log file into one row per label, so the
 * cutover decision for a label is a number rather than a judgement.
 *
 * @param {string} contents
 * @param {{ readonly since?: number; readonly until?: number }} [window]
 * @returns {ReadonlyArray<ShadowRow>}
 */
export function summarizeShadow(contents, window = {}) {
  const since = window.since;
  const until = window.until;
  /** @type {Map<string, Array<ShadowSample>>} */
  const samplesByLabel = new Map();
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const sample = readShadowEntry(parsed);
    if (sample === undefined) continue;
    if (since !== undefined && sample.atMs < since) continue;
    if (until !== undefined && sample.atMs > until) continue;
    const samples = samplesByLabel.get(sample.label) ?? [];
    samples.push(sample);
    samplesByLabel.set(sample.label, samples);
  }

  /** @type {Array<ShadowRow>} */
  const rows = [];
  for (const [label, samples] of samplesByLabel) {
    rows.push({
      label,
      calls: samples.length,
      match: samples.filter((one) => one.outcome === "match").length,
      diverged: samples.filter((one) => one.outcome === "diverged").length,
      skipped: samples.filter((one) => one.outcome === "skipped").length,
      firstDifference: commonestFirstDifference(samples),
    });
  }
  return rows.sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Where this label's divergences most often started, which is the first thing
 * to read when a label is not clean. Ties break by the path itself, so two
 * runs of the report over the same log read the same.
 *
 * @param {ReadonlyArray<ShadowSample>} samples
 * @returns {string}
 */
function commonestFirstDifference(samples) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const sample of samples) {
    if (sample.outcome !== "diverged" || sample.firstDifference === undefined) {
      continue;
    }
    counts.set(
      sample.firstDifference,
      (counts.get(sample.firstDifference) ?? 0) + 1,
    );
  }
  const ranked = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  return ranked[0]?.[0] ?? "-";
}

/**
 * Render one row per label, with the totals a cutover is judged on.
 *
 * @param {ReadonlyArray<ShadowRow>} rows
 * @param {string} source
 * @param {{ readonly since?: number; readonly until?: number }} [window]
 * @returns {string}
 */
export function formatShadowReport(rows, source, window = {}) {
  const header = ["calls", "match", "diverged", "skipped"];
  const cells = [
    ...rows.map((row) => [
      String(row.calls),
      String(row.match),
      String(row.diverged),
      String(row.skipped),
      row.label,
      row.firstDifference,
    ]),
    [
      String(rows.reduce((total, row) => total + row.calls, 0)),
      String(rows.reduce((total, row) => total + row.match, 0)),
      String(rows.reduce((total, row) => total + row.diverged, 0)),
      String(rows.reduce((total, row) => total + row.skipped, 0)),
      "TOTAL",
      "",
    ],
  ];
  const widths = header.map((name, column) =>
    cells.reduce(
      (width, row) => Math.max(width, (row[column] ?? "").length),
      name.length,
    ),
  );
  const labelWidth = cells.reduce(
    (width, row) => Math.max(width, (row[header.length] ?? "").length),
    "label".length,
  );
  /**
   * @param {ReadonlyArray<string>} row
   * @returns {string}
   */
  const line = (row) =>
    [
      ...widths.map((width, column) => (row[column] ?? "").padStart(width)),
      (row[header.length] ?? "").padEnd(labelWidth),
      row[header.length + 1] ?? "",
    ]
      .join("  ")
      .trimEnd();

  return [
    `source: ${source}`,
    ...boundLines(window),
    `labels: ${rows.length}`,
    "",
    line([...header, "label", "first_difference"]),
    ...cells.map(line),
    "",
  ].join("\n");
}
