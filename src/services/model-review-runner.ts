import { readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { ToolDefinition } from "@flue/runtime";
import type * as v from "valibot";

import { modelReviewResultSchema } from "../domain/review-result";
import { parsePriorFindingEvidence, type PriorFindingEvidence } from "../domain/finding-lifecycle";
import { parseRevisionComparison, type RevisionComparison, type ReviewScope } from "../domain/review-comparison";
import { ReviewInspector } from "./review-inspector";
import { createReviewInspectorTools } from "./review-inspector-tools";

export type ReviewModelSession = {
  prompt(text: string, options: {
    readonly result: typeof modelReviewResultSchema;
    readonly tools: ReadonlyArray<ToolDefinition>;
    readonly model?: string;
    readonly thinkingLevel?: "low" | "medium" | "high";
  }): Promise<{ readonly data: WorkflowModelReviewResult }>;
};

export type WorkflowModelReviewResult = v.InferOutput<typeof modelReviewResultSchema>;

type RunModelReviewInput = {
  readonly session: ReviewModelSession;
  readonly worktreePath: string;
  readonly contextPath: string;
  readonly reviewInputPath: string;
  readonly patchPath: string;
  readonly debugPath: string;
  readonly scope?: ReviewScope;
  readonly model?: string;
  readonly reasoning?: "low" | "medium" | "high";
  readonly gitShow: (argv: ReadonlyArray<string>) => Promise<string>;
};

/** Runs one schema-backed model review using only prepared metadata and inspector tools. */
export async function runModelReview(input: RunModelReviewInput): Promise<WorkflowModelReviewResult> {
  const [context, reviewInput, fullPatch] = await Promise.all([
    readFile(input.contextPath, "utf8"),
    readFile(input.reviewInputPath, "utf8"),
    readFile(input.patchPath, "utf8"),
  ]);
  const incremental = input.scope?.kind === "incremental"
    ? await readIncrementalEvidence(input.scope)
    : undefined;
  const files = incremental === undefined
    ? changedFiles(context)
    : [...new Set([...incremental.comparison.files.map((file) => file.path), ...incremental.priorFindings.flatMap((finding) => finding.file === undefined ? [] : [finding.file])])];
  const fileSnapshots = await snapshotChangedFiles(input.worktreePath, files);
  const inspector = new ReviewInspector({
    worktreePath: input.worktreePath,
    changedFiles: files,
    fileSnapshots,
    debugPath: input.debugPath,
    gitShow: input.gitShow,
  });
  const response = await input.session.prompt(reviewPrompt({
    reviewInput,
    context,
    fullPatch,
    ...(incremental === undefined ? {} : { incremental }),
  }), {
    result: modelReviewResultSchema,
    tools: createReviewInspectorTools(inspector),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoning === undefined ? {} : { thinkingLevel: input.reasoning }),
  });
  return response.data;
}

async function snapshotChangedFiles(
  worktreePath: string,
  files: ReadonlyArray<string>,
): Promise<Readonly<Record<string, string>>> {
  const root = await realpath(worktreePath);
  const snapshots: Record<string, string> = {};
  for (const path of files) {
    if (!isSafeRelativePath(path)) continue;
    const candidate = resolve(root, path);
    if (relative(root, candidate).startsWith("..")) continue;
    try {
      snapshots[path] = await readFile(candidate, "utf8");
    } catch {
      // Binary, removed, and unreadable files remain represented by the immutable patch.
    }
  }
  return snapshots;
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\0") && !path.split("/").includes("..");
}

function changedFiles(context: string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(context);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { changedFiles?: unknown }).changedFiles)) return [];
    return (parsed as { changedFiles: ReadonlyArray<unknown> }).changedFiles.filter((path): path is string => typeof path === "string");
  } catch {
    return [];
  }
}

function reviewPrompt(input: {
  readonly reviewInput: string;
  readonly context: string;
  readonly fullPatch: string;
  readonly incremental?: { readonly patch: string; readonly comparison: RevisionComparison; readonly priorFindings: ReadonlyArray<PriorFindingEvidence> };
}): string {
  if (input.incremental !== undefined) {
    return [
      "Review this incremental pull request update for concrete, evidence-backed issues.",
      "The comparison patch is the primary evidence. Report only newly introduced concrete issues as findings; do not relabel a known unchanged issue as new.",
      "Assess every supplied opaque prior-finding token as still_present, resolved, or unverified. A resolved claim requires evidence in the comparison. Do not include mappingStatus, lifecycle state, posting state, or rawNotes.",
      "Prepared review input:",
      input.reviewInput,
      "Prepared metadata:",
      input.context,
      "Exact revision comparison metadata:",
      JSON.stringify(input.incremental.comparison),
      "Prior finding evidence:",
      JSON.stringify(input.incremental.priorFindings),
      "Prepared incremental patch:",
      input.incremental.patch,
      "The complete current PR patch is retained by Patchdesk for final GitHub coordinate mapping and is intentionally not duplicated here.",
    ].join("\n\n");
  }
  return [
    "Review this pull request for concrete, evidence-backed issues.",
    "Use the prepared unified patch below as the primary repository evidence. Use the supplied read-only inspection tools only when they are available; do not infer files or line locations beyond inspected evidence.",
    "Return the required structured result. Do not include mappingStatus or rawNotes.",
    "Prepared review input:",
    input.reviewInput,
    "Prepared metadata:",
    input.context,
    "Prepared unified patch:",
    input.fullPatch,
  ].join("\n\n");
}

async function readIncrementalEvidence(scope: Extract<ReviewScope, { readonly kind: "incremental" }>): Promise<{
  readonly patch: string;
  readonly comparison: RevisionComparison;
  readonly priorFindings: ReadonlyArray<PriorFindingEvidence>;
}> {
  const [patch, rawComparison, rawPriorFindings] = await Promise.all([
    readFile(scope.comparisonPatchPath, "utf8"),
    readFile(scope.comparisonMetadataPath, "utf8"),
    readFile(scope.previousFindingsPath, "utf8"),
  ]);
  let rawComparisonValue: unknown;
  let rawPriorFindingValue: unknown;
  try {
    rawComparisonValue = JSON.parse(rawComparison);
    rawPriorFindingValue = JSON.parse(rawPriorFindings);
  } catch {
    throw new Error("Invalid incremental review artifacts");
  }
  const comparison = parseRevisionComparison(rawComparisonValue);
  const priorFindings = parsePriorFindingEvidence(rawPriorFindingValue);
  if (comparison._tag === "err" || priorFindings._tag === "err" || comparison.value.headSha !== scope.headSha || comparison.value.baseHeadSha !== scope.baseHeadSha) {
    throw new Error("Invalid incremental review artifacts");
  }
  return { patch, comparison: comparison.value, priorFindings: priorFindings.value };
}
