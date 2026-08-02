import { readFile } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";

import type { ToolDefinition } from "@flue/runtime";
import * as v from "valibot";

import { modelReviewResultSchema } from "../domain/review-result";
import { parsePriorFindingEvidence, type PriorFindingEvidence } from "../domain/finding-lifecycle";
import { parseRevisionComparison, type RevisionComparison, type ReviewScope } from "../domain/review-comparison";
import { ReviewInspector } from "./review-inspector";
import { createReviewInspectorTools } from "./review-inspector-tools";
import { composeReviewPrompt } from "./review-rubric";

const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;
const GIT_SHA = /^[a-f0-9]{40,64}$/;

export type ReviewModelSession = {
  prompt(text: string, options: {
    readonly result: typeof modelReviewResultSchema;
    readonly tools: ReadonlyArray<ToolDefinition>;
    readonly model?: string;
    readonly thinkingLevel?: "low" | "medium" | "high";
  }): Promise<{ readonly data: unknown }>;
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
  const fileSnapshots = await snapshotChangedFiles(input.worktreePath, reviewHeadSha(context, input.scope), files, input.gitShow);
  const inspector = new ReviewInspector({
    worktreePath: input.worktreePath,
    changedFiles: files,
    fileSnapshots,
    debugPath: input.debugPath,
    gitShow: input.gitShow,
  });
  const response = await input.session.prompt(composeReviewPrompt({
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
  const parsed = v.safeParse(modelReviewResultSchema, response.data);
  if (!parsed.success) throw new Error("Invalid model review result");
  return parsed.output;
}

async function snapshotChangedFiles(
  worktreePath: string,
  headSha: string | undefined,
  files: ReadonlyArray<string>,
  gitShow: (argv: ReadonlyArray<string>) => Promise<string>,
): Promise<Readonly<Record<string, string>>> {
  const snapshots: Record<string, string> = {};
  if (headSha === undefined) return snapshots;
  let snapshotBytes = 0;
  for (const path of files) {
    if (!isSafeRelativePath(path)) continue;
    try {
      const object = `${headSha}:${path}`;
      const git = ["git", "--no-replace-objects", "-C", worktreePath] as const;
      const mode = await gitShow([...git, "ls-tree", "--format=%(objectmode)", headSha, "--", path]);
      if (!isRegularTreeEntry(mode)) continue;
      const type = await gitShow([...git, "cat-file", "-t", object]);
      if (type.trim() !== "blob") continue;
      const fileBytes = parseBlobByteLength(await gitShow([...git, "cat-file", "-s", object]));
      if (fileBytes === undefined || fileBytes > MAX_SNAPSHOT_FILE_BYTES) continue;
      if (snapshotBytes + fileBytes > MAX_SNAPSHOT_TOTAL_BYTES) break;
      const contents = await gitShow([...git, "cat-file", "blob", object]);
      if (Buffer.byteLength(contents, "utf8") !== fileBytes) continue;
      snapshots[path] = contents;
      snapshotBytes += fileBytes;
    } catch {
      // Missing, binary, and unreadable blobs remain represented by the immutable patch.
    }
  }
  return snapshots;
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && path !== "." && !path.startsWith("./") && !path.startsWith(".\\") && !isAbsolute(path) && !win32.isAbsolute(path) && !isWindowsDriveRelative(path) && !path.includes("\0") && !path.split(/[\\/]/).includes("..");
}

function isRegularTreeEntry(raw: string): boolean {
  const mode = raw.trim();
  return mode === "100644" || mode === "100755";
}

function parseBlobByteLength(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) return undefined;
  const bytes = Number(trimmed);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

function reviewHeadSha(context: string, scope: ReviewScope | undefined): string | undefined {
  if (scope?.kind === "incremental") return GIT_SHA.test(scope.headSha) ? scope.headSha : undefined;
  try {
    const parsed: unknown = JSON.parse(context);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const headSha = (parsed as { readonly pr?: { readonly headSha?: unknown } }).pr?.headSha;
    return typeof headSha === "string" && GIT_SHA.test(headSha) ? headSha : undefined;
  } catch {
    return undefined;
  }
}

function isWindowsDriveRelative(path: string): boolean { return /^[a-z]:/i.test(path); }

function changedFiles(context: string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(context);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { changedFiles?: unknown }).changedFiles)) return [];
    return (parsed as { changedFiles: ReadonlyArray<unknown> }).changedFiles.filter((path): path is string => typeof path === "string");
  } catch {
    return [];
  }
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
