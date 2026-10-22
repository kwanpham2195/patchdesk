import { readdir } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";

import type { GuidePreparedInput } from "#src/domain/guide-preparation";
import { insightArtifactIdSchema } from "#src/domain/insight-artifact-scalars";
import {
  parseReviewSessionId,
  type ReviewId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import {
  insightBindingCodec,
  insightDomainIdentityCodec,
} from "#src/domain/insight-run-binding-contract";
import { explanationEvidenceReference } from "#src/services/explanation-evidence-reference";
import { InsightResultStore } from "./insight-result-store";
import type { InsightArtifactStore } from "./insight-artifact-store";
import {
  evidencePathIsOwned,
  validateEvidenceFile,
} from "./insight-evidence-validation";
import { verifyInsightStreamTextRoot } from "./insight-stream-root-reader";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** Rechecks captured dependencies after generation without loading the patch, context or evidence files into memory. */
export async function validateExplanationPreparedEvidence(
  artifacts: InsightArtifactStore,
  paths: PatchdeskPaths,
  run: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly runId: string;
  },
  prepared: GuidePreparedInput,
  options: { readonly signal?: AbortSignal },
  kind: "guide" | "walkthrough",
): Promise<boolean> {
  const { profileId, reviewId } = run;
  for (const root of [
    prepared.patch,
    prepared.inventory,
    prepared.context,
    prepared.evidenceManifest,
    prepared.entryPageId,
  ]) {
    const verified = await verifyInsightStreamTextRoot(
      (reference) => artifacts.readBlob(profileId, reviewId, reference),
      root,
      options,
    );
    if (verified._tag === "err") return false;
  }
  const binding = await artifacts.readObject(
    profileId,
    reviewId,
    insightBindingCodec,
    prepared.binding,
  );
  if (
    binding._tag === "err" ||
    binding.value.kind !== kind ||
    binding.value.patchHash !== prepared.patch.data.sha256
  )
    return false;
  const identity = await artifacts.readObject(
    profileId,
    reviewId,
    insightDomainIdentityCodec,
    binding.value.identity,
  );
  if (identity._tag === "err") return false;
  for (const [root, expected] of [
    [identity.value.profileId, profileId],
    [identity.value.reviewId, reviewId],
    [identity.value.runId, run.runId],
  ] as const) {
    if (
      (
        await artifacts.verifyTextRootEquals(
          profileId,
          reviewId,
          root,
          expected,
        )
      )._tag === "err"
    )
      return false;
  }
  const store = new InsightResultStore(artifacts, profileId, reviewId);
  const sessionText = await store.readText(identity.value.sessionId, 1_024);
  if (sessionText._tag === "err") return false;
  const session = parseReviewSessionId(sessionText.value);
  const runId = v.safeParse(insightArtifactIdSchema, run.runId);
  if (session._tag === "err" || !runId.success) return false;
  const [reference, entry] = await Promise.all([
    explanationEvidenceReference(artifacts, paths, prepared, session.value, {
      ...run,
      runId: runId.output,
    }),
    store.readText(prepared.entryPageId, 1_024),
  ]);
  if (
    reference === undefined ||
    entry._tag === "err" ||
    reference.bundleId !== prepared.evidenceBundleId ||
    reference.entryPageId !== entry.value ||
    reference.identity.profileId !== profileId ||
    reference.identity.reviewId !== reviewId ||
    reference.identity.sessionId !== session.value ||
    reference.identity.runId !== run.runId ||
    reference.identity.type !== kind ||
    reference.identity.headSha !== binding.value.headSha ||
    reference.identity.baseSha !== binding.value.baseSha ||
    String(reference.identity.patchHash) !== binding.value.patchHash ||
    reference.identity.intentHash !== null ||
    !reference.pages.some((page) => page.id === reference.entryPageId) ||
    reference.pages.some(
      (page) => !page.id.startsWith(`${reference.bundleId}-p`),
    ) ||
    reference.sources[0]?.sha256 !== prepared.patch.data.sha256 ||
    reference.sources[0].bytes !== prepared.patch.data.bytes ||
    reference.sources[1]?.sha256 !== prepared.context.data.sha256 ||
    reference.sources[1].bytes !== prepared.context.data.bytes
  )
    return false;
  if (!(await evidencePathIsOwned(paths.dataDirectory(), reference.directory)))
    return false;
  const files = [
    { name: "manifest.json", ...reference.manifest },
    ...reference.pages.map((page) => ({
      name: `${page.id}.ndjson`,
      sha256: page.sha256,
      bytes: page.bytes,
    })),
    ...reference.sources,
  ];
  const names = await readdir(reference.directory);
  const expected = new Set(files.map((file) => file.name));
  if (
    expected.size !== files.length ||
    names.length !== expected.size ||
    names.some((name) => !expected.has(name))
  )
    return false;
  for (const file of files) {
    if (options.signal?.aborted) return false;
    const checked = await validateEvidenceFile({
      root: paths.dataDirectory(),
      path: join(reference.directory, file.name),
      sha256: file.sha256,
      bytes: file.bytes,
    });
    if (checked._tag === "err") return false;
  }
  return !options.signal?.aborted;
}
