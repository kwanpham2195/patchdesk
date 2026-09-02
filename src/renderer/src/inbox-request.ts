import type { Profile, Repo } from "./renderer-models";
import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "./inbox-view-preferences";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  type InboxCheckStatusFilter,
  type InboxPageSize,
  type InboxReviewStateFilter,
  type InboxStateFilter,
} from "../../domain/maintainer-inbox";
import {
  sameRepositoryIdentity,
  type RepositoryIdentity,
} from "../../domain/repository-identity";

export type InboxRequestState = {
  /**
   * The Selected repository, sent explicitly once known. Absent only for the
   * renderer's bootstrap request, before the active profile's watchlist is
   * known — the main process resolves the active profile and falls back to
   * its first watched repository in that case. Every other request explicitly
   * sends the repository the picker has selected, resolved by
   * `resolveInboxRepository` from the stored preference and the current
   * watchlist.
   */
  readonly repository?: Repo;
  readonly state: InboxStateFilter;
  readonly pageSize: InboxPageSize;
  /** The label filter, sent as repeated `label` qualifiers.
   * Repository-scoped: `changeInboxRepository` always resets it to `[]`,
   * since a label chosen in one repository may not exist in the next. */
  readonly selectedLabels: ReadonlyArray<string>;
  /** The "Awaiting review from you" preset (ADR 0031), sent as
   * `awaitingMyReview=1`. Unlike `selectedLabels` it is not
   * repository-scoped, so `changeInboxRepository` carries it over. */
  readonly awaitingMyReview: boolean;
  /** The optional GitHub `review:<value>` qualifier. Portable across repositories. */
  readonly reviewState?: InboxReviewStateFilter;
  /** The optional GitHub `status:<value>` qualifier. Portable across repositories. */
  readonly checkStatus?: InboxCheckStatusFilter;
  /** The optional GitHub `author:<value>` qualifier — one login, or `@me`.
   * Portable across repositories: a login means the same thing in each. */
  readonly author?: string;
  /** The optional GitHub `base:<value>` qualifier — one base branch name.
   * Portable across repositories, the same way `author` is. */
  readonly baseBranch?: string;
  readonly pageToken?: string;
  readonly previousPageTokens: ReadonlyArray<string | undefined>;
};

/**
 * Resolves the Selected repository (the screen's root state, see ADR 0031)
 * from the profile's current watchlist and the last repository stored in
 * preferences: the stored repository if it is still watched, otherwise the
 * first watched repository, or `undefined` when the watchlist is empty.
 */
export function resolveInboxRepository(
  watchlist: ReadonlyArray<Repo>,
  stored: RepositoryIdentity | undefined,
): Repo | undefined {
  const kept =
    stored === undefined
      ? undefined
      : watchlist.find((candidate) =>
          sameRepositoryIdentity(candidate, stored),
        );
  return kept ?? watchlist[0];
}

/**
 * Builds the next inbox request from the current one. Each caller states only
 * what it changes; every field it does not name carries over, and the page
 * cursor resets — a cursor minted under a different repository, state, page
 * size, label, review, check, author, or base-branch filter belongs to a
 * different GitHub search and is rejected as `invalid_page`, so carrying one
 * forward could only produce a failed read. The two paging callers are the
 * exception and name `pageToken` and
 * `previousPageTokens` themselves.
 *
 * `repository` is honoured by key presence rather than by value: passing
 * `{ repository: undefined }` clears it, which the bootstrap request and an
 * emptied watchlist both need, while omitting the key keeps the current one.
 * The four optional filters — `reviewState`, `checkStatus`, `author`, and
 * `baseBranch` — are honoured the same way, so each can be cleared explicitly.
 */
export function nextInboxRequest(
  current: InboxRequestState,
  overrides: {
    readonly repository?: Repo | undefined;
    readonly state?: InboxStateFilter;
    readonly pageSize?: InboxPageSize;
    readonly selectedLabels?: ReadonlyArray<string>;
    readonly awaitingMyReview?: boolean;
    readonly reviewState?: InboxReviewStateFilter | undefined;
    readonly checkStatus?: InboxCheckStatusFilter | undefined;
    readonly author?: string | undefined;
    readonly baseBranch?: string | undefined;
    readonly pageToken?: string | undefined;
    readonly previousPageTokens?: ReadonlyArray<string | undefined>;
  } = {},
): InboxRequestState {
  const repository = Object.hasOwn(overrides, "repository")
    ? overrides.repository
    : current.repository;
  const repositoryField = repository === undefined ? {} : { repository };
  const pageTokenField =
    overrides.pageToken === undefined ? {} : { pageToken: overrides.pageToken };
  const reviewState = Object.hasOwn(overrides, "reviewState")
    ? overrides.reviewState
    : current.reviewState;
  const reviewStateField = reviewState === undefined ? {} : { reviewState };
  const checkStatus = Object.hasOwn(overrides, "checkStatus")
    ? overrides.checkStatus
    : current.checkStatus;
  const checkStatusField = checkStatus === undefined ? {} : { checkStatus };
  const author = Object.hasOwn(overrides, "author")
    ? overrides.author
    : current.author;
  const authorField = author === undefined ? {} : { author };
  const baseBranch = Object.hasOwn(overrides, "baseBranch")
    ? overrides.baseBranch
    : current.baseBranch;
  const baseBranchField = baseBranch === undefined ? {} : { baseBranch };
  return {
    ...repositoryField,
    ...pageTokenField,
    state: overrides.state ?? current.state,
    pageSize: overrides.pageSize ?? current.pageSize,
    selectedLabels: overrides.selectedLabels ?? current.selectedLabels,
    awaitingMyReview: overrides.awaitingMyReview ?? current.awaitingMyReview,
    ...reviewStateField,
    ...checkStatusField,
    ...authorField,
    ...baseBranchField,
    previousPageTokens: overrides.previousPageTokens ?? [],
  };
}

