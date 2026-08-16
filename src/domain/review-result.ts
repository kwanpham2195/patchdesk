import * as v from "valibot";

import {
  parseFindingId,
  parseRepoRelativePath,
  type FindingId,
  type RepoRelativePath,
} from "./ids";
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
export type FindingDisposition = "open" | "dismissed";
export type ReviewConfidence = "high" | "medium" | "low";
export type ReviewCalloutCategory =
  | "migration"
  | "dependency"
  | "dependency_change"
  | "authentication"
  | "compatibility"
  | "destructive_operation"
  | "feature_flag"
  | "configuration";

export type ReviewCallout = {
  readonly category: ReviewCalloutCategory;
  readonly title: string;
  readonly detail: string;
  readonly path?: RepoRelativePath;
};

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
  readonly confidence: ReviewConfidence;
  readonly category?: FindingCategory;
  readonly affectedScenario?: string;
  readonly whyItMatters?: string;
  readonly suggestedChange?: string;
};

export type ModelReviewResult = {
  readonly changeSummary: string;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: ReadonlyArray<ModelReviewFinding>;
  readonly validationPlan: ReadonlyArray<string>;
  readonly assumptions: ReadonlyArray<string>;
  readonly coverage?: ReviewConfidence;
  readonly overallConfidence?: ReviewConfidence;
  readonly unresolvedItems?: ReadonlyArray<string>;
  readonly callouts?: ReadonlyArray<ReviewCallout>;
};

export type ReviewFinding = ModelReviewFinding & {
  readonly mappingStatus: FindingMappingStatus;
  /** Renderer-side disposition; absent on raw validated model results. */
  readonly disposition?: FindingDisposition;
};

export type ReviewResult = Omit<ModelReviewResult, "findings"> & {
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
    v.picklist([
      "bug",
      "security",
      "test",
      "performance",
      "maintainability",
      "docs",
    ]),
  ),
  affectedScenario: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  ),
  whyItMatters: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(900)),
  ),
  suggestedChange: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  ),
} as const;

const calloutSchema = v.strictObject({
  category: v.picklist([
    "migration",
    "dependency",
    "dependency_change",
    "authentication",
    "compatibility",
    "destructive_operation",
    "feature_flag",
    "configuration",
  ]),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  detail: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  path: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/** Schema for model output, deliberately excluding Patchdesk-controlled mapping status. */
export const modelReviewResultSchema = v.strictObject({
  changeSummary: v.pipe(v.string(), v.minLength(1)),
  verdict: v.picklist(["approve", "comment", "request_changes"]),
  summary: v.pipe(v.string(), v.minLength(1)),
  findings: v.pipe(v.array(v.strictObject(findingSchema)), v.maxLength(50)),
  validationPlan: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
    v.maxLength(20),
  ),
  assumptions: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(500))),
    v.maxLength(20),
  ),
  coverage: v.optional(v.picklist(["high", "medium", "low"])),
  overallConfidence: v.optional(v.picklist(["high", "medium", "low"])),
  unresolvedItems: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(280))),
      v.maxLength(10),
    ),
  ),
  callouts: v.optional(v.pipe(v.array(calloutSchema), v.maxLength(12))),
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
  validationPlan: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
    v.maxLength(20),
  ),
  assumptions: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(500))),
    v.maxLength(20),
  ),
  coverage: v.optional(v.picklist(["high", "medium", "low"])),
  overallConfidence: v.optional(v.picklist(["high", "medium", "low"])),
  unresolvedItems: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(280))),
      v.maxLength(10),
    ),
  ),
  callouts: v.optional(v.pipe(v.array(calloutSchema), v.maxLength(12))),
});

/** Parse model output before Patchdesk owns and computes each finding's mapping state. */
export function parseModelReviewResult(
  input: unknown,
): Result<ModelReviewResult, InvalidModelReviewResult> {
  const parsed = v.safeParse(modelReviewResultSchema, input);
  if (!parsed.success) {
    return err({ _tag: "InvalidModelReviewResult" });
  }

  if (!hasConsistentVerdict(parsed.output.verdict, parsed.output.findings)) {
    return err({ _tag: "InvalidModelReviewResult" });
  }

  const findings = parseModelFindings(parsed.output.findings);
  if (findings._tag === "err") {
    return err({ _tag: "InvalidModelReviewResult" });
  }
  const callouts =
    parsed.output.callouts === undefined
      ? undefined
      : parseCallouts(parsed.output.callouts);
  if (callouts !== undefined && callouts._tag === "err") {
    return err({ _tag: "InvalidModelReviewResult" });
  }

  return ok({
    changeSummary: parsed.output.changeSummary,
    verdict: parsed.output.verdict,
    summary: parsed.output.summary,
    findings: findings.value,
    validationPlan: parsed.output.validationPlan,
    assumptions: parsed.output.assumptions,
    ...(parsed.output.coverage === undefined
      ? {}
      : { coverage: parsed.output.coverage }),
    ...(parsed.output.overallConfidence === undefined
      ? {}
      : { overallConfidence: parsed.output.overallConfidence }),
    ...(parsed.output.unresolvedItems === undefined
      ? {}
      : { unresolvedItems: parsed.output.unresolvedItems }),
    ...(callouts === undefined ? {} : { callouts: callouts.value }),
  });
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

  const callouts =
    parsed.output.callouts === undefined
      ? undefined
      : parseStoredCallouts(parsed.output.callouts);
  if (callouts !== undefined && callouts._tag === "err") {
    return err({ _tag: "InvalidReviewResult" });
  }

  return ok({
    changeSummary: parsed.output.changeSummary,
    verdict: parsed.output.verdict,
    summary: parsed.output.summary,
    findings,
    validationPlan: parsed.output.validationPlan,
    assumptions: parsed.output.assumptions,
    ...(parsed.output.coverage === undefined
      ? {}
      : { coverage: parsed.output.coverage }),
    ...(parsed.output.overallConfidence === undefined
      ? {}
      : { overallConfidence: parsed.output.overallConfidence }),
    ...(parsed.output.unresolvedItems === undefined
      ? {}
      : { unresolvedItems: parsed.output.unresolvedItems }),
    ...(callouts === undefined ? {} : { callouts: callouts.value }),
  });
}

