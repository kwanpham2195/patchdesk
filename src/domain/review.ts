import * as v from "valibot";

import {
  agentRunRequestSchema,
  agentRunRequestsOnSession,
  parseStoredAgentRunRequests,
  type AgentRunRequest,
} from "./agent-run-request";
import {
  parseChangeIntent,
  storedChangeIntentSchema,
  sameChangeIntent,
  type ChangeIntent,
} from "./change-intent";
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
  type FindingId,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type GitSha,
  type InsightRunId,
  type IsoTimestamp,
  type LocalNoteId,
  type PullRequestNumber,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "./ids";
import {
  isLocalDraftOf,
  isMaintainerNote,
  parseStoredLocalDrafts,
  storedLocalDraftSchema,
  type LocalDraft,
  type LocalDraftTarget,
  type MaintainerNote,
} from "./local-draft";
import { err, ok, type Result } from "./result";
import type { ReviewSessionKey } from "./review-session";
import {
  parseStoredLocalReviewSource,
  sameReviewSource,
  storedLocalReviewSourceSchema,
  type LocalReviewSource,
  type PullRequestReviewSource,
  type ReviewSource,
} from "./review-source";

/**
 * What one Review is keyed by: the profile repository and its Review source
 * (ADR 0050 "Identity"). `Source` narrows the kind for code that serves only
 * one, such as `PullRequestReviewIdentity`.
 */
export type ReviewIdentity<Source extends ReviewSource = ReviewSource> = {
  readonly profileId: WorkspaceProfileId;
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly source: Source;
};

/** The wire form of a request that names one Review and nothing else. */
export const reviewRequestSchema = v.strictObject({
  profileId: v.pipe(v.string(), v.minLength(1)),
  reviewId: v.pipe(v.string(), v.minLength(1)),
});

/** The identity of a Review on a GitHub pull request. */
export type PullRequestReviewIdentity = ReviewIdentity<PullRequestReviewSource>;

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

export type Review<Source extends ReviewSource = ReviewSource> = {
  readonly schemaVersion: 2;
  readonly id: ReviewId;
  readonly identity: ReviewIdentity<Source>;
  readonly currentSessionId: ReviewSessionId;
  readonly currentHeadSha: GitSha;
  readonly representedRemote?: RepresentedRemoteState;
  readonly freshness: ReviewFreshness;
  readonly status: ReviewStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  /**
   * What a sidebar row of visited pull requests shows. Both stay on
   * schemaVersion 2: there is no migration framework, so bumping the version
   * would send every record already on disk to quarantine. The price is
   * one-directional — `reviewV2Schema` is a `strictObject`, so an older build
   * refuses to parse a record this build writes, and there is no downgrade
   * path back to a build that predates these fields.
   */
  readonly title?: string;
  readonly lastOpenedAt?: IsoTimestamp;
  /** What the maintainer had in front of them when they last left this Review. */
  readonly lastLooked?: LastLooked;
  /** A local Review's draft list (ADR 0050); never present on a pull request Review, absent when empty. */
  readonly localDrafts?: ReadonlyArray<LocalDraft>;
  /** A local Review's Change intent (#467); never present on a pull request Review. Every move to a new session keeps it. */
  readonly changeIntent?: ChangeIntent;
  /**
   * A local Review's session an agent's `refresh_review` prepared and the
   * maintainer has not moved to yet (ADR 0052); the move clears it.
   */
  readonly preparedSessionId?: ReviewSessionId;
  /** A local Review's agent run requests for its current session (ADR 0052); a move drops the rest, absent when empty. */
  readonly agentRunRequests?: ReadonlyArray<AgentRunRequest>;
};

/**
 * `seenThrough` is GitHub's newest entry timestamp the maintainer was shown,
 * never this machine's clock; it is absent when no timestamped entry was shown.
 */
type LastLooked = {
  readonly headSha: GitSha;
  readonly seenThrough?: IsoTimestamp;
};

/** A Review on a GitHub pull request; the only kind GitHub reads and writes serve. */
export type PullRequestReview = Review<PullRequestReviewSource>;

