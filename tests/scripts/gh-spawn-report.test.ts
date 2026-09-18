import { describe, expect, it } from "vitest";

import {
  parseArguments,
  summarizeCycles,
  summarizeSpawns,
} from "../../scripts/gh-spawn-report.mjs";

/** A `command-spawn` line as `NodeCommandExecutor` writes it: `at` is when the child finished. */
const spawnLine = (options: {
  readonly endedAt: string;
  readonly durationMs: number;
  readonly label?: string;
}): string =>
  JSON.stringify({
    schemaVersion: 1,
    at: options.endedAt,
    process: "main",
    level: "debug",
    topic: "command-spawn",
    message: "gh api",
    meta: {
      executable: "gh",
      label: options.label ?? "api GET repos/:owner/:repo/pulls/:n",
      durationMs: options.durationMs,
      outcome: "Exited",
      exitCode: 0,
    },
  });

/** The main process's served-request line. `process: "renderer"` + `topic: "api"` is the duplicate. */
const requestLine = (options: {
  readonly endedAt: string;
  readonly durationMs: number;
  readonly correlationId: string;
  readonly topic?: string;
  readonly message?: string;
}): string =>
  JSON.stringify({
    schemaVersion: 1,
    at: options.endedAt,
    process: options.topic === "api" ? "renderer" : "main",
    level: "debug",
    topic: options.topic ?? "http",
    message: options.message ?? "POST /v1/reviews/detect-updates",
    meta: {
      status: 200,
      durationMs: options.durationMs,
      correlationId: options.correlationId,
    },
  });

const route = "POST /v1/reviews/detect-updates";

describe("cycle membership", () => {
  it("attributes a spawn by when it started, not when it finished", () => {
    // The request runs 10:00:00.000 to 10:00:05.000.
    const contents = [
      requestLine({
        endedAt: "2026-09-18T10:00:05.000Z",
        durationMs: 5000,
        correlationId: "cycle-1",
      }),
      // Started 10:00:01, finished 10:00:04 — wholly inside.
      spawnLine({ endedAt: "2026-09-18T10:00:04.000Z", durationMs: 3000 }),
      // Started 10:00:04, finished 10:00:09 — started inside, outlived the request.
      spawnLine({ endedAt: "2026-09-18T10:00:09.000Z", durationMs: 5000 }),
      // Started 09:59:58, finished 10:00:02 — finished inside but started before.
      spawnLine({ endedAt: "2026-09-18T10:00:02.000Z", durationMs: 4000 }),
    ].join("\n");

    const { cycles } = summarizeCycles(contents, route);

    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.calls).toBe(2);
    expect(cycles[0]?.subprocessMs).toBe(8000);
  });

  it("counts the request once when the renderer logs it again", () => {
    const contents = [
      requestLine({
        endedAt: "2026-09-18T10:00:05.000Z",
        durationMs: 5000,
        correlationId: "cycle-1",
      }),
      requestLine({
        endedAt: "2026-09-18T10:00:05.050Z",
        durationMs: 5050,
        correlationId: "cycle-1",
        topic: "api",
      }),
      spawnLine({ endedAt: "2026-09-18T10:00:04.000Z", durationMs: 3000 }),
    ].join("\n");

    const { cycles } = summarizeCycles(contents, route);

    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.calls).toBe(1);
  });

  it("reports a spawn matching two overlapping requests as ambiguous", () => {
    const contents = [
      requestLine({
        endedAt: "2026-09-18T10:00:10.000Z",
        durationMs: 10_000,
        correlationId: "outer",
      }),
      requestLine({
        endedAt: "2026-09-18T10:00:08.000Z",
        durationMs: 4000,
        correlationId: "inner",
      }),
      // Started 10:00:05 — inside both.
      spawnLine({ endedAt: "2026-09-18T10:00:06.000Z", durationMs: 1000 }),
    ].join("\n");

    const { cycles, ambiguous } = summarizeCycles(contents, route);

    expect(ambiguous).toBe(1);
    // Attributed to the latest-starting match, so it is counted once, not twice.
    const byId = new Map(
      cycles.map((cycle) => [cycle.request.correlationId, cycle.calls]),
    );
    expect(byId.get("inner")).toBe(1);
    expect(byId.get("outer")).toBe(0);
  });

  it("drops a cycle whose request started outside the window", () => {
    const contents = [
      requestLine({
        endedAt: "2026-09-18T10:00:05.000Z",
        durationMs: 5000,
        correlationId: "early",
      }),
      requestLine({
        endedAt: "2026-09-18T12:00:05.000Z",
        durationMs: 5000,
        correlationId: "late",
      }),
      spawnLine({ endedAt: "2026-09-18T12:00:04.000Z", durationMs: 3000 }),
    ].join("\n");

    const { cycles } = summarizeCycles(contents, route, {
      since: Date.parse("2026-09-18T11:00:00.000Z"),
    });

    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.request.correlationId).toBe("late");
  });

  it("ignores requests of another route", () => {
    const contents = [
      requestLine({
        endedAt: "2026-09-18T10:00:05.000Z",
        durationMs: 5000,
        correlationId: "other",
        message: "POST /v1/reviews/refresh",
      }),
      spawnLine({ endedAt: "2026-09-18T10:00:04.000Z", durationMs: 3000 }),
    ].join("\n");

    expect(summarizeCycles(contents, route).cycles).toHaveLength(0);
  });
});

describe("window filtering", () => {
  const contents = [
    spawnLine({ endedAt: "2026-09-18T10:00:04.000Z", durationMs: 3000 }),
    spawnLine({ endedAt: "2026-09-18T12:00:04.000Z", durationMs: 3000 }),
  ].join("\n");

  it("summarizes the whole file when no window is given", () => {
    expect(summarizeSpawns(contents)[0]?.calls).toBe(2);
  });

  it("keeps only the spawns that started inside the window", () => {
    const rows = summarizeSpawns(contents, {
      since: Date.parse("2026-09-18T11:00:00.000Z"),
    });

    expect(rows[0]?.calls).toBe(1);
    expect(rows[0]?.totalMs).toBe(3000);
  });
});

describe("parseArguments", () => {
  it("rejects a timestamp it cannot parse", () => {
    const parsed = parseArguments(["--since", "nonsense"]);

    expect(parsed._tag).toBe("err");
  });

  it("rejects a window that ends before it starts", () => {
    const parsed = parseArguments([
      "--since",
      "2026-09-18T12:00:00Z",
      "--until",
      "2026-09-18T10:00:00Z",
    ]);

    expect(parsed._tag).toBe("err");
  });

  it("turns --route into cycles mode without --cycles", () => {
    const parsed = parseArguments(["--route", "POST /v1/reviews/refresh"]);

    expect(parsed._tag === "ok" && parsed.value.route).toBe(
      "POST /v1/reviews/refresh",
    );
  });

  it("defaults --cycles to the detect-updates route", () => {
    const parsed = parseArguments(["--cycles"]);

    expect(parsed._tag === "ok" && parsed.value.route).toBe(
      "POST /v1/reviews/detect-updates",
    );
  });
});
