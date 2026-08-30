import { readFile } from "node:fs/promises";

import * as v from "valibot";

import {
  briefManifest,
  normalizeBrief,
  type BriefError,
} from "../domain/brief";
import { definedProps } from "../domain/defined-props";
import type { InsightRevision, InsightType } from "../domain/insight-record";
import type { RawJsonValue } from "../domain/json";
import {
  normalizeNarrativeWalkthrough,
  type NarrativeWalkthroughError,
} from "../domain/narrative-walkthrough";
import { mapFindingLocation, parseUnifiedPatch } from "../domain/patch";
import { err, type Result } from "../domain/result";
import {
  parseModelReviewResult,
  parseReviewResult,
} from "../domain/review-result";
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
      briefManifest({
        patch,
        ...definedProps({ description: input.briefEvidence?.description }),
        commits: input.briefEvidence?.commits ?? [],
      }),
      {
        profileId: input.profileId,
        sessionId: revision.sessionId,
        headSha: revision.headSha,
        patchHash: revision.patchHash,
      },
    );
    return normalizedBrief._tag === "ok"
      ? normalizedBrief
      : err(normalizedBrief.error.reason);
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

function currentWalkthroughOutput(value: RawJsonValue): RawJsonValue {
  if (Array.isArray(value)) return value;
  const record = v.safeParse(v.looseObject({}), value);
  if (!record.success) return value;
  // SAFETY: value is RawJsonValue and record.output holds the exact same own properties
  // (valibot's looseObject passes unknown keys through unchanged), so each property is itself
  // RawJsonValue by the JSON value grammar.
  return { ...record.output, citationVersion: 2 } as RawJsonValue;
}
