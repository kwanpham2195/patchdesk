import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, join, dirname } from "node:path";
import * as v from "valibot";
import {
  nativeSessionAttemptSchema,
  type NativeSessionAttempt,
  type NativeSessionAttemptPage,
} from "#src/domain/native-session-attempt";
import type { InsightEvidenceReference } from "#src/services/insight-evidence-reference";
import type { ExplanationConnectionIdentity } from "#src/domain/explanation-channel";
import type {
  InsightReasoning,
  AccountInsightProvider,
} from "#src/domain/insight-provider";
import type {
  WorkspaceProfileId,
  ReviewId,
  InsightRunId,
} from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import {
  containsSensitiveValue,
  isNotFound,
  writeAtomicFile,
} from "./json-file";
import { evidencePathIsOwned } from "./insight-evidence-validation";
import { isPathContained } from "./path-containment";
import type { PatchdeskPaths } from "./patchdesk-paths";
import {
  MAX_NATIVE_SESSION_ATTEMPT_METADATA_BYTES,
  readNativeSessionAttemptDetails,
} from "./native-session-attempt-reader";

const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
/** One attempt owns its directory; subsequent writes are serialized by its adapter. */
export class NativeSessionAttemptStore {
  private constructor(
    readonly directory: string,
    public record: NativeSessionAttempt,
  ) {}
  get sessionDirectory(): string {
    return join(this.directory, "history");
  }

