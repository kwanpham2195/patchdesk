import {
  briefManifest,
  renderBriefManifest,
  BRIEF_RESULT_CONTRACT,
  type BriefEvidence,
} from "../domain/brief";
import { definedProps } from "../domain/defined-props";
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
  readonly evidence: BriefEvidence;
};

/**
 * Reads the bounded patch artifact and composes the only model-visible Brief
 * prompt. The alias manifest and the prose it is drawn from are both supplied:
 * the manifest is what a citation must name, and the untruncated description
 * and commit subjects are what the Brief is written from.
 */
export async function prepareBriefPrompt(input: {
  readonly profileId: string;
  readonly sessionId: string;
  readonly patchPath: string;
  readonly evidence: BriefEvidence;
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
  const manifest = briefManifest({
    patch: patch.value,
    ...definedProps({ description: input.evidence.description }),
    commits: input.evidence.commits,
  });
  return [
    "Write a read-only Brief for the supplied immutable patch.",
    insightOutputGuidance("brief"),
    `Return exactly one JSON object shaped ${BRIEF_RESULT_CONTRACT}. Use no other keys, no Markdown code fence, and no prose before or after it.`,
    "Every entry in a goal item's citations must be an alias from the supplied BRIEF CITATION MANIFEST. A goal sentence whose citations do not resolve is moved to assumptions, and a Brief whose every sentence is uncited is rejected.",
    "Put in reachSymbols only the exact identifier names, as written in the patch, whose callers a reviewer should check. Patchdesk counts them; do not count them yourself.",
    `Profile ${input.profileId} and session ${input.sessionId} are provenance only; do not repeat them in prose.`,
    "BRIEF CITATION MANIFEST:",
    renderBriefManifest(manifest),
    "PULL REQUEST DESCRIPTION:",
    input.evidence.description ?? "(none)",
    "COMMITS:",
    input.evidence.commits.length === 0
      ? "(none)"
      : input.evidence.commits
          .map((commit) => `${commit.sha.slice(0, 7)} ${commit.subject}`)
          .join("\n"),
    "PATCH ARTIFACT:",
    patch.value,
  ].join("\n\n");
}
