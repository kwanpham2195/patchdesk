import * as v from "valibot";

import {
  parseFindingId,
  parseContentHash,
  parseRepoRelativePath,
  type FindingId,
  type RepoRelativePath,
} from "./ids";
import type { ModelPriorFindingAssessment } from "./finding-lifecycle";
import { err, ok, type Result } from "./result";

export type ReviewVerdict = "approve" | "comment" | "request_changes";
export type FindingSeverity = "P0" | "P1" | "P2" | "P3";
export type FindingCategory =
  | "bug"
  | "security"
  | "test"
  | "performance"
  | "maintainability"
  | "docs";
export type FindingMappingStatus = "mapped" | "unmapped" | "invalid_line";

export type ModelReviewFinding = {
  readonly id: FindingId;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly file?: RepoRelativePath;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly diffSide?: "new" | "old";
  readonly explanation: string;
  readonly suggestedComment?: string;
  readonly confidence: "high" | "medium" | "low";
  readonly category?: FindingCategory;
};

export type ModelReviewResult = {
  readonly changeSummary: string;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: ReadonlyArray<ModelReviewFinding>;
  readonly validationPlan: ReadonlyArray<string>;
  readonly assumptions: ReadonlyArray<string>;
  readonly priorFindingAssessments?: ReadonlyArray<ModelPriorFindingAssessment>;
  readonly rawNotes?: string;
};

export type ReviewFinding = ModelReviewFinding & {
  readonly mappingStatus: FindingMappingStatus;
};

export type ReviewResult = Omit<ModelReviewResult, "findings" | "priorFindingAssessments"> & {
  readonly findings: ReadonlyArray<ReviewFinding>;
};

export type InvalidModelReviewResult = {
  readonly _tag: "InvalidModelReviewResult";
};
export type InvalidReviewResult = { readonly _tag: "InvalidReviewResult" };

const findingSchema = {
  id: v.pipe(v.string(), v.minLength(1)),
  severity: v.picklist(["P0", "P1", "P2", "P3"]),
  title: v.pipe(v.string(), v.minLength(1)),
  file: v.optional(v.pipe(v.string(), v.minLength(1))),
  lineStart: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  lineEnd: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  diffSide: v.optional(v.picklist(["new", "old"])),
  explanation: v.pipe(v.string(), v.minLength(1)),
  suggestedComment: v.optional(v.pipe(v.string(), v.minLength(1))),
  confidence: v.picklist(["high", "medium", "low"]),
  category: v.optional(
    v.picklist(["bug", "security", "test", "performance", "maintainability", "docs"]),
  ),
} as const;

/** Schema for model output, deliberately excluding Patchdesk-controlled mapping status. */
export const modelReviewResultSchema = v.strictObject({
  changeSummary: v.pipe(v.string(), v.minLength(1)),
  verdict: v.picklist(["approve", "comment", "request_changes"]),
  summary: v.pipe(v.string(), v.minLength(1)),
  findings: v.array(v.strictObject(findingSchema)),
  validationPlan: v.array(v.pipe(v.string(), v.minLength(1))),
  assumptions: v.array(v.string()),
  priorFindingAssessments: v.optional(v.array(v.strictObject({
    priorFindingToken: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    disposition: v.picklist(["still_present", "resolved", "unverified"]),
    explanation: v.pipe(v.string(), v.minLength(1)),
    currentFindingId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }))),
  rawNotes: v.optional(v.string()),
});

/** Schema for Patchdesk's validated and location-mapped final review result. */
export const reviewResultSchema = v.strictObject({
  changeSummary: v.pipe(v.string(), v.minLength(1)),
  verdict: v.picklist(["approve", "comment", "request_changes"]),
  summary: v.pipe(v.string(), v.minLength(1)),
  findings: v.array(
    v.strictObject({
      ...findingSchema,
      mappingStatus: v.picklist(["mapped", "unmapped", "invalid_line"]),
    }),
  ),
  validationPlan: v.array(v.pipe(v.string(), v.minLength(1))),
  assumptions: v.array(v.string()),
  rawNotes: v.optional(v.string()),
});

