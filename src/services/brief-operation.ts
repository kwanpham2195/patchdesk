import { MAX_REACH_SYMBOLS } from "#src/domain/brief";
import { briefMoves, renderBriefPatchFacts } from "#src/domain/brief-moves";
import { insightOutputGuidance } from "#src/domain/insight-output-guidance";
import { moveReferenceUpdatePaths } from "#src/domain/move-reference-updates";
import type { InsightLanguage } from "#src/domain/insight-provider";
import { listPatchChangedFiles } from "#src/domain/patch-changed-files";
import { err, ok, type Result } from "#src/domain/result";
import { readBoundedArtifact } from "./walkthrough-artifact-reader";
import {
  evidenceReferencePrompt,
  type InsightEvidenceReference,
} from "./insight-evidence-reference";

const MAX_BRIEF_PATCH_BYTES = 64 * 1024 * 1024;

/** Why a Brief prompt could not be composed from its patch artifact. */
export type BriefPromptFailure =
  | { readonly reason: "patch_too_large" }
  | { readonly reason: "patch_unreadable" };

/** Counts deterministic facts from the bounded canonical patch; model evidence stays in captured pages. */
export async function prepareBriefPrompt(input: {
  readonly patchPath: string;
  readonly language: InsightLanguage;
  readonly evidence: InsightEvidenceReference;
}): Promise<Result<string, BriefPromptFailure>> {
  const patch = await readBoundedArtifact(
    input.patchPath,
    MAX_BRIEF_PATCH_BYTES,
  );
  if (patch._tag === "err")
    return err({
      reason:
        patch.error.reason === "input_too_large"
          ? "patch_too_large"
          : "patch_unreadable",
    });
  const changedFiles = listPatchChangedFiles(patch.value);
  return ok(
    [
      "Write a read-only Brief for the supplied immutable patch.",
      insightOutputGuidance("brief", input.language),
      "Every citation in flow must be an h alias from the captured citation pages; a citation that does not resolve is discarded.",
      `List in reachSymbols up to ${MAX_REACH_SYMBOLS} exported functions, types, or constants whose signature or meaning this patch changes. Write the exact identifier names, as spelled in the patch, and nothing else: no counts, no paths, no prose. Prefer names that callers outside the changed files use -- a helper whose behavior changed and that other files call matters more than a new constant only the patch references. Patchdesk counts their callers itself.`,
      "PATCH FACTS, counted by Patchdesk:",
      renderBriefPatchFacts(
        changedFiles,
        briefMoves(
          changedFiles,
          moveReferenceUpdatePaths(patch.value, changedFiles).length,
        ),
      ),
      evidenceReferencePrompt(input.evidence),
    ].join("\n\n"),
  );
}