/** Narrow a Review to the pull request kind before any GitHub read or write. */
export function isPullRequestReview(
  review: Review,
): review is PullRequestReview {
  return review.identity.source.kind === "pull_request";
}

/** Narrow a Review to a local source, which is read from the checkout and never from GitHub. */
export function isLocalReview(
  review: Review,
): review is Review<LocalReviewSource> {
  return review.identity.source.kind !== "pull_request";
}

export type InvalidReview = { readonly _tag: "InvalidReview" };

const representedRemoteSchema = v.strictObject({
  headSha: v.string(),
  pullRequestUpdatedAt: v.string(),
  snapshotHash: v.string(),
  refreshedAt: v.string(),
});

/**
 * A pull request identity is stored flat with `prNumber` and no `source`,
 * exactly as before ADR 0050, so records already on disk load unchanged and
 * there is one stored form per kind. `serializeReview` writes the same form.
 */
const identitySchema = v.union([
  v.strictObject({
    profileId: v.string(),
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    prNumber: v.number(),
  }),
  v.strictObject({
    profileId: v.string(),
    host: v.string(),
    owner: v.string(),
    repo: v.string(),
    source: storedLocalReviewSourceSchema,
  }),
]);

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
  title: v.optional(v.string()),
  lastOpenedAt: v.optional(v.string()),
  lastLooked: v.optional(
    v.strictObject({
      headSha: v.string(),
      seenThrough: v.optional(v.string()),
    }),
  ),
  localDrafts: v.optional(v.array(storedLocalDraftSchema)),
  changeIntent: v.optional(storedChangeIntentSchema),
  preparedSessionId: v.optional(v.string()),
  agentRunRequests: v.optional(v.array(agentRunRequestSchema)),
});

type RawReviewV2 = v.InferOutput<typeof reviewV2Schema>;

/**
 * True when `session` is the exact revision the Review currently represents:
 * same profile, same Review source, and the Review's current head SHA.
 *
 * Every write precondition in the app compares these same six fields before
 * it lets a caller touch GitHub or durable review state, so they are compared
 * in one place. A caller that also needs `session.id` to equal
 * `review.currentSessionId` checks that itself: session identity is a
 * separate fact from the revision this function compares.
 */
export function sessionRepresentsReview(
  review: Pick<Review, "identity" | "currentHeadSha">,
  session: { readonly key: ReviewSessionKey },
): boolean {
  return (
    session.key.profileId === review.identity.profileId &&
    session.key.host === review.identity.host &&
    session.key.owner === review.identity.owner &&
    session.key.repo === review.identity.repo &&
    sameReviewSource(session.key.source, review.identity.source) &&
    session.key.headSha === review.currentHeadSha
  );
}

/** Construct a new Review before its initial remote snapshot is available. */
export function createReview<Source extends ReviewSource>(input: {
  readonly identity: ReviewIdentity<Source>;
  readonly currentSessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly createdAt: IsoTimestamp;
}): Review<Source> {
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
 * Point a local Review at the session its source just resolved to. Opening
 * recomputed that revision from the checkout, so the Review is Fresh; a local
 * Review has no represented GitHub snapshot. `localDrafts` replaces the list
 * with the drafts carried to that session.
 */
export function moveLocalReviewToSession(
  review: Review<LocalReviewSource>,
  input: {
    readonly sessionId: ReviewSessionId;
    readonly headSha: GitSha;
    readonly updatedAt: IsoTimestamp;
    readonly localDrafts?: ReadonlyArray<LocalDraft>;
  },
): Result<Review<LocalReviewSource>, { readonly _tag: "ReviewTerminal" }> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  const { preparedSessionId: _moved, agentRunRequests, ...rest } = review;
  return ok({
    ...rest,
    currentSessionId: input.sessionId,
    currentHeadSha: input.headSha,
    freshness: { _tag: "Fresh" },
    updatedAt: laterTimestamp(review.updatedAt, input.updatedAt),
    ...definedProps({
      localDrafts: input.localDrafts ?? review.localDrafts,
      agentRunRequests: agentRunRequestsOnSession(
        agentRunRequests,
        input.sessionId,
      ),
    }),
  });
}

