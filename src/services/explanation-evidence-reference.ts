import * as v from "valibot";

import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import {
  parseInsightRunId,
  type ReviewSessionId,
  type ReviewId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import type { InsightTextRootDescriptor } from "#src/domain/insight-artifact-scalars";
import {
  insightEvidenceReferenceSchema,
  type InsightEvidenceReference,
} from "./insight-evidence-reference";

/** The stored evidence manifest is small JSON; a larger one is corrupt. */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/** Projects the stored evidence manifest onto the reference the child verifies file by file. */
export async function explanationEvidenceReference(
  artifacts: InsightArtifactStore,
  destination: PatchdeskPaths,
  prepared: { readonly evidenceManifest: InsightTextRootDescriptor },
  sessionId: ReviewSessionId,
  run: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly runId: string;
  },
): Promise<InsightEvidenceReference | undefined> {
  const manifest = await new InsightResultStore(
    artifacts,
    run.profileId,
    run.reviewId,
  ).readText(prepared.evidenceManifest, MAX_MANIFEST_BYTES);
  const runId = parseInsightRunId(run.runId);
  if (manifest._tag === "err" || runId._tag === "err") return undefined;
  try {
    const parsed = v.parse(
      v.looseObject({
        identity: v.unknown(),
        bundleId: v.string(),
        ...insightEvidenceReferenceSchema.entries.tree.entries,
      }),
      JSON.parse(manifest.value),
    );
    const directory = destination.analysisEvidenceDirectory(
      run.profileId,
      sessionId,
      runId.value,
    );
    const files = [
      ...parsed.files,
      {
        name: "manifest.json",
        sha256: prepared.evidenceManifest.data.sha256,
        bytes: prepared.evidenceManifest.data.bytes,
      },
    ];
    const reference = v.safeParse(insightEvidenceReferenceSchema, {
      identity: parsed.identity,
      bundleId: parsed.bundleId,
      directory,
      sources: files.map((file, index) => ({ ...file, id: `s${index + 1}` })),
      tree: {
        format: parsed.format,
        directories: parsed.directories,
        files,
        diffs: parsed.diffs,
        snapshots: parsed.snapshots,
      },
      manifest: {
        sha256: prepared.evidenceManifest.data.sha256,
        bytes: prepared.evidenceManifest.data.bytes,
      },
    });
    return reference.success ? reference.output : undefined;
  } catch {
    return undefined;
  }
}
