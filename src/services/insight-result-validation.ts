import { hashReviewArtifactContent } from "./review-artifact-hash";
import { retainGuide } from "#src/domain/guide";
import { readFile } from "node:fs/promises";

import {
  briefManifest,
  normalizeBrief,
  parseBriefOutput,
  type BriefError,
  type NormalizedBrief,
} from "#src/domain/brief";
import {
  containsFenceLine,
  isAcceptableSuggestionCode,
  resolveSuggestionTarget,
} from "#src/domain/finding-suggestion";
import type { InsightRevision, InsightType } from "#src/domain/insight-record";
import type { RawJsonValue } from "#src/domain/json";
import {
  mapFindingLocation,
  parseUnifiedPatch,
  type FindingLocation,
  type FindingLocationInput,
} from "#src/domain/patch";
import { err, ok, type Result } from "#src/domain/result";
import {
  parseModelReviewResult,
  parseReviewResult,
  type FindingSuggestedReplacement,
} from "#src/domain/review-result";
import type { BriefReachComputer } from "./brief-reach-service";
import type { InsightInvocationInput } from "./insight-run-coordinator";

/** Bounded validateResult rejection reason, surfaced only in the diagnostic detail. */
export type ValidateResultReason = "invalid_result" | BriefError["reason"];

export async function validateInsightResult(
  type: InsightType,
  value: RawJsonValue,
  input: InsightInvocationInput,
  revision: InsightRevision,
  /**
   * Counts the Brief's Reach block. Absent wherever no worktree search is
   * wired (every non-Brief type, and the tests that do not exercise it); the
   * Brief is then retained with neither `reach` nor `reachUnavailable`.
   */
  reach?: BriefReachComputer,
): Promise<Result<unknown, ValidateResultReason>> {
  if (type === "walkthrough") return err("invalid_result");
  if (type === "guide") {
    if (input.guide === undefined) return err("invalid_result");
    const guide = retainGuide(value, input.guide);
    return guide._tag === "ok" ? guide : err("invalid_result");
  }
  const tree = input.evidence?.tree;
  const diffTexts = tree?.diffs.map(
    (name) =>
      input.evidence?.sources.find((source) => source.name === name)?.text,
  );
  if (diffTexts?.some((text) => text === undefined))
    return err("invalid_result");
  const patch =
    tree === undefined
      ? await readFile(input.patchPath, "utf8").catch(() => undefined)
      : diffTexts?.join("");
  if (
    patch === undefined ||
    (tree !== undefined &&
      hashReviewArtifactContent(patch) !== revision.patchHash)
  )
    return err("invalid_result");
  if (type === "analysis") {
    const model = parseModelReviewResult(value);
    if (model._tag === "err") return err("invalid_result");
    const files = parseUnifiedPatch(patch);
    // parseReviewResult's parameter is `unknown`; its valibot schema uses `v.optional()` for
    // every field below, which treats a present-but-undefined key identically to an absent one
    // (verified: both parse to the same omitted-key output), so passing the value directly here
    // cannot change the persisted shape that parseReviewResult itself reconstructs.
    const mapped = parseReviewResult({
      changeSummary: model.value.changeSummary,
      verdict: model.value.verdict,
      summary: model.value.summary,
      validationPlan: model.value.validationPlan,
      assumptions: model.value.assumptions,
      coverage: model.value.coverage,
      overallConfidence: model.value.overallConfidence,
      unresolvedItems: model.value.unresolvedItems,
      callouts: model.value.callouts,
      // An unmapped finding keeps the location the model reported, so each
      // mapped field replaces the model's own value only when it exists.
      findings: model.value.findings.map((finding) => {
        const location = mapFindingLocation(files, finding);
        const withStatus = {
          ...finding,
          mappingStatus: location.mappingStatus,
        };
        const withFile =
          location.path === undefined
            ? withStatus
            : { ...withStatus, file: location.path };
        const withSide =
          location.side === undefined
            ? withFile
            : { ...withFile, diffSide: location.side };
        const withStart =
          location.line === undefined
            ? withSide
            : {
                ...withSide,
                lineStart: location.startLine ?? location.line,
              };
        const withRange =
          location.startLine === undefined
            ? withStart
            : { ...withStart, lineEnd: location.line };
        return hasVerifiedSuggestion(finding, location, patch)
          ? withRange
          : withoutSuggestedReplacement(withRange);
      }),
    });
    return mapped._tag === "ok" ? mapped : err("invalid_result");
  }
  if (type === "brief") {
    const normalizedBrief = normalizeBrief(
      value,
      briefManifest({ patch }),
      patch,
      {
        profileId: input.profileId,
        sessionId: revision.sessionId,
        headSha: revision.headSha,
        patchHash: revision.patchHash,
      },
    );
    if (normalizedBrief._tag === "err")
      return err(normalizedBrief.error.reason);
    return ok(
      await withBriefReach(
        normalizedBrief.value,
        value,
        patch,
        input,
        revision,
        reach,
      ),
    );
  }
  return err("invalid_result");
}

/**
 * Whether the model's replacement code can stand for the Finding's cited lines
 * in the represented patch. Patchdesk verifies the range against the patch it
 * owns, so neither the model's own original code nor anything the renderer
 * sends decides what a suggestion replaces.
 */
function hasVerifiedSuggestion(
  finding: FindingLocationInput & {
    readonly explanation: string;
    readonly suggestedComment?: string;
    readonly suggestedReplacement?: FindingSuggestedReplacement;
  },
  location: FindingLocation,
  patch: string,
): boolean {
  const replacement = finding.suggestedReplacement;
  if (replacement === undefined) return false;
  if (location.mappingStatus !== "mapped" || location.side !== "new")
    return false;
  if (!isAcceptableSuggestionCode(replacement.code)) return false;
  // The prose sits above the suggestion block in the same comment, so a fence
  // in it closes that block just as one inside the code would.
  if (containsFenceLine(finding.suggestedComment ?? finding.explanation))
    return false;
  return resolveSuggestionTarget(patch, finding) !== undefined;
}

/** Drops only the suggestion, so invalid replacement data never discards a valid Finding. */
function withoutSuggestedReplacement<
  T extends { readonly suggestedReplacement?: FindingSuggestedReplacement },
>(finding: T): Omit<T, "suggestedReplacement"> {
  const { suggestedReplacement: _dropped, ...rest } = finding;
  return rest;
}

/**
 * Attaches the Reach block to a Brief that already normalized.
 *
 * The child's `reachSymbols` are proposals; `computeBriefReach` filters them
 * against the patch and head files and makes every count. A search that
 * cannot answer is recorded as `reachUnavailable` rather than failing the run:
 * a Brief without Reach is still a Brief, and the reader says so in one line.
 */
async function withBriefReach(
  brief: NormalizedBrief,
  raw: RawJsonValue,
  patch: string,
  input: InsightInvocationInput,
  revision: InsightRevision,
  reach: BriefReachComputer | undefined,
): Promise<NormalizedBrief> {
  if (reach === undefined) return brief;
  const parsed = parseBriefOutput(raw);
  const proposed =
    parsed._tag === "ok" ? (parsed.value.reachSymbols ?? []) : [];
  const outcome = await reach({
    profileId: input.profileId,
    sessionId: input.sessionId,
    worktree: input.worktreePath,
    headSha: revision.headSha,
    patch,
    proposed,
  });
  return outcome._tag === "ok"
    ? { ...brief, reach: outcome.value }
    : { ...brief, reachUnavailable: outcome.reason };
}