/**
 * Record the session an agent's refresh prepared without moving the Review
 * to it (ADR 0052): the Review reads RevisionChanged with that session's
 * revision, so the header shows Updates available and Apply waits until the
 * maintainer's Refresh moves it.
 */
export function recordPreparedLocalSession(
  review: Review<LocalReviewSource>,
  prepared: {
    readonly sessionId: ReviewSessionId;
    readonly identity: ObservedRevisionIdentity;
    readonly detectedAt: IsoTimestamp;
  },
): Result<Review<LocalReviewSource>, { readonly _tag: "ReviewTerminal" }> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  return ok({
    ...review,
    preparedSessionId: prepared.sessionId,
    freshness: {
      _tag: "RevisionChanged",
      detectedAt: prepared.detectedAt,
      identity: prepared.identity,
    },
    updatedAt: laterTimestamp(review.updatedAt, prepared.detectedAt),
  });
}

/**
 * Record that the maintainer opened this pull request, for the sidebar's
 * visited rows. There is no Terminal guard: opening a merged or closed pull
 * request is a legitimate gesture, so this returns a plain Review.
 */
export function markReviewOpened(
  review: Review,
  input: {
    readonly title?: string | undefined;
    readonly now: IsoTimestamp;
  },
): Review {
  return {
    ...review,
    // An open with no title in hand keeps the title already recorded.
    ...definedProps({ title: input.title }),
    lastOpenedAt: input.now,
    updatedAt: laterTimestamp(review.updatedAt, input.now),
  };
}

/**
 * Record what the maintainer saw as they left the Review. `seenThrough` never
 * moves backwards, so leaving a projection with nothing newer keeps the cursor.
 */
export function markReviewLeft(
  review: Review,
  input: {
    readonly headSha: GitSha;
    readonly seenThrough: IsoTimestamp | undefined;
    readonly now: IsoTimestamp;
  },
): Review {
  const previous = review.lastLooked?.seenThrough;
  const seenThrough =
    previous !== undefined &&
    (input.seenThrough === undefined || previous > input.seenThrough)
      ? previous
      : input.seenThrough;
  return {
    ...review,
    lastLooked: { headSha: input.headSha, ...definedProps({ seenThrough }) },
    updatedAt: laterTimestamp(review.updatedAt, input.now),
  };
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

/**
 * Add one Local draft to a local Review's list (ADR 0050, ADR 0051). A Finding
 * already drafted keeps its entry, so adding twice is one draft.
 */
export function addLocalDraft(
  review: Review<LocalReviewSource>,
  draft: LocalDraft,
): Result<Review<LocalReviewSource>, { readonly _tag: "ReviewTerminal" }> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  const drafts = review.localDrafts ?? [];
  const target = isMaintainerNote(draft)
    ? { noteId: draft.noteId }
    : { runId: draft.analysisRunId, findingId: draft.findingId };
  if (drafts.some((entry) => isLocalDraftOf(entry, target))) return ok(review);
  return ok({
    ...review,
    localDrafts: [...drafts, draft],
    updatedAt: laterTimestamp(
      review.updatedAt,
      isMaintainerNote(draft) ? draft.createdAt : draft.addedAt,
    ),
  });
}

/** Replace one maintainer note's text; a Finding draft is never edited (ADR 0051). */
export function editMaintainerNote(
  review: Review<LocalReviewSource>,
  edit: {
    readonly noteId: LocalNoteId;
    readonly text: string;
    readonly updatedAt: IsoTimestamp;
  },
): Result<
  Review<LocalReviewSource>,
  { readonly _tag: "ReviewTerminal" | "NoteNotFound" }
> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  const drafts = review.localDrafts ?? [];
  const note = drafts.find(
    (entry): entry is MaintainerNote =>
      isMaintainerNote(entry) && entry.noteId === edit.noteId,
  );
  if (note === undefined) return err({ _tag: "NoteNotFound" });
  if (note.text === edit.text) return ok(review);
  const updatedAt = laterTimestamp(review.updatedAt, edit.updatedAt);
  return ok({
    ...review,
    localDrafts: drafts.map((entry) =>
      entry === note ? { ...note, text: edit.text, updatedAt } : entry,
    ),
    updatedAt,
  });
}

