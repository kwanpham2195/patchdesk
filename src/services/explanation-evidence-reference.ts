import { stat } from "node:fs/promises";
import { join } from "node:path";
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
import { mapConcurrent } from "#src/domain/map-concurrent";
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
): Promise<
  | Extract<InsightEvidenceReference, { readonly entryPageId: string }>
  | undefined
> {
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
        entryPageId: v.string(),
        pages: v.array(v.strictObject({ id: v.string(), sha256: v.string() })),
        sources: v.array(
          v.strictObject({
            id: v.string(),
            name: v.string(),
            sha256: v.string(),
          }),
        ),
      }),
      JSON.parse(manifest.value),
    );
    const directory = destination.insightEvidenceDirectory(
      run.profileId,
      sessionId,
      runId.value,
    );
    const size = async (name: string): Promise<number> =>
      (await stat(join(directory, name))).size;
    const [pages, sources] = await Promise.all([
      mapConcurrent(parsed.pages, 8, async (page) => ({
        ...page,
        bytes: await size(`${page.id}.ndjson`),
      })),
      mapConcurrent(parsed.sources, 8, async (source) => ({
        ...source,
        bytes: await size(source.name),
      })),
    ]);
    const reference = v.safeParse(insightEvidenceReferenceSchema, {
      identity: parsed.identity,
      bundleId: parsed.bundleId,
      directory,
      entryPageId: parsed.entryPageId,
      pages,
      sources,
      manifest: {
        sha256: prepared.evidenceManifest.data.sha256,
        bytes: prepared.evidenceManifest.data.bytes,
      },
    });
    return reference.success && !("tree" in reference.output)
      ? reference.output
      : undefined;
  } catch {
    return undefined;
  }
}
