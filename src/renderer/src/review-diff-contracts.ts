import * as v from "valibot";

import { commitSchema } from "./renderer-contracts";

const maxDiffPatchLength = 1_500_000;

const commitDiffResponseSchema = v.strictObject({
  commit: commitSchema,
  position: v.pipe(v.number(), v.integer(), v.minValue(1)),
  total: v.pipe(v.number(), v.integer(), v.minValue(1)),
  patch: v.pipe(v.string(), v.maxLength(maxDiffPatchLength)),
  fileCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type CommitDiffResponse = v.InferOutput<typeof commitDiffResponseSchema>;

export function parseCommitDiffResponse(
  input: unknown,
): CommitDiffResponse | undefined {
  const parsed = v.safeParse(commitDiffResponseSchema, input);
  if (!parsed.success || parsed.output.position > parsed.output.total)
    return undefined;
  return parsed.output;
}

const sinceReviewDiffResponseSchema = v.strictObject({
  baseSha: v.pipe(v.string(), v.minLength(7)),
  headSha: v.pipe(v.string(), v.minLength(7)),
  patch: v.pipe(v.string(), v.maxLength(maxDiffPatchLength)),
});
export type SinceReviewDiffResponse = v.InferOutput<
  typeof sinceReviewDiffResponseSchema
>;

export function parseSinceReviewDiffResponse(
  input: unknown,
): SinceReviewDiffResponse | undefined {
  const parsed = v.safeParse(sinceReviewDiffResponseSchema, input);
  return parsed.success ? parsed.output : undefined;
}