/**
 * Mark the Finding drafts a confirmed Apply wrote as applied (#452). They stay
 * listed for the maintainer and leave the agent prompt.
 */
export function markLocalDraftsApplied(
  review: Review<LocalReviewSource>,
  applied: {
    readonly runId: InsightRunId;
    readonly findingIds: ReadonlyArray<FindingId>;
    readonly appliedAt: IsoTimestamp;
  },
): Review<LocalReviewSource> {
  const drafts = review.localDrafts ?? [];
  const wrote = (draft: LocalDraft) =>
    !isMaintainerNote(draft) &&
    draft.appliedAt === undefined &&
    applied.findingIds.some((findingId) =>
      isLocalDraftOf(draft, { runId: applied.runId, findingId }),
    );
  if (!drafts.some(wrote)) return review;
  return {
    ...review,
    localDrafts: drafts.map((draft) =>
      wrote(draft) ? { ...draft, appliedAt: applied.appliedAt } : draft,
    ),
    updatedAt: laterTimestamp(review.updatedAt, applied.appliedAt),
  };
}

/** Set or clear a local Review's Change intent; setting the one it holds changes nothing. */
export function setChangeIntent(
  review: Review<LocalReviewSource>,
  intent: ChangeIntent | undefined,
  updatedAt: IsoTimestamp,
): Result<Review<LocalReviewSource>, { readonly _tag: "ReviewTerminal" }> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  if (sameChangeIntent(review.changeIntent, intent)) return ok(review);
  const { changeIntent: _replaced, ...rest } = review;
  return ok({
    ...rest,
    ...definedProps({ changeIntent: intent }),
    updatedAt: laterTimestamp(review.updatedAt, updatedAt),
  });
}

/** Replace a local Review's agent run requests (ADR 0052). */
export function setAgentRunRequests(
  review: Review<LocalReviewSource>,
  requests: ReadonlyArray<AgentRunRequest>,
  updatedAt: IsoTimestamp,
): Result<Review<LocalReviewSource>, { readonly _tag: "ReviewTerminal" }> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  const { agentRunRequests: _replaced, ...rest } = review;
  return ok({
    ...rest,
    ...definedProps({
      agentRunRequests: requests.length === 0 ? undefined : requests,
    }),
    updatedAt: laterTimestamp(review.updatedAt, updatedAt),
  });
}

/** Remove one Local draft; removing a draft that is not listed changes nothing. */
export function removeLocalDraft(
  review: Review<LocalReviewSource>,
  target: LocalDraftTarget,
  updatedAt: IsoTimestamp,
): Result<Review<LocalReviewSource>, { readonly _tag: "ReviewTerminal" }> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  const drafts = review.localDrafts ?? [];
  const kept = drafts.filter((entry) => !isLocalDraftOf(entry, target));
  if (kept.length === drafts.length) return ok(review);
  const { localDrafts: _removed, ...rest } = review;
  return ok({
    ...rest,
    ...definedProps({ localDrafts: kept.length === 0 ? undefined : kept }),
    updatedAt: laterTimestamp(review.updatedAt, updatedAt),
  });
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

/**
 * The stored form of a Review, the inverse of `parseReview`. A pull request
 * identity is written flat with `prNumber`, the form records had before local
 * sources existed; a local identity is written with its `source`.
 */
export function serializeReview(review: Review): StoredReview {
  const { source, ...repository } = review.identity;
  return {
    ...review,
    identity:
      source.kind === "pull_request"
        ? { ...repository, prNumber: source.prNumber }
        : { ...repository, source },
  };
}

