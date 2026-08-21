import type {
  GitHubReviewState,
  PullRequestReviewEntry,
  PullRequestReviewerListing,
  RequestedReviewer,
} from "./github-context";
import type { GitSha, IsoTimestamp } from "./ids";

/**
 * A submitted review's outcome, in the vocabulary a maintainer reads rather
 * than GitHub's shouting-case enum. `PENDING` has no counterpart here — a
 * draft is never a verdict; see `GitHubReviewState`.
 */
export type ReviewVerdictState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed";

function toVerdictState(state: GitHubReviewState): ReviewVerdictState {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      // Unreachable: `deriveReviewVerdicts` drops every `PENDING` entry
      // before a `SubmittedReviewEntry` is ever constructed.
      throw new Error("a PENDING review has no verdict");
  }
}

/**
 * One row of the reviewer rail: a person who is either requested, has a
 * Revision-bound review verdict, or both. `verdict` is absent for a
 * requested reviewer who has not submitted anything — a pending ask is not
 * a silent verdict. `outdated` is only meaningful alongside a `verdict`; it
 * is `false` for a person with no verdict, since there is nothing to be
 * outdated.
 */
export type ReviewerVerdictRow = {
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  /** `data:` URI resolved from the on-disk avatar cache for `avatarUrl`; see `AssignableUser.avatarDataUri` in `github-context.ts` for the full contract. `deriveReviewVerdicts` never sets this (it is pure, no I/O) — only `ReviewerService.list` populates it on the rows this function returns. */
  readonly avatarDataUri?: string;
  readonly verdict?: ReviewVerdictState;
  readonly outdated: boolean;
  readonly submittedAt?: IsoTimestamp;
};

/**
 * Derives each reviewer's Revision-bound review verdict against one
 * represented pull request — see CONTEXT.md, "Revision-bound review
 * verdict" — from the raw reviewer data one `PullRequestReviewerListing`
 * read carries. Pure: no I/O, no rendering, so it is testable on its own
 * (`tests/domain/review-verdicts.test.ts`).
 *
 * Rules:
 * - `latestReviews` is unioned with `reviews`, keyed by login. This union is
 *   not optional: `latestReviews` can omit a person entirely while they hold
 *   an open GitHub pending review, and because Patchdesk's own drafting
 *   model rests on GitHub pending reviews (ADR "Use GitHub pending reviews
 *   for Review drafting", 0014), that is the common path here, not an edge
 *   case — any reviewer with a currently open pending review hits it.
 * - `PENDING` entries are dropped outright — an unfinished draft is never a
 *   verdict, for anyone.
 * - Each person's verdict is their most recent *submitted* entry, compared
 *   by `submittedAt`.
 * - A verdict is outdated when the commit it was submitted against differs
 *   from the represented revision's `headSha`; an entry with no reported
 *   commit is treated as outdated rather than assumed current.
 * - A requested reviewer with no submitted entry appears with no verdict.
 * - A person both requested and previously reviewed keeps their verdict — a
 *   fresh request does not erase what they already said.
 *
 * Ordering is deterministic: submitted verdicts first, most recent first
 * (the most actionable information — "who just weighed in" — leads), then
 * requested-but-not-yet-reviewed reviewers alphabetically by login (there is
 * no recency signal for an unanswered ask, so login order is the only
 * stable one available).
 */
export function deriveReviewVerdicts(
  listing: Pick<
    PullRequestReviewerListing,
    "requested" | "latestReviews" | "reviews"
  >,
  representedHeadSha: GitSha,
): ReadonlyArray<ReviewerVerdictRow> {
  const mostRecentSubmittedByLogin = new Map<string, SubmittedReviewEntry>();
  for (const entry of [...listing.latestReviews, ...listing.reviews]) {
    if (entry.state === "PENDING") continue;
    if (entry.submittedAt === undefined) continue;
    // Rebuilt (not just narrowed by the guard above) so the stored value's
    // own type carries `submittedAt` as required, not optional: the guard's
    // narrowing does not survive into the Map's value type on its own.
    const submitted: SubmittedReviewEntry = {
      ...entry,
      submittedAt: entry.submittedAt,
    };
    const current = mostRecentSubmittedByLogin.get(entry.login);
    if (current === undefined || submitted.submittedAt > current.submittedAt)
      mostRecentSubmittedByLogin.set(entry.login, submitted);
  }

  const requestedByLogin = new Map<string, RequestedReviewer>();
  for (const reviewer of listing.requested)
    requestedByLogin.set(reviewer.login, reviewer);

  const submittedRows = [...mostRecentSubmittedByLogin.values()]
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    .map((entry) =>
      toVerdictRow(
        entry,
        requestedByLogin.get(entry.login),
        representedHeadSha,
      ),
    );

  const notYetReviewed = listing.requested
    .filter((reviewer) => !mostRecentSubmittedByLogin.has(reviewer.login))
    .slice()
    .sort((a, b) => a.login.localeCompare(b.login))
    .map((reviewer) => toRequestedOnlyRow(reviewer));

  return [...submittedRows, ...notYetReviewed];
}

/** A submitted review entry, narrowed to guarantee `submittedAt`; see `deriveReviewVerdicts`'s union step. */
type SubmittedReviewEntry = PullRequestReviewEntry & {
  readonly submittedAt: IsoTimestamp;
};

function toVerdictRow(
  entry: SubmittedReviewEntry,
  requestedInfo: RequestedReviewer | undefined,
  representedHeadSha: GitSha,
): ReviewerVerdictRow {
  let row: ReviewerVerdictRow = {
    login: entry.login,
    verdict: toVerdictState(entry.state),
    outdated:
      entry.commitOid === undefined || entry.commitOid !== representedHeadSha,
    submittedAt: entry.submittedAt,
  };
  const name = requestedInfo?.name;
  if (name !== undefined) row = { ...row, name };
  const avatarUrl = entry.avatarUrl ?? requestedInfo?.avatarUrl;
  if (avatarUrl !== undefined) row = { ...row, avatarUrl };
  return row;
}

function toRequestedOnlyRow(reviewer: RequestedReviewer): ReviewerVerdictRow {
  let row: ReviewerVerdictRow = { login: reviewer.login, outdated: false };
  if (reviewer.name !== undefined) row = { ...row, name: reviewer.name };
  if (reviewer.avatarUrl !== undefined)
    row = { ...row, avatarUrl: reviewer.avatarUrl };
  return row;
}
