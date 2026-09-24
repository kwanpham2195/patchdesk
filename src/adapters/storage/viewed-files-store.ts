import { rename } from "node:fs/promises";

import * as v from "valibot";

import {
  parseRepoRelativePath,
  type RepoRelativePath,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import type { LogEntryInput } from "../../domain/log-entry";
import { err, ok, type Result } from "../../domain/result";
import {
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** GitHub lists at most 3,000 files per pull request; this leaves headroom without being unbounded. */
export const MAX_VIEWED_FILES = 10_000;

const viewedFilesSchema = v.strictObject({
  schemaVersion: v.literal(1),
  paths: v.pipe(v.array(v.string()), v.maxLength(MAX_VIEWED_FILES)),
});

type PersistedViewedFiles = v.InferOutput<typeof viewedFilesSchema>;

/**
 * The files a reviewer marked Viewed in one Review session's Diff, keyed by
 * path. It lives in the session directory, so a new head starts empty and the
 * record goes when the session's local data goes.
 */
export class ViewedFilesStore {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly log: { readonly write: (input: LogEntryInput) => void },
  ) {}

  /** Absent is empty; an invalid record is moved aside and reads as empty (ADR 0019). */
  async load(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<Result<ReadonlyArray<RepoRelativePath>, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.viewedFilesFile(profileId, sessionId),
    );
    if (stored._tag === "err") {
      if (stored.error.reason === "not_found") return ok([]);
      if (stored.error.reason !== "invalid_json") return stored;
      return this.quarantine(profileId, sessionId, "invalid_json");
    }
    const parsed = parseViewedPaths(stored.value);
    if (parsed === undefined)
      return this.quarantine(profileId, sessionId, "invalid_stored_value");
    return ok(parsed);
  }

  /** Replaces the whole set, so the last save wins however saves interleave. */
  async save(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    paths: ReadonlyArray<RepoRelativePath>,
  ): Promise<Result<ReadonlyArray<RepoRelativePath>, StorageFailure>> {
    const unique = [...new Set(paths)].sort();
    if (unique.length > MAX_VIEWED_FILES)
      return err({
        _tag: "StorageFailure",
        operation: "write",
        reason: "invalid_stored_value",
      });
    const next: PersistedViewedFiles = { schemaVersion: 1, paths: unique };
    const written = await writeAtomicJson(
      this.paths.viewedFilesFile(profileId, sessionId),
      next,
    );
    return written._tag === "ok" ? ok(unique) : written;
  }

  private async quarantine(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    reason: "invalid_json" | "invalid_stored_value",
  ): Promise<Result<ReadonlyArray<RepoRelativePath>, StorageFailure>> {
    try {
      await rename(
        this.paths.viewedFilesFile(profileId, sessionId),
        this.paths.viewedFilesQuarantineFile(profileId, sessionId),
      );
    } catch {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    this.log.write({
      process: "main",
      level: "warn",
      topic: "viewed-files",
      message: "viewed files unreadable; moved aside and restarted empty",
      profileId,
      meta: { reason, sessionId },
    });
    return ok([]);
  }
}

function parseViewedPaths(
  input: unknown,
): ReadonlyArray<RepoRelativePath> | undefined {
  const raw = v.safeParse(viewedFilesSchema, input);
  if (!raw.success) return undefined;
  const paths: Array<RepoRelativePath> = [];
  for (const entry of raw.output.paths) {
    const path = parseRepoRelativePath(entry);
    if (path._tag === "err") return undefined;
    paths.push(path.value);
  }
  return new Set(paths).size === paths.length ? paths : undefined;
}
