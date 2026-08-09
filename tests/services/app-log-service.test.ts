import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { AppLogService, readLogFile } from "../../src/services/app-log-service";

const roots: Array<string> = [];

afterEach(async () => {
  roots.splice(0).forEach(() => undefined);
});

async function makePaths(): Promise<PatchdeskPaths> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-logs-"));
  roots.push(root);
  return PatchdeskPaths.forTest(root);
}

function entry(overrides: Partial<Parameters<AppLogService["write"]>[0]> = {}): Parameters<AppLogService["write"]>[0] {
  return { process: "main", level: "info", topic: "test", message: "hello", ...overrides };
}

describe("AppLogService", () => {
  it("stamps seq and timestamp, and tail returns the bounded window", async () => {
    const paths = await makePaths();
    const service = new AppLogService(paths, { bufferSize: 3 });
    for (let index = 0; index < 5; index += 1) {
      service.write(entry({ message: `entry-${index}` }));
    }
    await service.flush();
    const tailed = service.tail();
    expect(tailed.entries.map((item) => item.message)).toEqual(["entry-2", "entry-3", "entry-4"]);
    expect(tailed.entries[0]?.seq).toBe(2);
    expect(tailed.nextAfter).toBe(4);
  });

  it("resumes from after seq", async () => {
    const paths = await makePaths();
    const service = new AppLogService(paths, { bufferSize: 10 });
    for (let index = 0; index < 4; index += 1) service.write(entry({ message: `entry-${index}` }));
    const first = service.tail();
    service.write(entry({ message: "entry-4" }));
    const resumed = service.tail(first.entries[first.entries.length - 1]?.seq);
    expect(resumed.entries.map((item) => item.message)).toEqual(["entry-4"]);
  });

  it("returns the last delivered sequence as the exclusive-resume cursor", async () => {
    const paths = await makePaths();
    const service = new AppLogService(paths, { bufferSize: 10 });
    for (let index = 0; index < 3; index += 1) service.write(entry({ message: `entry-${index}` }));
    const tailed = service.tail();
    // Entries 0..2 were delivered; the next poll must resume after 2, not
    // after the next value to allocate (3), or entry 3 would be skipped.
    expect(tailed.nextAfter).toBe(2);
  });

  it("preserves the supplied cursor when a poll returns no entries", async () => {
    const paths = await makePaths();
    const service = new AppLogService(paths, { bufferSize: 10 });
    service.write(entry({ message: "entry-0" }));
    const tailed = service.tail(0);
    expect(tailed.entries).toEqual([]);
    expect(tailed.nextAfter).toBe(0);
  });

  it("persists every entry to the JSONL file and rotates on size", async () => {
    const paths = await makePaths();
    const service = new AppLogService(paths, { maxFileBytes: 1_024, rotatedFilesToKeep: 2 });
    for (let index = 0; index < 200; index += 1) {
      service.write(entry({ message: `entry-${index}`.padEnd(80, "x") }));
    }
    await service.flush();
    const file = await readFile(paths.logFile(), "utf8");
    expect(file.split("\n").filter(Boolean).length).toBeGreaterThan(0);
    const rotated = (await readdir(paths.logsDirectory())).filter((name) => /^patchdesk-\d+\.jsonl$/.test(name));
    expect(rotated.length).toBeGreaterThan(0);
    expect(rotated.length).toBeLessThanOrEqual(2);

    const all = await readLogFile(paths);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((item) => item.schemaVersion === 1)).toBe(true);
    // Rotation prunes old files by design; the retained files must hold a
    // contiguous seq tail ending at the newest entry, with nothing lost mid-stream.
    const seqs = new Set(all.map((item) => item.seq));
    for (const name of rotated) {
      for (const line of (await readFile(join(paths.logsDirectory(), name), "utf8")).split("\n")) {
        if (line.trim().length === 0) continue;
        const parsed = JSON.parse(line) as { seq?: unknown };
        if (typeof parsed.seq === "number") seqs.add(parsed.seq);
      }
    }
    expect(Math.max(...seqs)).toBe(199);
    const first = 200 - seqs.size;
    for (let seq = first; seq < 200; seq += 1) expect(seqs.has(seq)).toBe(true);
  });

  it("redacts credentials before persisting", async () => {
    const paths = await makePaths();
    const service = new AppLogService(paths);
    service.write(entry({ message: "token ghp_1234567890abcdef still here" }));
    await service.flush();
    const all = await readLogFile(paths);
    expect(all[0]?.message).not.toContain("ghp_1234567890abcdef");
    expect(all[0]?.message).toContain("still here");
  });

  it("never throws when the file system is unavailable", async () => {
    const service = new AppLogService(PatchdeskPaths.forTest("/nonexistent-root"));
    expect(() => service.write(entry({ message: "boom".repeat(50) }))).not.toThrow();
    await service.flush();
    expect(service.tail().entries).toHaveLength(1);
  });
});
