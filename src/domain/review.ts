import * as v from "valibot";

import { definedProps } from "./defined-props";
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

/** A complete remote revision proof. Refresh is available only with this evidence. */
export type ObservedRevisionIdentity = {
  readonly headSha: GitSha;
  readonly baseSha: GitSha;
  readonly canonicalPatchHash: ContentHash;
};

export type RevisionUnavailableReason =
  | "base_missing"
  | "diff_incomplete"
  | "github_read"
  | "comparison_ambiguous"
  | "reconciliation_incomplete";

/**
 * Durable authority for remote GitHub writes. A review must be Fresh before
 * any write can proceed. RevisionChanged is intentionally evidence-complete;
 * an incomplete comparison remains Unavailable instead of guessing.
 */
export type ReviewFreshness =
  | { readonly _tag: "Fresh" }
  | {
      readonly _tag: "RevisionChanged";
      readonly detectedAt: IsoTimestamp;
      readonly identity: ObservedRevisionIdentity;
    }
  | {
      readonly _tag: "Unavailable";
      readonly detectedAt: IsoTimestamp;
      readonly reason: RevisionUnavailableReason;
    };

type ReviewStatus =
  | { readonly _tag: "Open" }
  | {
      readonly _tag: "Terminal";
      readonly state: "merged" | "closed";
      readonly observedAt: IsoTimestamp;
    };

export type Review = {
  readonly schemaVersion: 2;
  readonly id: ReviewId;
  readonly identity: ReviewIdentity;
  readonly currentSessionId: ReviewSessionId;
  readonly currentHeadSha: GitSha;
  readonly representedRemote?: RepresentedRemoteState;
  readonly freshness: ReviewFreshness;
  readonly status: ReviewStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

export type InvalidReview = { readonly _tag: "InvalidReview" };

const representedRemoteSchema = v.strictObject({
  headSha: v.string(),
  pullRequestUpdatedAt: v.string(),
  snapshotHash: v.string(),
  refreshedAt: v.string(),
});

const identitySchema = v.strictObject({
  profileId: v.string(),
  host: v.string(),
  owner: v.string(),
  repo: v.string(),
  prNumber: v.number(),
});

const statusSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("Open") }),
  v.strictObject({
    _tag: v.literal("Terminal"),
    state: v.picklist(["merged", "closed"]),
    observedAt: v.string(),
  }),
]);

const observedRevisionIdentitySchema = v.strictObject({
  headSha: v.string(),
  baseSha: v.string(),
  canonicalPatchHash: v.string(),
});

const freshnessSchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("Fresh") }),
  v.strictObject({
    _tag: v.literal("RevisionChanged"),
    detectedAt: v.string(),
    identity: observedRevisionIdentitySchema,
  }),
  v.strictObject({
    _tag: v.literal("Unavailable"),
    detectedAt: v.string(),
    reason: v.picklist([
      "base_missing",
      "diff_incomplete",
      "github_read",
      "comparison_ambiguous",
      "reconciliation_incomplete",
    ]),
  }),
]);

const reviewV2Schema = v.strictObject({
  schemaVersion: v.literal(2),
  id: v.string(),
  identity: identitySchema,
  currentSessionId: v.string(),
  currentHeadSha: v.string(),
  representedRemote: v.optional(representedRemoteSchema),
  freshness: freshnessSchema,
  status: statusSchema,
  createdAt: v.string(),
  updatedAt: v.string(),
});

type RawReviewV2 = v.InferOutput<typeof reviewV2Schema>;

/** Construct a new Review before its initial remote snapshot is available. */
export function createReview(input: {
  readonly identity: ReviewIdentity;
  readonly currentSessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly createdAt: IsoTimestamp;
}): Review {
  return {
    schemaVersion: 2,
    id: createReviewId(input.identity),
    identity: input.identity,
    currentSessionId: input.currentSessionId,
    currentHeadSha: input.headSha,
    freshness: {
      _tag: "Unavailable",
      detectedAt: input.createdAt,
      reason: "reconciliation_incomplete",
    },
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

  return ok({
    ...review,
    currentSessionId: input.sessionId,
    currentHeadSha: input.headSha,
    representedRemote: input.representedRemote,
    freshness: { _tag: "Fresh" },
    updatedAt: laterTimestamp(review.updatedAt, input.updatedAt),
  });
}

/**
 * Adopt a same-revision remote snapshot after canonical identity proof. The
 * immutable session stays unchanged; only GitHub-owned represented state moves.
 */
export function reconcileReviewRemoteState(
  review: Review,
  input: {
    readonly snapshotHash: ContentHash;
    readonly pullRequestUpdatedAt: IsoTimestamp;
    readonly refreshedAt: IsoTimestamp;
  },
): Result<
  Review,
  { readonly _tag: "ReviewTerminal" | "ReviewNotRepresented" }
> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  if (review.representedRemote === undefined)
    return err({ _tag: "ReviewNotRepresented" });
  return ok({
    ...review,
    representedRemote: {
      ...review.representedRemote,
      snapshotHash: input.snapshotHash,
      pullRequestUpdatedAt: input.pullRequestUpdatedAt,
      refreshedAt: input.refreshedAt,
    },
    freshness: { _tag: "Fresh" },
    updatedAt: laterTimestamp(review.updatedAt, input.refreshedAt),
  });
}

