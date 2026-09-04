import {
  briefManifest,
  renderBriefManifest,
  BRIEF_RESULT_CONTRACT,
  MAX_REACH_SYMBOLS,
} from "../domain/brief";
import { insightOutputGuidance } from "../domain/insight-output-guidance";
import { readBoundedArtifact } from "./walkthrough-artifact-reader";

const MAX_BRIEF_PATCH_BYTES = 2 * 1024 * 1024;

/** Strict app-owned input for one finite Brief operation. */
export type BriefInput = {
  readonly profileId: string;
  readonly sessionId: string;
  readonly patchPath: string;
  readonly model: string;
  readonly reasoning: "low" | "medium" | "high";
};

/**
 * Reads the bounded patch artifact and composes the only model-visible Brief
 * prompt. Brief is structure-first (ADR 0040): the manifest built from the
 * patch is the only thing a citation can name, so this composes the manifest
 * and the patch alone -- there is no description or commit prose to hand the
 * model anymore.
 */
export async function prepareBriefPrompt(input: {
  readonly patchPath: string;
}): Promise<string> {
  const patch = await readBoundedArtifact(
    input.patchPath,
    MAX_BRIEF_PATCH_BYTES,
  );
  if (patch._tag === "err")
    throw new Error(
      patch.error.reason === "input_too_large"
        ? "Brief patch exceeds the bounded input size"
        : "Brief patch could not be read",
    );
  const manifest = briefManifest({ patch: patch.value });
  return [
    "Write a read-only Brief for the supplied immutable patch.",
    insightOutputGuidance("brief"),
    `Return exactly one JSON object shaped ${BRIEF_RESULT_CONTRACT}. Use no other keys, no Markdown code fence, and no prose before or after it.`,
    "Every citation in flow must be an h alias from the supplied BRIEF CITATION MANIFEST; a citation that does not resolve is discarded.",
    `List in reachSymbols up to ${MAX_REACH_SYMBOLS} exported functions, types, or constants whose signature or meaning this patch changes. Write the exact identifier names, as spelled in the patch, and nothing else: no counts, no paths, no prose. Prefer names that callers outside the changed files use -- a helper whose behavior changed and that other files call matters more than a new constant only the patch references. Patchdesk counts their callers itself.`,
    "BRIEF CITATION MANIFEST:",
    renderBriefManifest(manifest),
    "PATCH ARTIFACT:",
    patch.value,
  ].join("\n\n");
}
