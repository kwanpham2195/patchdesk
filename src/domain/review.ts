import * as v from "valibot";

import {
  createReviewId,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ContentHash,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type GitSha,
  type IsoTimestamp,
  type PullRequestNumber,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "./ids";
import { err, ok, type Result } from "./result";

export { createReviewId, parseReviewId } from "./ids";
export type { ReviewId } from "./ids";

export type ReviewIdentity = {
  readonly profileId: WorkspaceProfileId;
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly prNumber: PullRequestNumber;
};

export type RepresentedRemoteState = {
  readonly headSha: GitSha;
  readonly pullRequestUpdatedAt: IsoTimestamp;
  readonly snapshotHash: ContentHash;
  readonly refreshedAt: IsoTimestamp;
};

export type DetectedRemoteUpdate = {
  readonly detectedAt: IsoTimestamp;
  readonly reason: "head" | "pull_request" | "checks";
};

export type ReviewStatus =
  | { readonly _tag: "Open" }
  | {
      readonly _tag: "Terminal";
      readonly state: "merged" | "closed";
      readonly observedAt: IsoTimestamp;
    };

export type Review = {
  readonly schemaVersion: 1;
  readonly id: ReviewId;
  readonly identity: ReviewIdentity;
  readonly currentSessionId: ReviewSessionId;
  readonly currentHeadSha: GitSha;
  readonly representedRemote?: RepresentedRemoteState;
  readonly detectedUpdate?: DetectedRemoteUpdate;
  readonly status: ReviewStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

export type InvalidReview = { readonly _tag: "InvalidReview" };

const reviewSchema = v.strictObject({
  schemaVersion: v.literal(1),
  id: v.string(),
  identity: v.strictObject({
    profileId: v.string(),
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    prNumber: v.number(),
  }),
  currentSessionId: v.string(),
  currentHeadSha: v.string(),
  representedRemote: v.optional(
    v.strictObject({
      headSha: v.string(),
      pullRequestUpdatedAt: v.string(),
      snapshotHash: v.string(),
      refreshedAt: v.string(),
    }),
  ),
  detectedUpdate: v.optional(
    v.strictObject({
      detectedAt: v.string(),
      reason: v.picklist(["head", "pull_request", "checks"]),
    }),
  ),
  status: v.variant("_tag", [
    v.strictObject({ _tag: v.literal("Open") }),
    v.strictObject({
      _tag: v.literal("Terminal"),
      state: v.picklist(["merged", "closed"]),
      observedAt: v.string(),
    }),
  ]),
  createdAt: v.string(),
  updatedAt: v.string(),
});

type RawReview = v.InferOutput<typeof reviewSchema>;

/** Construct a new open Review whose ID is independent of the current head. */
export function createReview(input: {
  readonly identity: ReviewIdentity;
  readonly currentSessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly createdAt: IsoTimestamp;
}): Review {
  return {
    schemaVersion: 1,
    id: createReviewId(input.identity),
    identity: input.identity,
    currentSessionId: input.currentSessionId,
    currentHeadSha: input.headSha,
    status: { _tag: "Open" },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Advance an open Review to a new immutable session and represented snapshot. */
export function moveReviewToSession(
  review: Review,
  input: {
    readonly sessionId: ReviewSessionId;
    readonly headSha: GitSha;
    readonly representedRemote: RepresentedRemoteState;
    readonly updatedAt: IsoTimestamp;
  },
): Result<Review, { readonly _tag: "ReviewTerminal" }> {
  if (review.status._tag === "Terminal") {
    return err({ _tag: "ReviewTerminal" });
  }

  const { detectedUpdate: previousDetectedUpdate, ...withoutDetectedUpdate } = review;
  void previousDetectedUpdate;
  return ok({
    ...withoutDetectedUpdate,
    currentSessionId: input.sessionId,
    currentHeadSha: input.headSha,
    representedRemote: input.representedRemote,
    updatedAt: laterTimestamp(review.updatedAt, input.updatedAt),
  });
}

/** Mark an open Review terminal; later terminal transitions are harmless. */
export function markReviewTerminal(
  review: Review,
  state: "merged" | "closed",
  observedAt: IsoTimestamp,
): Review {
  if (review.status._tag === "Terminal") {
    return review;
  }

  return {
    ...review,
    status: { _tag: "Terminal", state, observedAt },
    updatedAt: laterTimestamp(review.updatedAt, observedAt),
  };
}

/** Record remote activity without replacing the represented remote snapshot. */
export function markDetectedUpdate(
  review: Review,
  update: DetectedRemoteUpdate,
  updatedAt: IsoTimestamp,
): Review {
  if (review.status._tag === "Terminal") {
    return review;
  }

  return { ...review, detectedUpdate: update, updatedAt: laterTimestamp(review.updatedAt, updatedAt) };
}

function laterTimestamp(previous: IsoTimestamp, requested: IsoTimestamp): IsoTimestamp {
  return Date.parse(requested) > Date.parse(previous)
    ? requested
    : new Date(Date.parse(previous) + 1).toISOString() as IsoTimestamp;
}

/** Parse and validate one persisted Review, including identity-derived ID integrity. */
export function parseReview(input: unknown): Result<Review, InvalidReview> {
  const parsed = v.safeParse(reviewSchema, input);
  if (!parsed.success) return invalid();

  const raw: RawReview = parsed.output;
  const profileId = parseWorkspaceProfileId(raw.identity.profileId);
  const host = parseGitHubHost(raw.identity.host);
  const owner = parseGitHubOwner(raw.identity.owner);
  const repo = parseGitHubRepoName(raw.identity.repo);
  const prNumber = parsePullRequestNumber(raw.identity.prNumber);
  const id = parseReviewId(raw.id);
  const sessionId = parseReviewSessionId(raw.currentSessionId);
  const headSha = parseGitSha(raw.currentHeadSha);
  const createdAt = parseIsoTimestamp(raw.createdAt);
  const updatedAt = parseIsoTimestamp(raw.updatedAt);
  if (
    profileId._tag === "err" ||
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    prNumber._tag === "err" ||
    id._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    createdAt._tag === "err" ||
    updatedAt._tag === "err"
  ) {
    return invalid();
  }

  const identity: ReviewIdentity = {
    profileId: profileId.value,
    host: host.value,
    owner: owner.value,
    repo: repo.value,
    prNumber: prNumber.value,
  };
  if (id.value !== createReviewId(identity)) return invalid();

  const representedRemote = raw.representedRemote;
  const parsedRemote =
    representedRemote === undefined
      ? ok(undefined)
      : parseRepresentedRemote(representedRemote);
  const detectedUpdate = raw.detectedUpdate;
  const parsedUpdate =
    detectedUpdate === undefined ? ok(undefined) : parseDetectedUpdate(detectedUpdate);
  const status = parseStatus(raw.status);
  if (
    parsedRemote._tag === "err" ||
    parsedUpdate._tag === "err" ||
    status._tag === "err"
  ) {
    return invalid();
  }

  return ok({
    schemaVersion: 1,
    id: id.value,
    identity,
    currentSessionId: sessionId.value,
    currentHeadSha: headSha.value,
    ...(parsedRemote.value === undefined
      ? {}
      : { representedRemote: parsedRemote.value }),
    ...(parsedUpdate.value === undefined
      ? {}
      : { detectedUpdate: parsedUpdate.value }),
    status: status.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function parseRepresentedRemote(
  raw: RawReview["representedRemote"] & object,
): Result<RepresentedRemoteState, InvalidReview> {
  const headSha = parseGitSha(raw.headSha);
  const pullRequestUpdatedAt = parseIsoTimestamp(raw.pullRequestUpdatedAt);
  const snapshotHash = parseContentHash(raw.snapshotHash);
  const refreshedAt = parseIsoTimestamp(raw.refreshedAt);
  if (
    headSha._tag === "err" ||
    pullRequestUpdatedAt._tag === "err" ||
    snapshotHash._tag === "err" ||
    refreshedAt._tag === "err"
  ) {
    return invalid();
  }
  return ok({
    headSha: headSha.value,
    pullRequestUpdatedAt: pullRequestUpdatedAt.value,
    snapshotHash: snapshotHash.value,
    refreshedAt: refreshedAt.value,
  });
}

function parseDetectedUpdate(
  raw: RawReview["detectedUpdate"] & object,
): Result<DetectedRemoteUpdate, InvalidReview> {
  const detectedAt = parseIsoTimestamp(raw.detectedAt);
  return detectedAt._tag === "err"
    ? invalid()
    : ok({ detectedAt: detectedAt.value, reason: raw.reason });
}

function parseStatus(raw: RawReview["status"]): Result<ReviewStatus, InvalidReview> {
  if (raw._tag === "Open") return ok({ _tag: "Open" });
  const observedAt = parseIsoTimestamp(raw.observedAt);
  return observedAt._tag === "err"
    ? invalid()
    : ok({ _tag: "Terminal", state: raw.state, observedAt: observedAt.value });
}

function invalid(): Result<never, InvalidReview> {
  return err({ _tag: "InvalidReview" });
}
