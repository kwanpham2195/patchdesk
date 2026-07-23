import { readFile } from "node:fs/promises";

import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  parseRepoRelativePath,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../domain/ids";
import { parseUnifiedPatch } from "../domain/patch";
import { err, ok, type Result } from "../domain/result";
import type { ReviewSession } from "../domain/review-session";
import type { GitReadExecutor } from "./review-worktree-service";

const maxHydratedFileBytes = 1024 * 1024;

export type ReviewDiffSource =
  | {
      readonly state: "ready";
      readonly oldFile?: { readonly name: string; readonly contents: string };
      readonly newFile?: { readonly name: string; readonly contents: string };
    }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "legacy_snapshot"
        | "head_changed"
        | "patch_unavailable"
        | "path_unavailable"
        | "binary"
        | "too_large"
        | "github_read";
    };

export type ReviewDiffSourceFailure = {
  readonly reason: "invalid_input" | "not_found" | "storage";
};

/**
 * Reads the exact managed base/head blobs needed by Pierre to expand omitted
 * hunk context. It only uses main-process argv-array Git reads and returns
 * bounded text that matches the immutable saved patch.
 */
export class ReviewDiffSourceService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly git: GitReadExecutor,
  ) {}

  async load(input: unknown): Promise<Result<ReviewDiffSource, ReviewDiffSourceFailure>> {
    const profileId = parseWorkspaceProfileId(field(input, "profileId"));
    const sessionId = parseReviewSessionId(field(input, "sessionId"));
    const requestedPath = parseRepoRelativePath(field(input, "path"));
    if (
      profileId._tag === "err" ||
      sessionId._tag === "err" ||
      requestedPath._tag === "err"
    ) {
      return err({ reason: "invalid_input" });
    }

    const [profile, session] = await Promise.all([
      this.profiles.load(profileId.value),
      this.sessions.load(profileId.value, sessionId.value),
    ]);
    if (profile._tag === "err" || session._tag === "err") {
      return err({ reason: "not_found" });
    }

    const patch = await readFile(session.value.patchPath, "utf8").catch(
      () => undefined,
    );
    if (patch === undefined) {
      return ok({ state: "unavailable", reason: "patch_unavailable" });
    }
    const file = parseUnifiedPatch(patch).find(
      (candidate) =>
        candidate.newPath === requestedPath.value ||
        candidate.oldPath === requestedPath.value,
    );
    const rawFilePatch = patchForPath(patch, requestedPath.value);
    if (
      file === undefined ||
      rawFilePatch === undefined ||
      file.kind === "binary" ||
      file.kind === "omitted"
    ) {
      return ok({ state: "unavailable", reason: "path_unavailable" });
    }

    if (session.value.pr.baseSha === undefined) {
      return ok({ state: "unavailable", reason: "legacy_snapshot" });
    }

    const oldPath = parseRepoRelativePath(file.oldPath);
    const newPath = parseRepoRelativePath(file.newPath);
    if (oldPath._tag === "err" || newPath._tag === "err") {
      return ok({ state: "unavailable", reason: "path_unavailable" });
    }
    const oldAbsent = /^--- \/dev\/null$/m.test(rawFilePatch);
    const newAbsent = /^\+\+\+ \/dev\/null$/m.test(rawFilePatch);
    const [oldResult, newResult] = await Promise.all([
      oldAbsent
        ? Promise.resolve(undefined)
        : this.readBlob(session.value, "base", oldPath.value),
      newAbsent
        ? Promise.resolve(undefined)
        : this.readBlob(session.value, "head", newPath.value),
    ]);
    const unavailable = unavailableReason(oldResult) ?? unavailableReason(newResult);
    if (unavailable !== undefined) return ok(unavailable);
    const oldContents = sourceContents(oldResult);
    const newContents = sourceContents(newResult);
    if (!matchesPatch(rawFilePatch, oldContents, newContents)) {
      return ok({ state: "unavailable", reason: "patch_unavailable" });
    }
    return ok({
      state: "ready",
      ...(oldResult === undefined
        ? {}
        : { oldFile: { name: file.oldPath, contents: oldContents } }),
      ...(newResult === undefined
        ? {}
        : { newFile: { name: file.newPath, contents: newContents } }),
    });
  }

  private async readBlob(
    session: ReviewSession,
    side: "base" | "head",
    path: string,
  ): Promise<Result<{ readonly state: "available"; readonly contents: string } | { readonly state: "binary" | "too_large" }, { readonly reason: "github_read" }>> {
    const ref = `refs/patchdesk/reviews/${session.key.profileId}/${session.id}/${side}`;
    const blob = await this.git.run([
      "git",
      "-C",
      session.worktree.path,
      "show",
      "--no-textconv",
      "--end-of-options",
      `${ref}:${path}`,
    ]);
    if (blob._tag === "err") return err({ reason: "github_read" });
    const bytes = Buffer.byteLength(blob.value.stdout, "utf8");
    if (bytes > maxHydratedFileBytes) return ok({ state: "too_large" });
    if (blob.value.stdout.includes("\0")) return ok({ state: "binary" });
    return ok({ state: "available", contents: blob.value.stdout });
  }
}