/**
 * True when two requests would ask GitHub for the same rows.
 *
 * Every field that changes the answer is compared, because any of them
 * leaves the displayed rows describing the previous request until the new
 * one lands. Comparing the response instead cannot work: it echoes only the
 * state filter and the page size, and says nothing about the label filter,
 * the "Awaiting review from you" preset, review state, check status, author,
 * or base branch, so a label change looked identical to no change at all.
 */
export function sameInboxRows(
  left: InboxRequestState,
  right: InboxRequestState,
): boolean {
  return (
    sameRepositoryIdentity(left.repository, right.repository) &&
    left.state === right.state &&
    left.pageSize === right.pageSize &&
    left.awaitingMyReview === right.awaitingMyReview &&
    left.reviewState === right.reviewState &&
    left.checkStatus === right.checkStatus &&
    left.author === right.author &&
    left.baseBranch === right.baseBranch &&
    left.pageToken === right.pageToken &&
    left.selectedLabels.length === right.selectedLabels.length &&
    left.selectedLabels.every(
      (label, index) => label === right.selectedLabels[index],
    )
  );
}

export const firstInboxRequest: InboxRequestState = {
  state: "open",
  pageSize: DEFAULT_INBOX_PAGE_SIZE,
  selectedLabels: [],
  awaitingMyReview: false,
  previousPageTokens: [],
};

/**
 * Guesses the request to build the very first inbox fetch from, before the
 * true active profile is confirmed. `profiles[0]` matches the main
 * process's own fallback (`DashboardController.activeProfile`) whenever no
 * profile has ever been explicitly selected — the common case, and the only
 * one this needs to get right up front. A wrong guess (an explicitly
 * selected, non-first profile) still self-corrects once the real active
 * profile is confirmed — see the `dashboard?.profile.id` effect below — so
 * getting it wrong here costs one extra refetch, not incorrect data. The
 * repository is deliberately left unset: sending one that turns out not to
 * belong to the true active profile's watchlist fails the whole request
 * server-side (`DashboardController.inboxForActiveProfile`), which a wrong
 * page-size guess never does.
 */
export function firstInboxRequestFor(
  profiles: ReadonlyArray<Profile>,
): InboxRequestState {
  const profileId = profiles[0]?.id;
  if (profileId === undefined) return firstInboxRequest;
  const {
    state,
    pageSize,
    selectedLabels,
    awaitingMyReview,
    reviewState,
    checkStatus,
    author,
    baseBranch,
  } = loadInboxViewPreferences(profileId);
  const reviewStateField = reviewState === undefined ? {} : { reviewState };
  const checkStatusField = checkStatus === undefined ? {} : { checkStatus };
  const authorField = author === undefined ? {} : { author };
  const baseBranchField = baseBranch === undefined ? {} : { baseBranch };
  return {
    state,
    pageSize,
    selectedLabels,
    awaitingMyReview,
    ...reviewStateField,
    ...checkStatusField,
    ...authorField,
    ...baseBranchField,
    previousPageTokens: [],
  };
}

/** Builds the renderer-owned inbox URL without decoding the opaque page token. */
export function inboxRequestPath(request: InboxRequestState): string {
  const query = new URLSearchParams({
    state: request.state,
    pageSize: String(request.pageSize),
  });
  if (request.repository !== undefined) {
    query.set("host", request.repository.host);
    query.set("owner", request.repository.owner);
    query.set("repo", request.repository.repo);
  }
  for (const label of request.selectedLabels) query.append("label", label);
  if (request.awaitingMyReview) query.set("awaitingMyReview", "1");
  if (request.reviewState !== undefined)
    query.set("reviewState", request.reviewState);
  if (request.checkStatus !== undefined)
    query.set("checkStatus", request.checkStatus);
  if (request.author !== undefined) query.set("author", request.author);
  if (request.baseBranch !== undefined) query.set("base", request.baseBranch);
  if (request.pageToken !== undefined) query.set("page", request.pageToken);
  return `/v1/inbox?${query.toString()}`;
}

/**
 * Re-validates a request's repository against a freshly fetched profile
 * list before the request is sent — a repository the profile no longer
 * watches (removed in Settings while the screen still held it) would
 * otherwise be sent as-is and hard-rejected by `GET /v1/inbox`. Resetting
 * the cursor and clearing the label filter mirror an explicit picker change
 * (see `resolveInboxRepository`'s doc comment) because, from the request's
 * point of view, this is the same kind of change.
 *
 * Only meaningful once the active profile is already known and unchanged.
 * A profile switch resets the request to `firstInboxRequest` beforehand and
 * never reaches here with a non-bootstrap `base`; the repository for that
 * case is corrected afterward instead, once the new active profile is
 * confirmed (see the `dashboard?.profile.id` effect below).
 */
export function reconcileInboxRepository(
  base: InboxRequestState,
  profiles: ReadonlyArray<Profile>,
  activeProfileId: string | undefined,
): InboxRequestState {
  const profile = profiles.find(
    (candidate) => candidate.id === activeProfileId,
  );
  if (profile === undefined) return base;
  const repository = resolveInboxRepository(
    profile.repos ?? [],
    loadInboxViewPreferences(profile.id).selectedRepository,
  );
  if (sameRepositoryIdentity(repository, base.repository)) return base;
  const selectedRepositoryField =
    repository === undefined ? {} : { selectedRepository: repository };
  saveInboxViewPreferences(profile.id, {
    ...selectedRepositoryField,
    selectedLabels: [],
  });
  return nextInboxRequest(base, { repository, selectedLabels: [] });
}
