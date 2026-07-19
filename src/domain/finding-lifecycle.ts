import * as v from "valibot";

import { parseContentHash, parseFindingId, parseRepoRelativePath, type ContentHash, type FindingId, type RepoRelativePath } from "./ids";
import type { FindingCategory, FindingSeverity, ReviewFinding } from "./review-result";
import { err, ok, type Result } from "./result";

export type PriorFindingToken = ContentHash;

export type ModelPriorFindingAssessment = {
  readonly priorFindingToken: PriorFindingToken;
  readonly disposition: "still_present" | "resolved" | "unverified";
  readonly explanation: string;
  readonly currentFindingId?: FindingId;
};

export type PriorFindingEvidence = {
  readonly token: PriorFindingToken;
  readonly findingId: FindingId;
  readonly severity: FindingSeverity;
  readonly category?: FindingCategory;
  readonly title: string;
  readonly explanation: string;
  readonly file?: RepoRelativePath;
  readonly wasSubmitted: boolean;
};

export type FindingLifecycleEntry = {
  readonly priorFindingToken?: PriorFindingToken;
  readonly priorFindingId?: FindingId;
  readonly currentFindingId?: FindingId;
  readonly status: "new" | "still_present" | "resolved" | "unverified";
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly explanation: string;
  readonly evidence: "current_patch" | "comparison_patch" | "prior_result";
  readonly draftPostability: "postable" | "already_reported" | "not_applicable" | "unmapped";
};

export type FindingLifecycleFailure = {
  readonly _tag: "InvalidPriorFindingAssessment";
  readonly reason: "unknown_token" | "duplicate_token" | "unknown_current_finding" | "duplicate_current_finding";
};

const priorFindingEvidenceSchema = v.array(v.strictObject({
  token: v.string(),
  findingId: v.string(),
  severity: v.picklist(["P0", "P1", "P2", "P3"]),
  category: v.optional(v.picklist(["bug", "security", "test", "performance", "maintainability", "docs"])),
  title: v.pipe(v.string(), v.minLength(1)),
  explanation: v.pipe(v.string(), v.minLength(1)),
  file: v.optional(v.string()),
  wasSubmitted: v.boolean(),
}));

/** Parse persisted opaque prior-finding evidence before model or completion code uses it. */
export function parsePriorFindingEvidence(input: unknown): Result<ReadonlyArray<PriorFindingEvidence>, { readonly _tag: "InvalidPriorFindingEvidence" }> {
  const parsed = v.safeParse(priorFindingEvidenceSchema, input);
  if (!parsed.success) return err({ _tag: "InvalidPriorFindingEvidence" });
  const values: Array<PriorFindingEvidence> = [];
  for (const finding of parsed.output) {
    const token = parseContentHash(finding.token);
    const findingId = parseFindingId(finding.findingId);
    const file = finding.file === undefined ? undefined : parseRepoRelativePath(finding.file);
    if (token._tag === "err" || findingId._tag === "err" || (file !== undefined && file._tag === "err")) {
      return err({ _tag: "InvalidPriorFindingEvidence" });
    }
    values.push({
      token: token.value,
      findingId: findingId.value,
      severity: finding.severity,
      ...(finding.category === undefined ? {} : { category: finding.category }),
      title: finding.title,
      explanation: finding.explanation,
      ...(file === undefined ? {} : { file: file.value }),
      wasSubmitted: finding.wasSubmitted,
    });
  }
  return ok(values);
}

/** Derive conservative lifecycle state from Patchdesk-owned evidence and model assessments. */
export function projectFindingLifecycle(input: {
  readonly priorFindings: ReadonlyArray<PriorFindingEvidence>;
  readonly assessments: ReadonlyArray<ModelPriorFindingAssessment>;
  readonly currentFindings: ReadonlyArray<ReviewFinding>;
  readonly changedPaths: ReadonlySet<RepoRelativePath>;
}): Result<ReadonlyArray<FindingLifecycleEntry>, FindingLifecycleFailure> {
  const priorsByToken = new Map(input.priorFindings.map((finding) => [finding.token, finding]));
  const currentById = new Map(input.currentFindings.map((finding) => [finding.id, finding]));
  const assessedTokens = new Set<PriorFindingToken>();
  const linkedCurrentIds = new Set<FindingId>();
  const entries: Array<FindingLifecycleEntry> = [];

  for (const assessment of input.assessments) {
    const prior = priorsByToken.get(assessment.priorFindingToken);
    if (prior === undefined) return err({ _tag: "InvalidPriorFindingAssessment", reason: "unknown_token" });
    if (assessedTokens.has(assessment.priorFindingToken)) return err({ _tag: "InvalidPriorFindingAssessment", reason: "duplicate_token" });
    assessedTokens.add(assessment.priorFindingToken);

    const current = assessment.currentFindingId === undefined ? undefined : currentById.get(assessment.currentFindingId);
    if (assessment.currentFindingId !== undefined && current === undefined) {
      return err({ _tag: "InvalidPriorFindingAssessment", reason: "unknown_current_finding" });
    }
    if (current !== undefined && linkedCurrentIds.has(current.id)) {
      return err({ _tag: "InvalidPriorFindingAssessment", reason: "duplicate_current_finding" });
    }
    if (current !== undefined) linkedCurrentIds.add(current.id);

    const changed = prior.file !== undefined && input.changedPaths.has(prior.file);
    const status = assessment.disposition === "resolved" && !changed
      ? "unverified"
      : assessment.disposition;
    const mapped = current?.mappingStatus === "mapped";
    entries.push({
      priorFindingToken: prior.token,
      priorFindingId: prior.findingId,
      ...(current === undefined ? {} : { currentFindingId: current.id }),
      status,
      severity: current?.severity ?? prior.severity,
      title: current?.title ?? prior.title,
      explanation: assessment.explanation,
      evidence: status === "still_present" && current !== undefined ? "current_patch" : status === "resolved" ? "comparison_patch" : "prior_result",
      draftPostability: status === "still_present" && prior.wasSubmitted
        ? "already_reported"
        : status === "still_present" && mapped
          ? "postable"
          : status === "still_present"
            ? "unmapped"
            : "not_applicable",
    });
  }

  for (const prior of input.priorFindings) {
    if (assessedTokens.has(prior.token)) continue;
    entries.push({
      priorFindingToken: prior.token,
      priorFindingId: prior.findingId,
      status: "unverified",
      severity: prior.severity,
      title: prior.title,
      explanation: "The incremental review did not assess this prior finding.",
      evidence: "prior_result",
      draftPostability: "not_applicable",
    });
  }

  for (const current of input.currentFindings) {
    if (linkedCurrentIds.has(current.id)) continue;
    entries.push({
      currentFindingId: current.id,
      status: "new",
      severity: current.severity,
      title: current.title,
      explanation: current.explanation,
      evidence: "current_patch",
      draftPostability: current.mappingStatus === "mapped" ? "postable" : "unmapped",
    });
  }

  return ok(entries);
}
