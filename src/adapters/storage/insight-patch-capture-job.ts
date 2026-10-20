import { resolve } from "node:path";
import {
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "#src/domain/ids";
import {
  patchCaptureFailure,
  type InsightPatchCaptureInput,
  type InsightPatchCaptureResult,
} from "./insight-artifact-job-protocol";
import { InsightCaptureSourceFile } from "./insight-capture-source-file";
import { InsightArtifactStore } from "./insight-artifact-store";
import { PatchdeskPaths } from "./patchdesk-paths";
import { readBoundedInsightArtifactFile } from "./insight-artifact-files";
import { verifyInsightStreamTextRoot } from "./insight-stream-root-reader";

/** Physical worker operation, also used by the existing in-process resource seam; never publishes a result. */
export async function captureInsightPatch(
  input: InsightPatchCaptureInput,
  options: { readonly signal?: AbortSignal } = {},
): Promise<InsightPatchCaptureResult> {
  const profile = parseWorkspaceProfileId(input.profileId);
  const review = parseReviewId(input.reviewId);
  const session = parseReviewSessionId(input.sessionId);
  if (profile._tag === "err" || review._tag === "err" || session._tag === "err")
    return patchCaptureFailure("invalid_source");
  const paths = PatchdeskPaths.fromEnvironment({
    PATCHDESK_CONFIG_DIRECTORY: input.destinationRoot,
    PATCHDESK_DATA_DIRECTORY: input.destinationRoot,
    PATCHDESK_CACHE_DIRECTORY: input.destinationRoot,
  });
  const sourcePaths = PatchdeskPaths.fromEnvironment({
    PATCHDESK_CONFIG_DIRECTORY: input.sourceRoot,
    PATCHDESK_DATA_DIRECTORY: input.sourceRoot,
    PATCHDESK_CACHE_DIRECTORY: input.sourceRoot,
  });
  if (
    resolve(sourcePaths.patchFile(profile.value, session.value)) !==
    resolve(input.sourcePath)
  )
    return patchCaptureFailure("invalid_source");
  if (
    resolve(paths.reviewDirectory(profile.value, review.value)) !==
    resolve(input.destinationReview)
  )
    return patchCaptureFailure("invalid_source");
  const source = await InsightCaptureSourceFile.capture(input, options);
  if (source._tag === "err") return source;
  let result: InsightPatchCaptureResult;
  try {
    const artifacts = new InsightArtifactStore(
      paths,
      readBoundedInsightArtifactFile,
    );
    const written = await artifacts.writeSnapshotTextRoot(
      profile.value,
      review.value,
      source.value,
      options,
    );
    if (options.signal?.aborted) result = patchCaptureFailure("aborted");
    else if (written._tag === "err")
      result = patchCaptureFailure(
        written.error.reason === "sensitive_value" ? "sensitive_value" : "io",
      );
    else if (
      written.value.data.sha256 !== input.expectedHash ||
      written.value.data.bytes !== source.value.bytes ||
      written.value.utf16Units !== source.value.utf16Units
    )
      result = patchCaptureFailure("invalid_source");
    else {
      const checked = await verifyInsightStreamTextRoot(
        async (reference) => {
          const path = paths.insightArtifactObjectFile(
            profile.value,
            review.value,
            reference.hash,
          );
          return path._tag === "err"
            ? {
                _tag: "err",
                error: {
                  _tag: "StorageFailure",
                  operation: "read",
                  reason: "invalid_stored_value",
                },
              }
            : readBoundedInsightArtifactFile(paths.dataDirectory(), path.value);
        },
        written.value,
        options,
      );
      result = options.signal?.aborted
        ? patchCaptureFailure("aborted")
        : checked._tag === "err"
          ? patchCaptureFailure("io")
          : written;
    }
  } catch {
    result = patchCaptureFailure(options.signal?.aborted ? "aborted" : "io");
  }
  const closed = await source.value.close();
  return closed._tag === "err" ? closed : result;
}