/** Parse model output before Patchdesk owns and computes each finding's mapping state. */
export function parseModelReviewResult(
  input: unknown,
): Result<ModelReviewResult, InvalidModelReviewResult> {
  const parsed = v.safeParse(modelReviewResultSchema, input);
  if (!parsed.success) {
    return err({ _tag: "InvalidModelReviewResult" });
  }

  const findings = parseModelFindings(parsed.output.findings);
  if (findings._tag === "err") {
    return err({ _tag: "InvalidModelReviewResult" });
  }
  const assessments = parsed.output.priorFindingAssessments === undefined
    ? undefined
    : parsePriorFindingAssessments(parsed.output.priorFindingAssessments);
  if (assessments !== undefined && assessments._tag === "err") {
    return err({ _tag: "InvalidModelReviewResult" });
  }

  return ok({
    changeSummary: parsed.output.changeSummary,
    verdict: parsed.output.verdict,
    summary: parsed.output.summary,
    findings: findings.value,
    validationPlan: parsed.output.validationPlan,
    assumptions: parsed.output.assumptions,
    ...(assessments === undefined ? {} : { priorFindingAssessments: assessments.value }),
    ...(parsed.output.rawNotes === undefined ? {} : { rawNotes: parsed.output.rawNotes }),
  });
}

function parsePriorFindingAssessments(
  assessments: ReadonlyArray<NonNullable<v.InferOutput<typeof modelReviewResultSchema>["priorFindingAssessments"]>[number]>,
): Result<ReadonlyArray<ModelPriorFindingAssessment>, InvalidModelReviewResult> {
  const values: Array<ModelPriorFindingAssessment> = [];
  for (const assessment of assessments) {
    const token = parseContentHash(assessment.priorFindingToken);
    const currentFindingId = assessment.currentFindingId === undefined
      ? undefined
      : parseFindingId(assessment.currentFindingId);
    if (token._tag === "err" || (currentFindingId !== undefined && currentFindingId._tag === "err")) {
      return err({ _tag: "InvalidModelReviewResult" });
    }
    values.push({
      priorFindingToken: token.value,
      disposition: assessment.disposition,
      explanation: assessment.explanation,
      ...(currentFindingId === undefined ? {} : { currentFindingId: currentFindingId.value }),
    });
  }
  return ok(values);
}

/** Parse a final Patchdesk result whose mapping status was computed outside the model. */
export function parseReviewResult(
  input: unknown,
): Result<ReviewResult, InvalidReviewResult> {
  const parsed = v.safeParse(reviewResultSchema, input);
  if (!parsed.success) {
    return err({ _tag: "InvalidReviewResult" });
  }

  const findings: Array<ReviewFinding> = [];
  for (const finding of parsed.output.findings) {
    const projected = projectFinding(finding);
    if (projected._tag === "err") {
      return err({ _tag: "InvalidReviewResult" });
    }

    findings.push({ ...projected.value, mappingStatus: finding.mappingStatus });
  }

  return ok({
    changeSummary: parsed.output.changeSummary,
    verdict: parsed.output.verdict,
    summary: parsed.output.summary,
    findings,
    validationPlan: parsed.output.validationPlan,
    assumptions: parsed.output.assumptions,
    ...(parsed.output.rawNotes === undefined ? {} : { rawNotes: parsed.output.rawNotes }),
  });
}

function parseModelFindings(
  findings: ReadonlyArray<v.InferOutput<typeof modelReviewResultSchema>["findings"][number]>,
): Result<ReadonlyArray<ModelReviewFinding>, InvalidModelReviewResult> {
  const values: Array<ModelReviewFinding> = [];
  for (const finding of findings) {
    const projected = projectFinding(finding);
    if (projected._tag === "err") {
      return err({ _tag: "InvalidModelReviewResult" });
    }

    values.push(projected.value);
  }

  return ok(values);
}

function projectFinding(
  finding: v.InferOutput<typeof modelReviewResultSchema>["findings"][number],
): Result<ModelReviewFinding, InvalidModelReviewResult> {
  const id = parseFindingId(finding.id);
  const file = finding.file === undefined ? undefined : parseRepoRelativePath(finding.file);
  if (id._tag === "err" || (file !== undefined && file._tag === "err")) {
    return err({ _tag: "InvalidModelReviewResult" });
  }

  return ok({
    id: id.value,
    severity: finding.severity,
    title: finding.title,
    ...(file === undefined ? {} : { file: file.value }),
    ...(finding.lineStart === undefined ? {} : { lineStart: finding.lineStart }),
    ...(finding.lineEnd === undefined ? {} : { lineEnd: finding.lineEnd }),
    ...(finding.diffSide === undefined ? {} : { diffSide: finding.diffSide }),
    explanation: finding.explanation,
    ...(finding.suggestedComment === undefined
      ? {}
      : { suggestedComment: finding.suggestedComment }),
    confidence: finding.confidence,
    ...(finding.category === undefined ? {} : { category: finding.category }),
  });
}
