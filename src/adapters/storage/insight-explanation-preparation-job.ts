import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import * as v from "valibot";

import {
  GUIDE_MAX_PATCH_BYTES,
  guideContextInputSchema,
  guidePreparedInputCodec,
  type GuideContextInput,
  type GuidePreparedInput,
  type GuidePreparationFailureReason,
} from "#src/domain/guide-preparation";
import { definedProps } from "#src/domain/defined-props";
import { buildGuideInventory } from "#src/domain/guide";
import { parseNarrativePatch } from "#src/domain/narrative-patch";
import { walkthroughPreparedInputCodec } from "#src/domain/walkthrough-preparation";
import {
  parseContentHash,
  parseGitSha,
  parseInsightRunId,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "#src/domain/ids";
import type { InsightEvidenceIdentity } from "#src/domain/insight-evidence";
import {
  insightBindingCodec,
  insightDomainIdentityCodec,
} from "#src/domain/insight-run-binding-contract";
import {
  encodeInsightArtifactCanonicalJson,
  insightArtifactHashSchema,
  type InsightArtifactReference,
  type InsightTextRootDescriptor,
} from "#src/domain/insight-artifact-scalars";
import { ok } from "#src/domain/result";
import { buildInsightEvidenceBundle } from "#src/services/insight-evidence-builder";
import {
  changedPatchFiles,
  renderReviewContext,
} from "#src/services/review-context-service";
import {
  guidePreparationFailure,
  type GuidePreparationInput,
  type GuidePreparationResult,
} from "./insight-artifact-job-protocol";
import { readBoundedInsightArtifactFile } from "./insight-artifact-files";
import { InsightArtifactStore } from "./insight-artifact-store";
import { InsightCaptureSourceFile } from "./insight-capture-source-file";
import { InsightEvidenceStore } from "./insight-evidence-store";
import { PatchdeskPaths } from "./patchdesk-paths";
import { isPathContained } from "./path-containment";
import { verifyInsightStreamTextRoot } from "./insight-stream-root-reader";
import { captureWalkthroughHunks } from "./walkthrough-hunk-capture";

// The host-staged context is read in blocks of this size.
const CONTEXT_READ_BLOCK_BYTES = 1024 * 1024;

type Options = { readonly signal?: AbortSignal };

/**
 * Worker operation: captures the stable patch snapshot, builds the complete inventory, the run-owned context and the
 * evidence pages in this thread, stores them in the destination scope, verifies everything it stored and returns only
 * the selected prepared root. It never publishes a result, calls a provider or touches the source Review.
 */
export async function prepareExplanationInputs(
  type: "guide" | "walkthrough",
  input: GuidePreparationInput,
  options: Options = {},
): Promise<GuidePreparationResult> {
  const profile = parseWorkspaceProfileId(input.profileId);
  const review = parseReviewId(input.reviewId);
  const session = parseReviewSessionId(input.sessionId);
  const runId = parseInsightRunId(input.runId);
  const headSha = parseGitSha(input.headSha);
  const baseSha = parseGitSha(input.baseSha);
  const patchHash = parseContentHash(input.expectedHash);
  if (
    profile._tag === "err" ||
    review._tag === "err" ||
    session._tag === "err" ||
    runId._tag === "err" ||
    headSha._tag === "err" ||
    baseSha._tag === "err" ||
    patchHash._tag === "err"
  )
    return guidePreparationFailure("invalid_source");
  const destination = PatchdeskPaths.fromEnvironment({
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
      resolve(input.sourcePath) ||
    resolve(destination.reviewDirectory(profile.value, review.value)) !==
      resolve(input.destinationReview) ||
    !isPathContained(input.destinationReview, input.contextPath)
  )
    return guidePreparationFailure("invalid_source");
  const source = await InsightCaptureSourceFile.capture(input, {
    ...options,
    maxBytes: GUIDE_MAX_PATCH_BYTES,
  });
  if (source._tag === "err")
    return guidePreparationFailure(source.error.reason);
  let result: GuidePreparationResult;
  try {
    const store = new InsightArtifactStore(
      destination,
      readBoundedInsightArtifactFile,
    );
    const stored = new StoredInputs(
      store,
      destination,
      profile.value,
      review.value,
      type,
      options,
    );
    result = await stored.prepare(source.value, input, {
      profileId: profile.value,
      reviewId: review.value,
      sessionId: session.value,
      runId: runId.value,
      type,
      headSha: headSha.value,
      baseSha: baseSha.value,
      patchHash: patchHash.value,
      intentHash: null,
    });
  } catch {
    result = guidePreparationFailure(
      options.signal?.aborted ? "aborted" : "io",
    );
  }
  const closed = await source.value.close();
  return closed._tag === "err"
    ? guidePreparationFailure(closed.error.reason)
    : result;
}

class StoredInputs {
  constructor(
    private readonly store: InsightArtifactStore,
    private readonly destination: PatchdeskPaths,
    private readonly profile: InsightEvidenceIdentity["profileId"],
    private readonly review: InsightEvidenceIdentity["reviewId"],
    private readonly type: "guide" | "walkthrough",
    private readonly options: Options,
  ) {}

  async prepare(
    snapshot: InsightCaptureSourceFile,
    input: GuidePreparationInput,
    identity: InsightEvidenceIdentity,
  ): Promise<GuidePreparationResult> {
    const binding = await this.store.readObject(
      this.profile,
      this.review,
      insightBindingCodec,
      input.binding,
    );
    if (
      binding._tag === "err" ||
      binding.value.kind !== this.type ||
      binding.value.patchHash !== input.expectedHash ||
      binding.value.headSha !== input.headSha ||
      binding.value.baseSha !== input.baseSha
    )
      return guidePreparationFailure("invalid_source");
    const boundIdentity = await this.store.readObject(
      this.profile,
      this.review,
      insightDomainIdentityCodec,
      binding.value.identity,
    );
    if (boundIdentity._tag === "err")
      return guidePreparationFailure("invalid_source");
    for (const [root, expected] of [
      [boundIdentity.value.profileId, input.profileId],
      [boundIdentity.value.reviewId, input.reviewId],
      [boundIdentity.value.sessionId, input.sessionId],
      [boundIdentity.value.runId, input.runId],
    ] as const) {
      if (
        (
          await this.store.verifyTextRootEquals(
            this.profile,
            this.review,
            root,
            expected,
          )
        )._tag === "err"
      )
        return guidePreparationFailure("invalid_source");
    }
    const patchRoot = await this.store.writeSnapshotTextRoot(
      this.profile,
      this.review,
      snapshot,
      this.options,
    );
    if (patchRoot._tag === "err")
      return this.stopped(
        patchRoot.error.reason === "sensitive_value" ? "sensitive_value" : "io",
      );
    if (
      patchRoot.value.data.sha256 !== input.expectedHash ||
      patchRoot.value.data.bytes !== snapshot.bytes ||
      patchRoot.value.utf16Units !== snapshot.utf16Units
    )
      return guidePreparationFailure("invalid_source");
    if (!(await this.verifiedStructure(patchRoot.value)))
      return this.stopped("io");
    const patch = await snapshot.readAll();
    if (patch._tag === "err") return this.stopped("io");
    // Inventory, context rendering and the bundle build are synchronous CPU; an abort is seen at these checks and after.
    if (this.options.signal?.aborted) return this.stopped("io");
    const inventory = buildGuideInventory(patch.value);
    if (inventory._tag === "err")
      return guidePreparationFailure("not_indexable");
    const inventoryText = JSON.stringify(inventory.value);
    const narrative =
      this.type === "walkthrough"
        ? parseNarrativePatch(patch.value)
        : undefined;
    if (narrative?._tag === "err")
      return guidePreparationFailure("not_indexable");
    const hunks =
      narrative === undefined
        ? undefined
        : await captureWalkthroughHunks(
            this.store,
            { profileId: this.profile, reviewId: this.review },
            narrative.value,
            inventory.value,
            this.options,
          );
    if (hunks?._tag === "err") return this.stopped(hunks.error);
    const inventoryRoot = await this.textRoot(inventoryText);
    if (inventoryRoot._tag === "err") return inventoryRoot;
    const staged = await this.readContextInput(input);
    if (staged._tag === "err") return staged;
    if (this.options.signal?.aborted) return this.stopped("io");
    const context = renderReviewContext(
      staged.value,
      changedPatchFiles(patch.value),
      { path: input.sourcePath, sha256: input.expectedHash },
      "none",
    );
    if (context === undefined) return guidePreparationFailure("too_large");
    const contextRoot = await this.textRoot(context.text);
    if (contextRoot._tag === "err") return contextRoot;
    if (this.options.signal?.aborted) return this.stopped("io");
    const bundle = buildInsightEvidenceBundle({
      identity,
      patch: patch.value,
      context: context.text,
      reviewInput: "",
      snapshots: {},
      directory: this.destination.insightEvidenceDirectory(
        identity.profileId,
        identity.sessionId,
        identity.runId,
      ),
      inventory: inventory.value,
      ...definedProps({ narrativeHunks: narrative?.value.hunks }),
    });
    if (bundle._tag === "err") return guidePreparationFailure("invalid_source");
    const evidence = new InsightEvidenceStore(this.destination);
    if (this.options.signal?.aborted) return this.stopped("io");
    if ((await evidence.publish(bundle.value, this.options))._tag === "err")
      return this.stopped("io");
    const manifestRoot = await this.textRoot(bundle.value.manifestText);
    if (manifestRoot._tag === "err") return manifestRoot;
    if (bundle.value.tree !== undefined)
      return guidePreparationFailure("invalid_source");
    const entryRoot = await this.textRoot(bundle.value.entryPageId);
    if (entryRoot._tag === "err") return entryRoot;
    const bundleId = v.safeParse(
      insightArtifactHashSchema,
      bundle.value.bundleId,
    );
    if (!bundleId.success) return guidePreparationFailure("invalid_source");
    const prepared: GuidePreparedInput = {
      binding: input.binding,
      patch: patchRoot.value,
      inventory: inventoryRoot.value,
      context: contextRoot.value,
      evidenceManifest: manifestRoot.value,
      evidenceBundleId: bundleId.output,
      entryPageId: entryRoot.value,
      contextCompleteness: {
        knownOmittedChecks: context.truncated.checks,
        knownOmittedThreads: context.truncated.threads,
        knownOmittedRules: context.truncated.rules,
        upstreamCompleteness: staged.value.upstream,
      },
    };
    const codec =
      this.type === "guide"
        ? guidePreparedInputCodec
        : walkthroughPreparedInputCodec;
    const preparedValue =
      hunks === undefined ? prepared : { ...prepared, hunks: hunks.value };
    const written = await this.store.writeObject(
      this.profile,
      this.review,
      codec,
      preparedValue,
    );
    if (written._tag === "err") return this.stopped("io");
    // Final pass reads everything back from storage: the stored root, each text root it names, and every evidence file.
    const readBack = await this.store.readObject(
      this.profile,
      this.review,
      codec,
      written.value,
    );
    if (
      readBack._tag === "err" ||
      encodeInsightArtifactCanonicalJson(readBack.value) !==
        encodeInsightArtifactCanonicalJson(preparedValue)
    )
      return this.stopped("io");
    for (const root of [
      readBack.value.patch,
      readBack.value.inventory,
      readBack.value.context,
      readBack.value.evidenceManifest,
      readBack.value.entryPageId,
    ])
      if (!(await this.verifiedStructure(root))) return this.stopped("io");
    if ((await evidence.validate(bundle.value, this.options))._tag === "err")
      return this.stopped("io");
    if (this.options.signal?.aborted) return guidePreparationFailure("aborted");
    return ok({
      root: written.value,
      counts: {
        patchBytes: snapshot.bytes,
        inventoryFiles: inventory.value.length,
        contextBytes: Buffer.byteLength(context.text),
        evidenceSources: bundle.value.sources.length,
        evidencePages: bundle.value.pages.length,
      },
    });
  }

  private stopped(reason: GuidePreparationFailureReason) {
    return guidePreparationFailure(
      this.options.signal?.aborted ? "aborted" : reason,
    );
  }

  /** Stores text as a TextRoot and checks the stored bytes equal it. */
  private async textRoot(text: string) {
    const root = await this.store.writeTextRoot(
      this.profile,
      this.review,
      text,
      this.options,
    );
    if (root._tag === "err")
      return this.stopped(
        root.error.reason === "sensitive_value" ? "sensitive_value" : "io",
      );
    // Every stored block and index edge is read back and hashed, so matching the text's own digest proves equality.
    return root.value.data.bytes === Buffer.byteLength(text) &&
      root.value.utf16Units === text.length &&
      root.value.data.sha256 ===
        createHash("sha256").update(text).digest("hex") &&
      (await this.verifiedStructure(root.value))
      ? root
      : this.stopped("io");
  }

  private async verifiedStructure(
    root: InsightTextRootDescriptor,
  ): Promise<boolean> {
    const checked = await verifyInsightStreamTextRoot(
      async (reference: InsightArtifactReference) => {
        const path = this.destination.insightArtifactObjectFile(
          this.profile,
          this.review,
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
          : readBoundedInsightArtifactFile(
              this.destination.dataDirectory(),
              path.value,
            );
      },
      root,
      this.options,
    );
    return checked._tag === "ok";
  }

  /** Reads the host-staged file once through a no-follow descriptor and checks its recorded size and digest. */
  private async readContextInput(input: GuidePreparationInput) {
    try {
      const file = await open(
        input.contextPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        // The declared size is the only bound: no content ceiling is invented here, and a larger file fails honestly.
        if (
          !stat.isFile() ||
          stat.uid !== process.geteuid?.() ||
          stat.size !== input.contextBytes
        )
          return guidePreparationFailure("invalid_source");
        let bytes: Buffer;
        try {
          bytes = Buffer.alloc(input.contextBytes);
        } catch {
          return guidePreparationFailure("too_large");
        }
        for (let filled = 0; filled < bytes.length;) {
          if (this.options.signal?.aborted) return this.stopped("io");
          const read = await file.read(
            bytes,
            filled,
            Math.min(CONTEXT_READ_BLOCK_BYTES, bytes.length - filled),
            filled,
          );
          // A file that ends early was truncated after the host staged it.
          if (read.bytesRead === 0)
            return guidePreparationFailure("stale_source");
          filled += read.bytesRead;
        }
        // One probe past the declared size detects a file that grew while it was read.
        const probe = await file.read(Buffer.alloc(1), 0, 1, bytes.length);
        if (
          probe.bytesRead > 0 ||
          (await file.stat()).size !== input.contextBytes ||
          createHash("sha256").update(bytes).digest("hex") !== input.contextHash
        )
          return guidePreparationFailure("stale_source");
        const parsed = v.safeParse(
          guideContextInputSchema,
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
        return parsed.success
          ? ok(materialOf(parsed.output))
          : guidePreparationFailure("invalid_source");
      } finally {
        await file.close().catch(() => undefined);
      }
    } catch (cause: unknown) {
      // A string or buffer too large for the runtime is resource exhaustion, not a malformed file.
      return guidePreparationFailure(
        cause instanceof RangeError ? "too_large" : "invalid_source",
      );
    }
  }
}

function materialOf(context: GuideContextInput) {
  return {
    ...definedProps({ comments: context.comments, checks: context.checks }),
    pr: context.pr,
    criteria: context.criteria,
    packageSummary: context.packageSummary,
    omitted: context.omitted,
    upstream: context.upstreamCompleteness,
  };
}