  static async create(
    paths: PatchdeskPaths,
    evidence: InsightEvidenceReference,
    identity: ExplanationConnectionIdentity | undefined,
    model: string,
    reasoning: InsightReasoning,
    provider: AccountInsightProvider = "pi-cli-account",
  ): Promise<Result<NativeSessionAttemptStore, "storage">> {
    try {
      const scope = evidence.identity;
      if (
        identity !== undefined &&
        String(identity.runId) !== String(scope.runId)
      )
        return err("storage");
      const attemptId = randomUUID();
      const directory = join(
        paths.nativeSessionsDirectory(
          scope.profileId,
          scope.reviewId,
          scope.type,
          scope.runId,
        ),
        attemptId,
      );
      if (!(await evidencePathIsOwned(paths.dataDirectory(), directory)))
        return err("storage");
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
      await mkdir(join(directory, "history"), { mode: 0o700 });
      for (const path of [
        dirname(directory),
        directory,
        join(directory, "history"),
      ]) {
        const stat = await lstat(path);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0
        )
          return err("storage");
      }
      const store = new NativeSessionAttemptStore(
        directory,
        v.parse(nativeSessionAttemptSchema, {
          format: "native-session-attempt/1",
          attemptId,
          type: scope.type,
          runId: scope.runId,
          sessionId: scope.sessionId,
          generation: identity?.generation ?? 0,
          cancelEpoch: identity?.cancelEpoch ?? 0,
          connection: identity?.connection ?? randomUUID(),
          requested: { provider, model, reasoning },
          observed: {},
          evidence: evidence.bundleId,
          capture: { status: "not_started", completeness: "unknown" },
          cleanup: {
            scope:
              provider === "pi-cli-account"
                ? scope.type === "guide" || scope.type === "walkthrough"
                  ? "pi_abort_ack_and_owned_group_only"
                  : "pi_owned_group_only"
                : "codex_owned_group_only",
            detachedBashDescendants: "unproven",
            abort: "not_required",
            hostWork:
              scope.type === "guide" || scope.type === "walkthrough"
                ? "pending"
                : "not_applicable",
            process: "not_started",
            archive: "pending",
            credentialHome:
              provider === "pi-cli-account" ? "not_applicable" : "pending",
          },
        }),
      );
      return (await store.save()) ? ok(store) : err("storage");
    } catch {
      return err("storage");
    }
  }

  /** Initial failure refuses dispatch; later failures remain subordinate to the run outcome. */
  async save(): Promise<boolean> {
    try {
      const parsed = v.safeParse(nativeSessionAttemptSchema, this.record);
      if (!parsed.success || containsSensitiveValue(parsed.output))
        return false;
      const text = JSON.stringify(parsed.output) + "\n";
      if (
        Buffer.byteLength(text) > MAX_NATIVE_SESSION_ATTEMPT_METADATA_BYTES ||
        !(await evidencePathIsOwned(
          this.directory,
          join(this.directory, "attempt.json"),
        ))
      )
        return false;
      return (
        (await writeAtomicFile(join(this.directory, "attempt.json"), text))
          ._tag === "ok"
      );
    } catch {
      return false;
    }
  }

  fail(
    phase: NonNullable<NativeSessionAttempt["firstFailure"]>["phase"],
    code: NonNullable<NativeSessionAttempt["firstFailure"]>["code"],
  ): void {
    this.record.firstFailure ??= { phase, code };
  }

  async bindCodexHome(directory: string): Promise<boolean> {
    try {
      const stat = await lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        (await realpath(directory)) !== directory
      )
        return false;
      this.record.locator = { directory, device: stat.dev, inode: stat.ino };
      return this.save();
    } catch {
      return false;
    }
  }

  async archiveCodexHistory(): Promise<void> {
    const signal = AbortSignal.timeout(10_000);
    let temporary: string | undefined;
    try {
      const locator = this.record.locator;
      const nativeId = this.record.observed.nativeSessionId;
      if (locator === undefined || nativeId === undefined) {
        this.record.capture = { status: "missing", completeness: "unknown" };
        this.record.cleanup.archive = "not_applicable";
        return;
      }
      const home = await lstat(locator.directory);
      if (
        home.dev !== locator.device ||
        home.ino !== locator.inode ||
        !home.isDirectory() ||
        home.isSymbolicLink() ||
        home.uid !== process.getuid?.() ||
        (home.mode & 0o077) !== 0 ||
        (await realpath(locator.directory)) !== locator.directory
      )
        throw new Error("history_unowned");
      let visited = 0;
      const matches: string[] = [];
      const visit = async (directory: string, depth: number): Promise<void> => {
        signal.throwIfAborted();
        const stat = await lstat(directory);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid?.()
        )
          throw new Error("history_unowned");
        for await (const entry of await opendir(directory)) {
          if (++visited > 4096) throw new Error("history_limit");
          signal.throwIfAborted();
          if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/u.test(entry.name))
            await visit(join(directory, entry.name), depth + 1);
          else if (
            entry.isFile() &&
            /^rollout-[A-Za-z0-9_.-]+\.jsonl$/u.test(entry.name) &&
            entry.name.endsWith(`-${nativeId}.jsonl`)
          )
            matches.push(join(directory, entry.name));
        }
      };
      await visit(join(locator.directory, "sessions"), 0);
      const selected = matches[0];
      if (matches.length !== 1 || selected === undefined)
        throw new Error("history_missing");
      if (
        !(await evidencePathIsOwned(locator.directory, selected)) ||
        !(await evidencePathIsOwned(this.directory, this.sessionDirectory))
      )
        throw new Error("history_unowned");
      const source = await open(
        selected,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const before = await source.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.uid !== process.getuid?.() ||
          before.size > MAX_HISTORY_BYTES
        )
          throw new Error("history_unowned");
        temporary = join(this.sessionDirectory, "history.partial");
        const destination = await open(temporary, "wx", 0o600);
        try {
          const buffer = Buffer.alloc(64 * 1024);
          let bytes = 0;
          while (bytes < before.size) {
            signal.throwIfAborted();
            const read = await source.read(
              buffer,
              0,
              Math.min(buffer.length, before.size - bytes),
              bytes,
            );
            if (read.bytesRead === 0) throw new Error("history_changed");
            let written = 0;
            while (written < read.bytesRead) {
              signal.throwIfAborted();
              const result = await destination.write(
                buffer,
                written,
                read.bytesRead - written,
                bytes + written,
              );
              if (result.bytesWritten === 0) throw new Error("history_write");
              written += result.bytesWritten;
            }
            bytes += read.bytesRead;
          }
          const after = await source.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
            throw new Error("history_changed");
          await destination.sync();
        } finally {
          await destination.close();
        }
      } finally {
        await source.close();
      }
      const name = basename(selected);
      await rename(temporary, join(this.sessionDirectory, name));
      temporary = undefined;
      this.record.historyFile = name;
      await this.capture(signal);
    } catch (cause) {
      this.record.capture = {
        status: isNotFound(cause) ? "missing" : "failed",
        completeness: "unknown",
      };
      this.record.cleanup.archive = "failed";
      this.fail("capture", "history_capture");
    } finally {
      if (temporary !== undefined)
        await unlink(temporary).catch(() => undefined);
      await this.save();
    }
  }

  /** Pi selects a fresh filename before materializing it; an existing file refuses admission. */
  async bindHistory(path: string, nativeSessionId: string): Promise<boolean> {
    try {
      const stat = await lstat(this.sessionDirectory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        return false;
      const directory = await realpath(this.sessionDirectory);
      if (
        dirname(path) !== directory ||
        !isPathContained(directory, path) ||
        basename(path) === "." ||
        !basename(path).includes(nativeSessionId) ||
        !(await evidencePathIsOwned(directory, path))
      )
        return false;
      try {
        await lstat(path);
        return false;
      } catch (cause) {
        if (!isNotFound(cause)) return false;
      }
      const next = {
        ...this.record,
        historyFile: basename(path),
        capture: {
          status: "pending" as const,
          completeness: "unknown" as const,
        },
      };
      if (!v.is(nativeSessionAttemptSchema, next)) return false;
      this.record = next;
      return this.save();
    } catch {
      return false;
    }
  }

  /** Hashes a bounded owned descriptor without parsing or retaining native text. */
  async capture(signal = AbortSignal.timeout(10_000)): Promise<void> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const name = this.record.historyFile;
      if (name === undefined) {
        this.record.capture = { status: "missing", completeness: "unknown" };
        this.record.cleanup.archive = "not_applicable";
        return;
      }
      const path = join(this.sessionDirectory, name);
      if (!(await evidencePathIsOwned(this.directory, path)))
        throw new Error("history_unowned");
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.uid !== process.getuid?.() ||
        before.size > MAX_HISTORY_BYTES
      )
        throw new Error("history_unowned");
      await file.chmod(0o600);
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      while (bytes <= before.size) {
        signal.throwIfAborted();
        const read = await file.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - bytes + 1),
          bytes,
        );
        if (read.bytesRead === 0) break;
        hash.update(buffer.subarray(0, read.bytesRead));
        bytes += read.bytesRead;
      }
      const after = await file.stat();
      if (
        bytes !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      )
        throw new Error("history_changed");
      this.record.capture = {
        status: "retained",
        completeness: "unknown",
        bytes,
        sha256: hash.digest("hex"),
      };
      this.record.cleanup.archive = "succeeded";
    } catch (cause) {
      this.record.capture = {
        status: isNotFound(cause) ? "missing" : "failed",
        completeness: "unknown",
      };
      this.record.cleanup.archive = "failed";
      this.fail("capture", "history_capture");
    } finally {
      await file?.close().catch(() => undefined);
      await this.save();
    }
  }
}

