import * as v from "valibot";

import {
  parseContentHash,
  parseFindingId,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  parseRepoRelativePath,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ContentHash,
  type FindingId,
  type GitSha,
  type InsightRunId,
  type IsoTimestamp,
  type RepoRelativePath,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "./ids";
import { err, ok, type Result } from "./result";

/** One file an Apply changes, with the sha256 of its bytes before and after. */
export type LocalApplyFile = {
  readonly path: RepoRelativePath;
  readonly preImageSha256: ContentHash;
  readonly postImageSha256: ContentHash;
};

/**
 * `Requested` is the durable intent before `git apply` can start;
 * `OutcomeUnknown` is written immediately before it runs; `CheckRequired` is
 * a recovery that found files at neither image; `Confirmed` is every file at
 * its post-image (ADR 0050 "Operations and recovery").
 */
type LocalApplyState =
  | "Requested"
  | "OutcomeUnknown"
  | "CheckRequired"
  | "Confirmed";

/** The Apply suggestion write on a working-tree local Review. */
export type LocalApplyOperation = {
  readonly schemaVersion: 1;
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly analysisRunId: InsightRunId;
  readonly findingIds: ReadonlyArray<FindingId>;
  readonly files: ReadonlyArray<LocalApplyFile>;
  readonly state: LocalApplyState;
  readonly requestedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

export type LocalApplyRecoveryDecision =
  | "confirmed"
  | "not_applied"
  | "check_required";

/**
 * Recovery reads file hashes only and never applies again. `observed` holds
 * each file's current sha256 in `files` order, undefined when it could not be
 * read.
 */
export function decideLocalApplyRecovery(
  files: ReadonlyArray<LocalApplyFile>,
  observed: ReadonlyArray<ContentHash | undefined>,
): LocalApplyRecoveryDecision {
  if (observed.length !== files.length) return "check_required";
  if (files.every((file, index) => observed[index] === file.postImageSha256))
    return "confirmed";
  if (files.every((file, index) => observed[index] === file.preImageSha256))
    return "not_applied";
  return "check_required";
}

const localApplyOperationSchema = v.strictObject({
  schemaVersion: v.literal(1),
  profileId: v.string(),
  reviewId: v.string(),
  sessionId: v.string(),
  headSha: v.string(),
  analysisRunId: v.string(),
  findingIds: v.pipe(v.array(v.string()), v.minLength(1)),
  files: v.pipe(
    v.array(
      v.strictObject({
        path: v.string(),
        preImageSha256: v.string(),
        postImageSha256: v.string(),
      }),
    ),
    v.minLength(1),
  ),
  state: v.picklist([
    "Requested",
    "OutcomeUnknown",
    "CheckRequired",
    "Confirmed",
  ]),
  requestedAt: v.string(),
  updatedAt: v.string(),
});

export type InvalidLocalApplyOperation = {
  readonly _tag: "InvalidLocalApplyOperation";
};

/** Parse a stored Apply operation; anything malformed fails closed. */
export function parseLocalApplyOperation(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON Apply-operation I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): Result<LocalApplyOperation, InvalidLocalApplyOperation> {
  const raw = v.safeParse(localApplyOperationSchema, input);
  if (!raw.success) return invalid();
  const profileId = parseWorkspaceProfileId(raw.output.profileId);
  const reviewId = parseReviewId(raw.output.reviewId);
  const sessionId = parseReviewSessionId(raw.output.sessionId);
  const headSha = parseGitSha(raw.output.headSha);
  const analysisRunId = parseInsightRunId(raw.output.analysisRunId);
  const requestedAt = parseIsoTimestamp(raw.output.requestedAt);
  const updatedAt = parseIsoTimestamp(raw.output.updatedAt);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    analysisRunId._tag === "err" ||
    requestedAt._tag === "err" ||
    updatedAt._tag === "err"
  )
    return invalid();
  const findingIds: FindingId[] = [];
  for (const candidate of raw.output.findingIds) {
    const findingId = parseFindingId(candidate);
    if (findingId._tag === "err") return invalid();
    findingIds.push(findingId.value);
  }
  const files: LocalApplyFile[] = [];
  for (const candidate of raw.output.files) {
    const path = parseRepoRelativePath(candidate.path);
    const preImageSha256 = parseContentHash(candidate.preImageSha256);
    const postImageSha256 = parseContentHash(candidate.postImageSha256);
    if (
      path._tag === "err" ||
      preImageSha256._tag === "err" ||
      postImageSha256._tag === "err"
    )
      return invalid();
    files.push({
      path: path.value,
      preImageSha256: preImageSha256.value,
      postImageSha256: postImageSha256.value,
    });
  }
  return ok({
    schemaVersion: 1,
    profileId: profileId.value,
    reviewId: reviewId.value,
    sessionId: sessionId.value,
    headSha: headSha.value,
    analysisRunId: analysisRunId.value,
    findingIds,
    files,
    state: raw.output.state,
    requestedAt: requestedAt.value,
    updatedAt: updatedAt.value,
  });
}

function invalid(): Result<never, InvalidLocalApplyOperation> {
  return err({ _tag: "InvalidLocalApplyOperation" });
}