/** The JSON a Review store writes; only `serializeReview` builds it. */
export type StoredReview = Omit<Review, "identity"> & {
  readonly identity:
    | (Omit<ReviewIdentity, "source"> & {
        readonly prNumber: PullRequestNumber;
      })
    | ReviewIdentity<LocalReviewSource>;
};

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
    | "title"
    | "lastOpenedAt"
    | "lastLooked"
    | "localDrafts"
    | "changeIntent"
    | "preparedSessionId"
    | "agentRunRequests"
  >,
): Result<Omit<Review, "schemaVersion" | "freshness">, InvalidReview> {
  const profileId = parseWorkspaceProfileId(raw.identity.profileId);
  const host = parseGitHubHost(raw.identity.host);
  const owner = parseGitHubOwner(raw.identity.owner);
  const repo = parseGitHubRepoName(raw.identity.repo);
  const source = parseStoredIdentitySource(raw.identity);
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
    source._tag === "err" ||
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
    source: source.value,
  };
  if (id.value !== createReviewId(identity)) return invalid();

  const representedRemote =
    raw.representedRemote === undefined
      ? ok(undefined)
      : parseRepresentedRemote(raw.representedRemote);
  const status = parseStatus(raw.status);
  const lastOpenedAt =
    raw.lastOpenedAt === undefined
      ? ok(undefined)
      : parseIsoTimestamp(raw.lastOpenedAt);
  const lastLooked =
    raw.lastLooked === undefined
      ? ok(undefined)
      : parseLastLooked(raw.lastLooked);
  // Drafts belong to a local Review only, and an empty list is stored as no list.
  const localDrafts =
    raw.localDrafts === undefined
      ? ok(undefined)
      : source.value.kind === "pull_request" || raw.localDrafts.length === 0
        ? invalid()
        : parseStoredLocalDrafts(raw.localDrafts);
  const changeIntent =
    raw.changeIntent === undefined
      ? ok(undefined)
      : source.value.kind === "pull_request"
        ? invalid()
        : parseChangeIntent(raw.changeIntent);
  const preparedSessionId =
    raw.preparedSessionId === undefined
      ? ok(undefined)
      : source.value.kind === "pull_request"
        ? invalid()
        : parseReviewSessionId(raw.preparedSessionId);
  const agentRunRequests =
    raw.agentRunRequests === undefined
      ? ok(undefined)
      : source.value.kind === "pull_request"
        ? invalid()
        : parseStoredAgentRunRequests(raw.agentRunRequests);
  if (
    representedRemote._tag === "err" ||
    status._tag === "err" ||
    lastOpenedAt._tag === "err" ||
    lastLooked._tag === "err" ||
    localDrafts._tag === "err" ||
    changeIntent._tag === "err" ||
    preparedSessionId._tag === "err" ||
    agentRunRequests._tag === "err"
  )
    return invalid();

  return ok({
    id: id.value,
    identity,
    currentSessionId: sessionId.value,
    currentHeadSha: headSha.value,
    ...definedProps({
      representedRemote: representedRemote.value,
      title: raw.title,
      lastOpenedAt: lastOpenedAt.value,
      lastLooked: lastLooked.value,
      localDrafts: localDrafts.value,
      changeIntent: changeIntent.value,
      preparedSessionId: preparedSessionId.value,
      agentRunRequests: agentRunRequests.value,
    }),
    status: status.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function parseStoredIdentitySource(
  raw: RawReviewV2["identity"],
): Result<ReviewSource, InvalidReview> {
  if ("prNumber" in raw) {
    const prNumber = parsePullRequestNumber(raw.prNumber);
    return prNumber._tag === "ok"
      ? ok({ kind: "pull_request", prNumber: prNumber.value })
      : invalid();
  }
  const source = parseStoredLocalReviewSource(raw.source);
  return source._tag === "ok" ? source : invalid();
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

function parseLastLooked(
  raw: RawReviewV2["lastLooked"] & object,
): Result<LastLooked, InvalidReview> {
  const headSha = parseGitSha(raw.headSha);
  const seenThrough =
    raw.seenThrough === undefined
      ? ok(undefined)
      : parseIsoTimestamp(raw.seenThrough);
  if (headSha._tag === "err" || seenThrough._tag === "err") return invalid();
  return ok({
    headSha: headSha.value,
    ...definedProps({ seenThrough: seenThrough.value }),
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