function parseStoredCallouts(
  callouts: ReadonlyArray<v.InferOutput<typeof calloutSchema>>,
): Result<ReadonlyArray<ReviewCallout>, InvalidReviewResult> {
  const values: Array<ReviewCallout> = [];
  for (const callout of callouts) {
    const path =
      callout.path === undefined
        ? undefined
        : parseRepoRelativePath(callout.path);
    if (path !== undefined && path._tag === "err")
      return err({ _tag: "InvalidReviewResult" });
    values.push({
      category: callout.category,
      title: callout.title,
      detail: callout.detail,
      ...(path === undefined ? {} : { path: path.value }),
    });
  }
  return ok(values);
}

function parseCallouts(
  callouts: ReadonlyArray<v.InferOutput<typeof calloutSchema>>,
): Result<ReadonlyArray<ReviewCallout>, InvalidModelReviewResult> {
  const values: Array<ReviewCallout> = [];
  for (const callout of callouts) {
    const path =
      callout.path === undefined
        ? undefined
        : parseRepoRelativePath(callout.path);
    if (path !== undefined && path._tag === "err")
      return err({ _tag: "InvalidModelReviewResult" });
    values.push({
      category: callout.category,
      title: callout.title,
      detail: callout.detail,
      ...(path === undefined ? {} : { path: path.value }),
    });
  }
  return ok(values);
}

function parseModelFindings(
  findings: ReadonlyArray<
    v.InferOutput<typeof modelReviewResultSchema>["findings"][number]
  >,
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
  const file =
    finding.file === undefined
      ? undefined
      : parseRepoRelativePath(finding.file);
  if (id._tag === "err" || (file !== undefined && file._tag === "err")) {
    return err({ _tag: "InvalidModelReviewResult" });
  }
  if (
    finding.lineStart !== undefined &&
    finding.lineEnd !== undefined &&
    finding.lineEnd < finding.lineStart
  )
    return err({ _tag: "InvalidModelReviewResult" });
  // The evidence highlight is bounded even when the model cites a wide range;
  // a wide range is a display bound, never a reason to fail the whole run.
  const lineEnd =
    finding.lineStart !== undefined &&
    finding.lineEnd !== undefined &&
    finding.lineEnd - finding.lineStart > 9
      ? finding.lineStart + 9
      : finding.lineEnd;

  return ok({
    id: id.value,
    severity: finding.severity,
    title: finding.title,
    ...(file === undefined ? {} : { file: file.value }),
    ...(finding.lineStart === undefined
      ? {}
      : { lineStart: finding.lineStart }),
    ...(lineEnd === undefined ? {} : { lineEnd }),
    ...(finding.diffSide === undefined ? {} : { diffSide: finding.diffSide }),
    explanation: finding.explanation,
    ...(finding.suggestedComment === undefined
      ? {}
      : { suggestedComment: finding.suggestedComment }),
    confidence: finding.confidence,
    ...(finding.category === undefined ? {} : { category: finding.category }),
    ...(finding.affectedScenario === undefined
      ? {}
      : { affectedScenario: finding.affectedScenario }),
    ...(finding.whyItMatters === undefined
      ? {}
      : { whyItMatters: finding.whyItMatters }),
    ...(finding.suggestedChange === undefined
      ? {}
      : { suggestedChange: finding.suggestedChange }),
  });
}

function hasConsistentVerdict(
  verdict: ReviewVerdict,
  findings: ReadonlyArray<{ readonly severity: FindingSeverity }>,
): boolean {
  const hasBlocking = findings.some(
    (finding) => finding.severity === "P0" || finding.severity === "P1",
  );
  if (hasBlocking) return verdict === "request_changes";
  if (findings.length > 0) return verdict === "comment";
  return verdict === "approve";
}
