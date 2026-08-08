import { appendFile, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import {
  normalizeLogEntry,
  parseLogEntry,
  sanitizeLogEntry,
  type LogEntry,
  type LogEntryInput,
} from "../domain/log-entry";

export type AppLogServiceOptions = {
  readonly bufferSize?: number;
  readonly maxFileBytes?: number;
  readonly rotatedFilesToKeep?: number;
  readonly stdoutMirror?: boolean;
};

export const APP_LOG_DEFAULT_BUFFER_SIZE = 2_000;
export const APP_LOG_DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const APP_LOG_DEFAULT_ROTATED_FILES_TO_KEEP = 3;

/**
 * Unified local log stream: in-memory ring buffer for tailing plus an
 * append-only JSONL file for terminal tail -f. Writes are best effort and
 * never throw into app flows. Credentials are never persisted.
 */
export class AppLogService {
  private readonly bufferSize: number;
  private readonly maxFileBytes: number;
  private readonly rotatedFilesToKeep: number;
  private stdoutMirror: boolean;
  private readonly entries: LogEntry[] = [];
  private seq = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: PatchdeskPaths,
    options: AppLogServiceOptions = {},
  ) {
    this.bufferSize = Math.min(10_000, Math.max(1, options.bufferSize ?? APP_LOG_DEFAULT_BUFFER_SIZE));
    this.maxFileBytes = Math.min(64 * 1024 * 1024, Math.max(1_024, options.maxFileBytes ?? APP_LOG_DEFAULT_MAX_FILE_BYTES));
    this.rotatedFilesToKeep = Math.min(20, Math.max(1, options.rotatedFilesToKeep ?? APP_LOG_DEFAULT_ROTATED_FILES_TO_KEEP));
    this.stdoutMirror = options.stdoutMirror ?? false;
  }

  /** Record one entry; seq and timestamp are stamped here, never by callers. */
  write(input: LogEntryInput): void {
    const entry = normalizeLogEntry({ ...input, seq: this.seq, at: new Date().toISOString() });
    this.seq += 1;
    this.entries.push(entry);
    if (this.entries.length > this.bufferSize) {
      this.entries.splice(0, this.entries.length - this.bufferSize);
    }
    this.mirrorStdout(entry);
    this.writes = this.writes.then(() => this.persist(entry)).catch(() => undefined);
  }

  /** Await the current append chain; used at shutdown so the last entries land on disk. */
  async flush(): Promise<void> {
    await this.writes;
  }

  /** Tail the in-memory stream; `after` resumes from the first entry with seq > after. */
  tail(after?: number, limit?: number): { readonly entries: ReadonlyArray<LogEntry>; readonly nextSeq: number } {
    const safeLimit = Math.min(this.bufferSize, Math.max(1, limit ?? 500));
    let slice: LogEntry[];
    if (after === undefined) {
      slice = this.entries.slice(-safeLimit);
    } else {
      const start = this.entries.findIndex((entry) => entry.seq > after);
      slice = start === -1 ? [] : this.entries.slice(start, start + safeLimit);
    }
    return { entries: slice, nextSeq: this.seq };
  }

  /** Enable or disable the terminal mirror (dev runs, --patchdesk-tail-logs). */
  setStdoutMirror(enabled: boolean): void {
    this.stdoutMirror = enabled;
  }

  private mirrorStdout(entry: LogEntry): void {
    if (this.stdoutMirror !== true) return;
    const time = entry.at.slice(11, 23);
    process.stdout.write(`[${time}] ${entry.level.toUpperCase().padEnd(5)} ${entry.process.padEnd(8)} ${entry.topic} — ${entry.message}\n`);
  }

  private async persist(entry: LogEntry): Promise<void> {
    const file = this.paths.logFile();
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await this.rotateIfNeeded(file);
      await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Logging must never break app flows; the ring buffer still serves tailing.
    }
  }

  private async rotateIfNeeded(file: string): Promise<void> {
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      return;
    }
    if (size < this.maxFileBytes) return;
    const rotated = join(dirname(file), `patchdesk-${Date.now()}.jsonl`);
    try {
      await rename(file, rotated);
      await this.pruneRotated(dirname(file));
    } catch {
      // Keep appending to the oversized file rather than losing the stream.
    }
  }

  private async pruneRotated(directory: string): Promise<void> {
    try {
      const entries = await readdir(directory);
      const rotated = entries.filter((name) => /^patchdesk-\d+\.jsonl$/.test(name)).sort();
      const excess = rotated.length - this.rotatedFilesToKeep;
      if (excess <= 0) return;
      for (const name of rotated.slice(0, excess)) {
        await rm(join(directory, name), { force: true });
      }
    } catch {
      // Pruning is housekeeping; never fail the write.
    }
  }
}

/** Load every valid entry from a log file (used by tests and file recovery). */
export async function readLogFile(paths: PatchdeskPaths): Promise<ReadonlyArray<LogEntry>> {
  const file = paths.logFile();
  const contents = await readFileBounded(file);
  const entries: LogEntry[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const parsed = parseLogEntry(parsedInput);
    if (parsed !== undefined) entries.push(sanitizeLogEntry(parsed));
  }
  return entries;
}

async function readFileBounded(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const details = await handle.stat();
    const buffer = Buffer.alloc(details.size);
    const read = await handle.read(buffer, 0, details.size, 0);
    return buffer.subarray(0, read.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
