import { readFile } from "node:fs/promises";

import type {
  GitHubReader,
} from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  type GitSha,
  parseRepoRelativePath,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../domain/ids";
import { parseUnifiedPatch } from "../domain/patch";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewSession } from "../domain/review-session";

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
 * Reads the exact base/head blobs needed by Pierre to expand omitted hunk
 * context. It never runs a shell command and only returns bounded text.
 */
export class ReviewDiffSourceService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly github: Pick<
      GitHubReader,
      "getFileContents" | "getPullRequest"
    >,
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

    const baseSha = await this.resolveBaseSha(profile.value, session.value);
    if (baseSha._tag === "err") return ok(baseSha.error);

    const oldPath = parseRepoRelativePath(file.oldPath);
    const newPath = parseRepoRelativePath(file.newPath);
    if (oldPath._tag === "err" || newPath._tag === "err") {
      return ok({ state: "unavailable", reason: "path_unavailable" });
    }
    const pr = {
      host: session.value.key.host,
      owner: session.value.key.owner,
      repo: session.value.key.repo,
      number: session.value.key.prNumber,
    };
    const oldAbsent = /^--- \/dev\/null$/m.test(rawFilePatch);
    const newAbsent = /^\+\+\+ \/dev\/null$/m.test(rawFilePatch);
    const [oldResult, newResult] = await Promise.all([
      oldAbsent
        ? Promise.resolve(undefined)
        : this.github.getFileContents({
            profile: profile.value,
            pr,
            sha: baseSha.value,
            path: oldPath.value,
          }),
      newAbsent
        ? Promise.resolve(undefined)
        : this.github.getFileContents({
            profile: profile.value,
            pr,
            sha: session.value.key.headSha,
            path: newPath.value,
          }),
    ]);
    const unavailable = unavailableReason(oldResult) ?? unavailableReason(newResult);
    if (unavailable !== undefined) return ok(unavailable);
    const oldContents = sourceContents(oldResult);
    const newContents = sourceContents(newResult);
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

  private async resolveBaseSha(
    profile: WorkspaceProfileConfig,
    session: ReviewSession,
  ): Promise<Result<GitSha, ReviewDiffSource>> {
    if (session.pr.baseSha !== undefined) return ok(session.pr.baseSha);
    const current = await this.github.getPullRequest({
      profile,
      pr: {
        host: session.key.host,
        owner: session.key.owner,
        repo: session.key.repo,
        number: session.key.prNumber,
      },
    });
    if (current._tag === "err") {
      return err({ state: "unavailable", reason: "github_read" });
    }
    if (current.value.headSha !== session.key.headSha) {
      return err({ state: "unavailable", reason: "head_changed" });
    }
    if (current.value.baseSha === undefined) {
      return err({ state: "unavailable", reason: "legacy_snapshot" });
    }
    return ok(current.value.baseSha);
  }
}

function sourceContents(
  result: Awaited<ReturnType<GitHubReader["getFileContents"]>> | undefined,
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
  result: Awaited<ReturnType<GitHubReader["getFileContents"]>> | undefined,
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
