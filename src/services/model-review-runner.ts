import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ToolDefinition } from "@flue/runtime";
import type * as v from "valibot";

import { modelReviewResultSchema } from "../domain/review-result";
import { parsePriorFindingEvidence, type PriorFindingEvidence } from "../domain/finding-lifecycle";
import { parseRevisionComparison, type RevisionComparison, type ReviewScope } from "../domain/review-comparison";
import { ReviewInspector } from "./review-inspector";
import { createReviewInspectorTools } from "./review-inspector-tools";
import { composeReviewPrompt } from "./review-rubric";

const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;

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
  return response.data;
}

async function snapshotChangedFiles(
  worktreePath: string,
  files: ReadonlyArray<string>,
): Promise<Readonly<Record<string, string>>> {
  const root = await realpath(worktreePath);
  const snapshots: Record<string, string> = {};
  let snapshotBytes = 0;
  for (const path of files) {
    if (!isSafeRelativePath(path)) continue;
    const candidate = resolve(root, path);
    if (!isContainedPath(root, candidate)) continue;
    try {
      const initial = await resolveSafeSnapshotPath(root, path);
      if (initial === undefined) continue;
      const handle = await open(initial.resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const file = await handle.stat();
        if (!file.isFile() || file.size > MAX_SNAPSHOT_FILE_BYTES) continue;
        if (snapshotBytes + file.size > MAX_SNAPSHOT_TOTAL_BYTES) break;
        const afterOpen = await resolveSafeSnapshotPath(root, path);
        if (afterOpen === undefined || !isSameFile(file, afterOpen)) continue;
        const contents = Buffer.alloc(file.size);
        const { bytesRead } = await handle.read(contents, 0, file.size, 0);
        const unchanged = await handle.stat();
        const afterRead = await resolveSafeSnapshotPath(root, path);
        if (bytesRead !== file.size || unchanged.size !== file.size || unchanged.mtimeMs !== file.mtimeMs || afterRead === undefined || !isSameFile(file, afterRead)) continue;
        snapshots[path] = contents.toString("utf8");
        snapshotBytes += file.size;
      } finally {
        await handle.close();
      }
    } catch {
      // Binary, removed, and unreadable files remain represented by the immutable patch.
    }
  }
  return snapshots;
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes("\0") && !path.split(sep).includes("..");
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath.length > 0 && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

async function resolveSafeSnapshotPath(root: string, path: string): Promise<{ readonly resolved: string; readonly dev: number; readonly ino: number } | undefined> {
  let candidate = root;
  const segments = path.split(sep);
  for (const [index, segment] of segments.entries()) {
    candidate = resolve(candidate, segment);
    const entry = await lstat(candidate);
    if (entry.isSymbolicLink() || (index < segments.length - 1 && !entry.isDirectory()) || (index === segments.length - 1 && !entry.isFile())) return undefined;
  }
  const resolved = await realpath(candidate);
  if (!isContainedPath(root, resolved)) return undefined;
  const entry = await lstat(resolved);
  if (entry.isSymbolicLink() || !entry.isFile()) return undefined;
  return { resolved, dev: entry.dev, ino: entry.ino };
}

function isSameFile(file: { readonly dev: number; readonly ino: number }, candidate: { readonly dev: number; readonly ino: number }): boolean {
  return file.dev === candidate.dev && file.ino === candidate.ino;
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