function sourceContents(
  result: Result<{ readonly state: "available"; readonly contents: string } | { readonly state: "binary" | "too_large" }, { readonly reason: "github_read" }> | undefined,
): string {
  if (
    result === undefined ||
    result._tag === "err" ||
    result.value.state !== "available"
  ) {
    return "";
  }
  return result.value.contents;
}

function unavailableReason(
  result: Result<{ readonly state: "available"; readonly contents: string } | { readonly state: "binary" | "too_large" }, { readonly reason: "github_read" }> | undefined,
): Extract<ReviewDiffSource, { readonly state: "unavailable" }> | undefined {
  if (result === undefined) return undefined;
  if (result._tag === "err") {
    return { state: "unavailable", reason: "github_read" };
  }
  if (result.value.state === "binary") {
    return { state: "unavailable", reason: "binary" };
  }
  if (result.value.state === "too_large") {
    return { state: "unavailable", reason: "too_large" };
  }
  return undefined;
}

/**
 * The hydrated source must describe the exact immutable patch. Without this
 * check a moving PR diff and an older SHA can make Pierre calculate impossible
 * trailing context, which is both misleading and a virtualizer crash.
 */
function matchesPatch(
  rawPatch: string,
  oldContents: string,
  newContents: string,
): boolean {
  const oldLines = splitLines(oldContents);
  const newLines = splitLines(newContents);
  let oldIndex = 0;
  let newIndex = 0;
  let inHunk = false;
  for (const rawLine of rawPatch.replaceAll("\r\n", "\n").split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (header !== null) {
      oldIndex = Number(header[1]) - 1;
      newIndex = Number(header[2]) - 1;
      inHunk = true;
      continue;
    }
    if (!inHunk || rawLine.startsWith("\\ No newline at end of file")) continue;
    const content = rawLine.slice(1);
    if (rawLine.startsWith(" ")) {
      if (oldLines[oldIndex] !== content || newLines[newIndex] !== content) return false;
      oldIndex += 1;
      newIndex += 1;
    } else if (rawLine.startsWith("-")) {
      if (oldLines[oldIndex] !== content) return false;
      oldIndex += 1;
    } else if (rawLine.startsWith("+")) {
      if (newLines[newIndex] !== content) return false;
      newIndex += 1;
    }
  }
  return true;
}

function splitLines(contents: string): ReadonlyArray<string> {
  const normalized = contents.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function patchForPath(patch: string, path: string): string | undefined {
  return patch
    .split(/(?=^diff --git )/m)
    .find(
      (candidate) =>
        candidate.startsWith("diff --git ") &&
        (candidate.includes(` a/${path} b/`) || candidate.includes(` b/${path}\n`)),
    );
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}
