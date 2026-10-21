import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";

import { GuideResultStore } from "#src/adapters/storage/guide-result-store";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type {
  GuidePreparationFailureReason,
  GuidePreparedInput,
} from "#src/domain/guide-preparation";
import { parseInsightRunId, type ReviewSessionId } from "#src/domain/ids";
import type { InsightFailureRecord } from "#src/domain/insight-run-binding-contract";
import { mapConcurrent } from "#src/domain/map-concurrent";
import {
  insightEvidenceReferenceSchema,
  type InsightEvidenceReference,
} from "./insight-evidence-reference";
import type { AdmittedRun } from "./guide-preparation-service";

/** The stored evidence manifest is small JSON; a larger one is corrupt. */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/** Projects the stored evidence manifest onto the reference the child verifies file by file. */
export async function guideEvidenceReference(
  artifacts: InsightArtifactStore,
  destination: PatchdeskPaths,
  prepared: GuidePreparedInput,
  sessionId: ReviewSessionId,
  run: Pick<AdmittedRun, "profileId" | "reviewId" | "runId">,
): Promise<InsightEvidenceReference | undefined> {
  const manifest = await new GuideResultStore(
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
    return reference.success ? reference.output : undefined;
  } catch {
    return undefined;
  }
}

/** Maps a preparation failure to the FailureRecord code that settles its run. */
export function guideSettleCode(
  reason: GuidePreparationFailureReason,
): InsightFailureRecord["code"] {
  switch (reason) {
    case "aborted":
      return "cancelled";
    case "stale_source":
      return "evidence_changed";
    case "too_large":
      return "resource_exhausted";
    case "invalid_source":
    case "not_indexable":
    case "sensitive_value":
    case "context_unavailable":
      return "evidence_missing";
    default:
      return "storage_unavailable";
  }
}

/** How a refused Guide admission reads in the coordinator's failure vocabulary. */
export function guideStartFailure(
  reason: GuidePreparationFailureReason,
): "already_running" | "stale_request" | "not_found" | "storage_unavailable" {
  switch (reason) {
    case "busy":
      return "already_running";
    case "stale_source":
      return "stale_request";
    case "invalid_source":
      return "not_found";
    default:
      return "storage_unavailable";
  }
}
