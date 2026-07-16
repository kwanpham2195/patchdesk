import { readFile } from "node:fs/promises";

import type { ToolDefinition } from "@flue/runtime";
import type * as v from "valibot";

import { modelReviewResultSchema } from "../domain/review-result";
import { ReviewInspector } from "./review-inspector";
import { createReviewInspectorTools } from "./review-inspector-tools";

export type ReviewModelSession = {
  prompt(text: string, options: {
    readonly result: typeof modelReviewResultSchema;
    readonly tools: ReadonlyArray<ToolDefinition>;
  }): Promise<{ readonly data: WorkflowModelReviewResult }>;
};

export type WorkflowModelReviewResult = v.InferOutput<typeof modelReviewResultSchema>;

type RunModelReviewInput = {
  readonly session: ReviewModelSession;
  readonly worktreePath: string;
  readonly contextPath: string;
  readonly reviewInputPath: string;
  readonly debugPath: string;
  readonly gitShow: (argv: ReadonlyArray<string>) => Promise<string>;
};

/** Runs one schema-backed model review using only prepared metadata and inspector tools. */
export async function runModelReview(input: RunModelReviewInput): Promise<WorkflowModelReviewResult> {
  const [context, reviewInput] = await Promise.all([
    readFile(input.contextPath, "utf8"),
    readFile(input.reviewInputPath, "utf8"),
  ]);
  const inspector = new ReviewInspector({
    worktreePath: input.worktreePath,
    changedFiles: changedFiles(context),
    debugPath: input.debugPath,
    gitShow: input.gitShow,
  });
  const response = await input.session.prompt(reviewPrompt(reviewInput, context), {
    result: modelReviewResultSchema,
    tools: createReviewInspectorTools(inspector),
  });
  return response.data;
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

function reviewPrompt(reviewInput: string, context: string): string {
  return [
    "Review this pull request for concrete, evidence-backed issues.",
    "Use only the supplied inspection tools for repository source. Do not infer files or line locations without inspection.",
    "Return the required structured result. Do not include mappingStatus or rawNotes.",
    "Prepared review input:",
    reviewInput,
    "Prepared metadata:",
    context,
  ].join("\n\n");
}
