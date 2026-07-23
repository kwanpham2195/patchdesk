import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ReviewAttemptId, ReviewSessionId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";

export type PreparedAttemptArtifacts = {
  readonly contextPath: string;
  readonly reviewInputPath: string;
  readonly debugPath: string;
};

/** Immutable prepared inputs live on the session, never under attempt `001`. */
export type PreparedReviewArtifacts = PreparedAttemptArtifacts;

export function preparedReviewArtifacts(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
): PreparedReviewArtifacts {
  return {
    contextPath: paths.preparedContextFile(profileId, sessionId),
    reviewInputPath: paths.preparedReviewInputFile(profileId, sessionId),
    debugPath: paths.preparedDebugFile(profileId, sessionId),
  };
}

/** Returns the only artifact locations a persisted review attempt may use. */
export function preparedAttemptArtifacts(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
  attemptId: ReviewAttemptId,
): PreparedAttemptArtifacts {
  return {
    contextPath: paths.attemptContextFile(profileId, sessionId, attemptId),
    reviewInputPath: paths.attemptReviewInputFile(profileId, sessionId, attemptId),
    debugPath: paths.attemptDebugFile(profileId, sessionId, attemptId),
  };
}

/**
 * Copies immutable session inputs into the allocated attempt directory. Existing local
 * sessions created before session-owned preparation are read through their historical
 * `001` directory once; all new sessions use only `prepared/`.
 */
export async function prepareAttemptArtifacts(input: {
  readonly paths: PatchdeskPaths;
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly attemptId: ReviewAttemptId;
}): Promise<Result<PreparedAttemptArtifacts, { readonly _tag: "PreparedArtifactsUnavailable" }>> {
  const target = preparedAttemptArtifacts(input.paths, input.profileId, input.sessionId, input.attemptId);
  const prepared = preparedReviewArtifacts(input.paths, input.profileId, input.sessionId);
  const source = await hasPreparedSnapshot(prepared)
    ? prepared
    : preparedAttemptArtifacts(input.paths, input.profileId, input.sessionId, "001" as ReviewAttemptId);
  try {
    await mkdir(dirname(target.contextPath), { recursive: true });
    await Promise.all([
      copyFile(source.contextPath, target.contextPath),
      copyFile(source.reviewInputPath, target.reviewInputPath),
      copyFile(source.debugPath, target.debugPath),
    ]);
    return ok(target);
  } catch {
    return err({ _tag: "PreparedArtifactsUnavailable" });
  }
}

async function hasPreparedSnapshot(artifacts: PreparedReviewArtifacts): Promise<boolean> {
  try {
    await Promise.all([
      access(artifacts.contextPath),
      access(artifacts.reviewInputPath),
      access(artifacts.debugPath),
    ]);
    return true;
  } catch {
    return false;
  }
}