/** Optional bounded diagnostics use exact Review/type/run identity and never read history. */
export async function readNativeSessionAttempts(
  paths: PatchdeskPaths,
  scope: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly type: string;
    readonly runId: InsightRunId;
  },
  cursor?: string,
): Promise<NativeSessionAttemptPage | undefined> {
  const parsedType = v.safeParse(
    v.picklist(["brief", "analysis", "guide", "walkthrough"]),
    scope.type,
  );
  if (!parsedType.success) return undefined;
  const type = parsedType.output;
  try {
    const directory = paths.nativeSessionsDirectory(
      scope.profileId,
      scope.reviewId,
      type,
      scope.runId,
    );
    if (!(await evidencePathIsOwned(paths.dataDirectory(), directory)))
      return undefined;
    const directoryStat = await lstat(directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.uid !== process.getuid?.() ||
      (directoryStat.mode & 0o077) !== 0
    )
      return undefined;
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 256) return undefined;
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && /^[a-f0-9-]{36}$/u.test(entry.name))
        names.push(entry.name);
    }
    names.sort();
    const start = cursor === undefined ? 0 : names.indexOf(cursor);
    if (start < 0) return undefined;
    const attempts: NativeSessionAttemptPage["attempts"] = [];
    for (const name of names.slice(start, start + 2)) {
      const details = await readNativeSessionAttemptDetails(directory, name, {
        runId: scope.runId,
        type,
      });
      if (details === undefined) return undefined;
      attempts.push(details);
    }
    const page = {
      attempts,
      nextCursor: names[start + attempts.length] ?? null,
    };
    return Buffer.byteLength(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(page) }],
        structuredContent: page,
      }),
    ) <=
      32 * 1024
      ? page
      : undefined;
  } catch {
    return undefined;
  }
}
