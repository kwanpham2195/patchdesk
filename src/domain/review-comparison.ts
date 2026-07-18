import * as v from "valibot";

import {
  parseAbsolutePath,
  parseGitSha,
  parseReviewSessionId,
  type AbsolutePath,
  type GitSha,
  type IsoTimestamp,
  type ReviewSessionId,
} from "./ids";
import { err, ok, type Result } from "./result";

/** Describes the exact evidence set that a review session is allowed to inspect. */
export type ReviewScope =
  | { readonly kind: "full" }
  | {
      readonly kind: "incremental";
      readonly baseSessionId: ReviewSessionId;
      readonly baseHeadSha: GitSha;
      readonly headSha: GitSha;
      readonly comparisonPatchPath: AbsolutePath;
      readonly comparisonMetadataPath: AbsolutePath;
      readonly previousFindingsPath: AbsolutePath;
      readonly lifecyclePath: AbsolutePath;
    };

export type ComparedCommit = {
  readonly sha: GitSha;
  readonly subject: string;
  readonly author: string;
  readonly authoredAt: IsoTimestamp;
};

export type ComparedFile = {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly textPatchAvailable: boolean;
};

/** Metadata for a two-tree comparison, with no raw command or patch output. */
export type RevisionComparison = {
  readonly schemaVersion: 1;
  readonly baseSessionId: ReviewSessionId;
  readonly baseHeadSha: GitSha;
  readonly headSha: GitSha;
  readonly ancestry: "fast_forward" | "rewritten" | "unknown";
  readonly source: "local_git" | "github";
  readonly completeness: "complete" | "incomplete";
  readonly commits: ReadonlyArray<ComparedCommit>;
  readonly files: ReadonlyArray<ComparedFile>;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: IsoTimestamp;
};

export type InvalidReviewScope = { readonly _tag: "InvalidReviewScope" };

const incrementalScopeSchema = v.strictObject({
  kind: v.literal("incremental"),
  baseSessionId: v.string(),
  baseHeadSha: v.string(),
  headSha: v.string(),
  comparisonPatchPath: v.string(),
  comparisonMetadataPath: v.string(),
  previousFindingsPath: v.string(),
  lifecyclePath: v.string(),
});

const reviewScopeSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("full") }),
  incrementalScopeSchema,
]);

/** Parse persisted review scope paths and identifiers before they reach service code. */
export function parseReviewScope(
  input: unknown,
): Result<ReviewScope, InvalidReviewScope> {
  const parsed = v.safeParse(reviewScopeSchema, input);
  if (!parsed.success) return err({ _tag: "InvalidReviewScope" });
  if (parsed.output.kind === "full") return ok({ kind: "full" });

  const baseSessionId = parseReviewSessionId(parsed.output.baseSessionId);
  const baseHeadSha = parseGitSha(parsed.output.baseHeadSha);
  const headSha = parseGitSha(parsed.output.headSha);
  const comparisonPatchPath = parseAbsolutePath(parsed.output.comparisonPatchPath);
  const comparisonMetadataPath = parseAbsolutePath(parsed.output.comparisonMetadataPath);
  const previousFindingsPath = parseAbsolutePath(parsed.output.previousFindingsPath);
  const lifecyclePath = parseAbsolutePath(parsed.output.lifecyclePath);
  if (
    baseSessionId._tag === "err" ||
    baseHeadSha._tag === "err" ||
    headSha._tag === "err" ||
    comparisonPatchPath._tag === "err" ||
    comparisonMetadataPath._tag === "err" ||
    previousFindingsPath._tag === "err" ||
    lifecyclePath._tag === "err"
  ) {
    return err({ _tag: "InvalidReviewScope" });
  }

  return ok({
    kind: "incremental",
    baseSessionId: baseSessionId.value,
    baseHeadSha: baseHeadSha.value,
    headSha: headSha.value,
    comparisonPatchPath: comparisonPatchPath.value,
    comparisonMetadataPath: comparisonMetadataPath.value,
    previousFindingsPath: previousFindingsPath.value,
    lifecyclePath: lifecyclePath.value,
  });
}
