import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ReviewAttemptId, ReviewSessionId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";

export type PreparedAttemptArtifacts = {
  readonly contextPath: string;
  readonly reviewInputPath: string;
  readonly debugPath: string;
};

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

/** Copies the immutable prepared snapshot into the newly allocated attempt directory. */
export async function prepareAllocatedAttemptArtifacts(input: {
  readonly paths: PatchdeskPaths;
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly attemptId: ReviewAttemptId;
  readonly sourceAttemptId: ReviewAttemptId;
}): Promise<Result<PreparedAttemptArtifacts, { readonly _tag: "PreparedArtifactsUnavailable" }>> {
  const target = preparedAttemptArtifacts(input.paths, input.profileId, input.sessionId, input.attemptId);
  if (input.attemptId === input.sourceAttemptId) return ok(target);
  const source = preparedAttemptArtifacts(input.paths, input.profileId, input.sessionId, input.sourceAttemptId);
  try {
    await mkdir(dirname(target.contextPath), { recursive: true });
    await Promise.all([
      copyFile(source.contextPath, target.contextPath),
      copyFile(source.reviewInputPath, target.reviewInputPath),
    ]);
    return ok(target);
  } catch {
    return err({ _tag: "PreparedArtifactsUnavailable" });
  }
}
