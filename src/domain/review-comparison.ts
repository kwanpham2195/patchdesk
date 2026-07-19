import * as v from "valibot";

import {
  parseAbsolutePath,
  parseGitSha,
  parseIsoTimestamp,
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

const revisionComparisonSchema = v.strictObject({
  schemaVersion: v.literal(1),
  baseSessionId: v.string(),
  baseHeadSha: v.string(),
  headSha: v.string(),
  ancestry: v.picklist(["fast_forward", "rewritten", "unknown"]),
  source: v.picklist(["local_git", "github"]),
  completeness: v.picklist(["complete", "incomplete"]),
  commits: v.array(v.strictObject({ sha: v.string(), subject: v.string(), author: v.string(), authoredAt: v.string() })),
  files: v.array(v.strictObject({ path: v.pipe(v.string(), v.minLength(1)), oldPath: v.optional(v.pipe(v.string(), v.minLength(1))), status: v.picklist(["added", "modified", "deleted", "renamed", "copied", "unknown"]), additions: v.pipe(v.number(), v.integer(), v.minValue(0)), deletions: v.pipe(v.number(), v.integer(), v.minValue(0)), binary: v.boolean(), textPatchAvailable: v.boolean() })),
  additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  createdAt: v.string(),
});

export const reviewScopeSchema = v.variant("kind", [
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

/** Parse a persisted comparison artifact before it becomes model or UI input. */
export function parseRevisionComparison(input: unknown): Result<RevisionComparison, { readonly _tag: "InvalidRevisionComparison" }> {
  const parsed = v.safeParse(revisionComparisonSchema, input);
  if (!parsed.success) return err({ _tag: "InvalidRevisionComparison" });
  const baseSessionId = parseReviewSessionId(parsed.output.baseSessionId);
  const baseHeadSha = parseGitSha(parsed.output.baseHeadSha);
  const headSha = parseGitSha(parsed.output.headSha);
  const createdAt = parseIsoTimestamp(parsed.output.createdAt);
  if (baseSessionId._tag === "err" || baseHeadSha._tag === "err" || headSha._tag === "err" || createdAt._tag === "err") return err({ _tag: "InvalidRevisionComparison" });
  const commits: Array<ComparedCommit> = [];
  for (const commit of parsed.output.commits) {
    const sha = parseGitSha(commit.sha);
    const authoredAt = parseIsoTimestamp(commit.authoredAt);
    if (sha._tag === "err" || authoredAt._tag === "err") return err({ _tag: "InvalidRevisionComparison" });
    commits.push({ ...commit, sha: sha.value, authoredAt: authoredAt.value });
  }
  const files: Array<ComparedFile> = parsed.output.files.map((file) => ({
    path: file.path,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    textPatchAvailable: file.textPatchAvailable,
  }));
  return ok({ ...parsed.output, baseSessionId: baseSessionId.value, baseHeadSha: baseHeadSha.value, headSha: headSha.value, commits, files, createdAt: createdAt.value });
}