/** Record a complete remote revision proof without adopting that revision. */
export function markReviewRevisionChanged(
  review: Review,
  input: {
    readonly detectedAt: IsoTimestamp;
    readonly identity: ObservedRevisionIdentity;
  },
  updatedAt: IsoTimestamp,
): Review {
  if (review.status._tag === "Terminal") return review;
  return {
    ...review,
    freshness: {
      _tag: "RevisionChanged",
      detectedAt: input.detectedAt,
      identity: input.identity,
    },
    updatedAt: laterTimestamp(review.updatedAt, updatedAt),
  };
}

/** Fail closed when Patchdesk cannot prove the remote revision identity. */
export function markReviewUnavailable(
  review: Review,
  input: {
    readonly detectedAt: IsoTimestamp;
    readonly reason: RevisionUnavailableReason;
  },
  updatedAt: IsoTimestamp,
): Review {
  if (review.status._tag === "Terminal") return review;
  return {
    ...review,
    freshness: {
      _tag: "Unavailable",
      detectedAt: input.detectedAt,
      reason: input.reason,
    },
    updatedAt: laterTimestamp(review.updatedAt, updatedAt),
  };
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

function laterTimestamp(
  previous: IsoTimestamp,
  requested: IsoTimestamp,
): IsoTimestamp {
  if (Date.parse(requested) > Date.parse(previous)) return requested;
  // SAFETY: `previous` is already a parsed IsoTimestamp, so `Date.parse(previous)` is a
  // finite number, never NaN; `new Date(finite).toISOString()` always returns the
  // ISO-8601 form IsoTimestamp brands.
  return new Date(Date.parse(previous) + 1).toISOString() as IsoTimestamp;
}

/** Parse persisted Review data under the current durable freshness contract. */
export function parseReview(input: unknown): Result<Review, InvalidReview> {
  const current = v.safeParse(reviewV2Schema, input);
  return current.success ? parseV2Review(current.output) : invalid();
}

function parseV2Review(raw: RawReviewV2): Result<Review, InvalidReview> {
  const base = parseReviewBase(raw);
  if (base._tag === "err") return base;
  const freshness = parseFreshness(raw.freshness);
  if (freshness._tag === "err") return freshness;
  return ok({ ...base.value, schemaVersion: 2, freshness: freshness.value });
}

function parseReviewBase(
  raw: Pick<
    RawReviewV2,
    | "id"
    | "identity"
    | "currentSessionId"
    | "currentHeadSha"
    | "representedRemote"
    | "status"
    | "createdAt"
    | "updatedAt"
  >,
): Result<Omit<Review, "schemaVersion" | "freshness">, InvalidReview> {
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

  const representedRemote =
    raw.representedRemote === undefined
      ? ok(undefined)
      : parseRepresentedRemote(raw.representedRemote);
  const status = parseStatus(raw.status);
  if (representedRemote._tag === "err" || status._tag === "err")
    return invalid();

  return ok({
    id: id.value,
    identity,
    currentSessionId: sessionId.value,
    currentHeadSha: headSha.value,
    ...definedProps({ representedRemote: representedRemote.value }),
    status: status.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function parseRepresentedRemote(
  raw: RawReviewV2["representedRemote"] & object,
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

function parseFreshness(
  raw: RawReviewV2["freshness"],
): Result<ReviewFreshness, InvalidReview> {
  if (raw._tag === "Fresh") return ok({ _tag: "Fresh" });
  const detectedAt = parseIsoTimestamp(raw.detectedAt);
  if (detectedAt._tag === "err") return invalid();
  if (raw._tag === "Unavailable") {
    return ok({
      _tag: "Unavailable",
      detectedAt: detectedAt.value,
      reason: raw.reason,
    });
  }
  const headSha = parseGitSha(raw.identity.headSha);
  const baseSha = parseGitSha(raw.identity.baseSha);
  const canonicalPatchHash = parseContentHash(raw.identity.canonicalPatchHash);
  if (
    headSha._tag === "err" ||
    baseSha._tag === "err" ||
    canonicalPatchHash._tag === "err"
  )
    return invalid();
  return ok({
    _tag: "RevisionChanged",
    detectedAt: detectedAt.value,
    identity: {
      headSha: headSha.value,
      baseSha: baseSha.value,
      canonicalPatchHash: canonicalPatchHash.value,
    },
  });
}

function parseStatus(
  raw: RawReviewV2["status"],
): Result<ReviewStatus, InvalidReview> {
  if (raw._tag === "Open") return ok({ _tag: "Open" });
  const observedAt = parseIsoTimestamp(raw.observedAt);
  return observedAt._tag === "err"
    ? invalid()
    : ok({ _tag: "Terminal", state: raw.state, observedAt: observedAt.value });
}

function invalid(): Result<never, InvalidReview> {
  return err({ _tag: "InvalidReview" });
}
