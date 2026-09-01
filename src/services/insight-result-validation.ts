import { readFile } from "node:fs/promises";

import * as v from "valibot";

import {
  briefManifest,
  normalizeBrief,
  parseBriefOutput,
  type BriefError,
  type NormalizedBrief,
} from "../domain/brief";
import { candidateReachSymbols } from "../domain/brief-reach";
import type { InsightRevision, InsightType } from "../domain/insight-record";
import type { RawJsonValue } from "../domain/json";
import {
  normalizeNarrativeWalkthrough,
  type NarrativeWalkthroughError,
} from "../domain/narrative-walkthrough";
import { mapFindingLocation, parseUnifiedPatch } from "../domain/patch";
import { err, ok, type Result } from "../domain/result";
import {
  parseModelReviewResult,
  parseReviewResult,
} from "../domain/review-result";
import type { BriefReachComputer } from "./brief-reach-service";
import type { InsightInvocationInput } from "./insight-run-coordinator";

/** Bounded validateResult rejection reason, surfaced only in the diagnostic detail. */
export type ValidateResultReason =
  | "invalid_result"
  | NarrativeWalkthroughError["reason"]
  | BriefError["reason"];

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
  const patch = await readFile(input.patchPath, "utf8").catch(() => undefined);
  if (patch === undefined) return err("invalid_result");
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
        return location.startLine === undefined
          ? withStart
          : { ...withStart, lineEnd: location.line };
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
  // This result came from the current alias-manifest workflow. Persist its
  // marker even when a provider omits the requested constant JSON field.
  const normalized = normalizeNarrativeWalkthrough(
    currentWalkthroughOutput(value),
    patch,
    {
      profileId: input.profileId,
      sessionId: revision.sessionId,
      headSha: revision.headSha,
      patchHash: revision.patchHash,
    },
  );
  return normalized._tag === "ok" ? normalized : err(normalized.error.reason);
}

/**
 * Attaches the Reach block to a Brief that already normalized.
 *
 * The names come from the child's `reachSymbols`, filtered against the patch;
 * every count comes from `computeBriefReach`. A search that cannot answer is
 * recorded as `reachUnavailable` rather than failing the run: a Brief without
 * Reach is still a Brief, and the reader says so in one line.
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
    symbols: candidateReachSymbols(patch, proposed),
  });
  return outcome._tag === "ok"
    ? { ...brief, reach: outcome.value }
    : { ...brief, reachUnavailable: outcome.reason };
}

function currentWalkthroughOutput(value: RawJsonValue): RawJsonValue {
  if (Array.isArray(value)) return value;
  const record = v.safeParse(v.looseObject({}), value);
  if (!record.success) return value;
  // SAFETY: value is RawJsonValue and record.output holds the exact same own properties
  // (valibot's looseObject passes unknown keys through unchanged), so each property is itself
  // RawJsonValue by the JSON value grammar.
  return { ...record.output, citationVersion: 2 } as RawJsonValue;
}
