import * as v from "valibot";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  INBOX_CHECK_STATUS_FILTER_VALUES,
  INBOX_PAGE_SIZES,
  MAX_INBOX_FILTER_LABELS,
  MAX_INBOX_FILTER_LABEL_LENGTH,
  INBOX_REVIEW_STATE_FILTER_VALUES,
  INBOX_STATE_FILTER_VALUES,
  parseInboxAuthorFilter,
  parseInboxBaseBranchFilter,
  type InboxCheckStatusFilter,
  type InboxFilterTextFailure,
  type InboxPageSize,
  type InboxReviewStateFilter,
  type InboxStateFilter,
} from "../../domain/maintainer-inbox";
import type { RepositoryIdentity } from "../../domain/repository-identity";
import type { Result } from "../../domain/result";
import { definePreference } from "./lib/local-preference";

const inboxStateFilterSchema = v.picklist(INBOX_STATE_FILTER_VALUES);

const inboxPageSizeSchema = v.picklist(INBOX_PAGE_SIZES);

const clipped = (limit: number) =>
  v.pipe(
    v.string(),
    v.transform((value) => value.slice(0, limit)),
  );

const trimmed = (limit: number) =>
  v.pipe(
    v.string(),
    v.transform((value) => value.trim().slice(0, limit)),
    v.minLength(1),
  );

// A stored free-text filter runs the same domain parser the route does, so a
// stale or hand-edited value the server would refuse falls back to absent
// instead of being sent.
const filterText = (
  parse: (value: string) => Result<string, InboxFilterTextFailure>,
) =>
  v.pipe(
    v.string(),
    v.check((value) => parse(value)._tag === "ok"),
    v.transform((value) => value.trim()),
  );

// selectedLabels is the persisted form of the label filter; it is
// bounded the same way the route bounds it (`parseInboxLabelsQuery` in
// local-api.ts) so a stored value that was once valid never grows into one
// the server rejects as `invalid_input`.
const cappedStrings = (max: number, itemLimit: number) =>
  v.pipe(
    v.array(clipped(itemLimit)),
    v.transform((values) => values.slice(0, max)),
  );

const repositoryIdentitySchema = v.object({
  host: trimmed(200),
  owner: trimmed(200),
  repo: trimmed(200),
});

// Every field falls back independently: one stale or hand-edited value resets
// itself instead of discarding the whole stored view.
const preferencesSchema = v.object({
  state: v.fallback(inboxStateFilterSchema, "open"),
  pageSize: v.fallback(inboxPageSizeSchema, DEFAULT_INBOX_PAGE_SIZE),
  selectedLabels: v.fallback(
    cappedStrings(MAX_INBOX_FILTER_LABELS, MAX_INBOX_FILTER_LABEL_LENGTH),
    [],
  ),
  // The "Awaiting review from you" preset (ADR 0031). Unlike selectedLabels
  // it is not repository-scoped — `user-review-requested:@me` means the same
  // thing in every repository — so a repository change carries it over.
  awaitingMyReview: v.fallback(v.boolean(), false),
  reviewState: v.fallback(
    v.optional(v.picklist(INBOX_REVIEW_STATE_FILTER_VALUES)),
    undefined,
  ),
  checkStatus: v.fallback(
    v.optional(v.picklist(INBOX_CHECK_STATUS_FILTER_VALUES)),
    undefined,
  ),
  author: v.fallback(v.optional(filterText(parseInboxAuthorFilter)), undefined),
  baseBranch: v.fallback(
    v.optional(filterText(parseInboxBaseBranchFilter)),
    undefined,
  ),
  inspectorOpen: v.fallback(v.boolean(), true),
  selectedIdentity: v.fallback(v.optional(trimmed(200)), undefined),
  // The Selected repository (see ADR 0031).
  selectedRepository: v.fallback(
    v.optional(repositoryIdentitySchema),
    undefined,
  ),
});

export type InboxViewPreferences = {
  readonly state: InboxStateFilter;
  readonly pageSize: InboxPageSize;
  /** The label filter, sent to GitHub as `label:"NAME"` qualifiers — no
   * longer a local, in-page filter. */
  readonly selectedLabels: ReadonlyArray<string>;
  /** The "Awaiting review from you" preset, sent to GitHub as
   * `user-review-requested:@me`. Not repository-scoped — see the schema. */
  readonly awaitingMyReview: boolean;
  /** The optional GitHub `review:<value>` qualifier. */
  readonly reviewState?: InboxReviewStateFilter;
  /** The optional GitHub `status:<value>` qualifier. */
  readonly checkStatus?: InboxCheckStatusFilter;
  /** The optional GitHub `author:<value>` qualifier — one login, or `@me`. */
  readonly author?: string;
  /** The optional GitHub `base:<value>` qualifier — one base branch name. */
  readonly baseBranch?: string;
  readonly inspectorOpen: boolean;
  readonly selectedIdentity?: string;
  /** The last repository selected from the watchlist, per profile. Falls
   * back to the first watched repository when unset or no longer watched —
   * see `resolveInboxRepository` in `app.tsx`. */
  readonly selectedRepository?: RepositoryIdentity;
};

/**
 * The four More-filters fields. They differ from every other stored field in
 * that an explicitly named `undefined` clears them rather than carrying the
 * stored value over — see `saveInboxViewPreferences`.
 */
type OptionalInboxFilterKey =
  | "reviewState"
  | "checkStatus"
  | "author"
  | "baseBranch";

type InboxViewPreferencesUpdate = Omit<
  Partial<InboxViewPreferences>,
  OptionalInboxFilterKey
> & {
  readonly reviewState?: InboxReviewStateFilter | undefined;
  readonly checkStatus?: InboxCheckStatusFilter | undefined;
  readonly author?: string | undefined;
  readonly baseBranch?: string | undefined;
};

const DEFAULT_INBOX_VIEW_PREFERENCES: InboxViewPreferences = {
  state: "open",
  pageSize: DEFAULT_INBOX_PAGE_SIZE,
  selectedLabels: [],
  awaitingMyReview: false,
  inspectorOpen: true,
};

// Bumping VERSION resets every field to default on an old-version read,
// because only this key and the v1 key are still recognized — v5 dropped the
// queue rail and the in-page search box (ADR 0031), and v6 renamed the stored
// `scope` field to `state`.
const VERSION = 6;

const storedSchema = v.pipe(
  v.object({
    version: v.literal(VERSION),
    preferences: preferencesSchema,
  }),
  v.transform((stored): InboxViewPreferences =>
    preferencesFrom(stored.preferences),
  ),
);

const legacyStoredSchema = v.pipe(
  v.object({
    version: v.literal(1),
    preferences: preferencesSchema,
  }),
  v.transform((stored): InboxViewPreferences => ({
    ...preferencesFrom(stored.preferences),
    state: "open",
  })),
);

const inboxViewPreference = definePreference({
  key: (profileId: string) => `patchdesk.inbox-view.v${VERSION}.${profileId}`,
  schema: storedSchema,
  defaultValue: undefined,
  encodeStored: (value: InboxViewPreferences) => ({
    version: VERSION,
    preferences: value,
  }),
});

const legacyInboxViewPreference = definePreference({
  key: (profileId: string) => `patchdesk.inbox-view.v1.${profileId}`,
  schema: legacyStoredSchema,
  defaultValue: undefined,
});

/** Loads local, profile-scoped presentation choices; malformed values safely reset. */
export function loadInboxViewPreferences(
  profileId: string,
): InboxViewPreferences {
  return (
    inboxViewPreference.load(profileId) ??
    legacyInboxViewPreference.load(profileId) ??
    DEFAULT_INBOX_VIEW_PREFERENCES
  );
}

/** Persists local presentation state and bounded GitHub filter choices; cursors never enter this key. */
export function saveInboxViewPreferences(
  profileId: string,
  update: InboxViewPreferencesUpdate,
): InboxViewPreferences {
  const stored = loadInboxViewPreferences(profileId);
  const {
    reviewState: updatedReviewState,
    checkStatus: updatedCheckStatus,
    author: updatedAuthor,
    baseBranch: updatedBaseBranch,
    ...otherUpdates
  } = update;
  const {
    reviewState: storedReviewState,
    checkStatus: storedCheckStatus,
    author: storedAuthor,
    baseBranch: storedBaseBranch,
    ...storedWithoutFilters
  } = stored;
  const next = withOptionalFilters(
    { ...storedWithoutFilters, ...otherUpdates },
    {
      reviewState: Object.hasOwn(update, "reviewState")
        ? updatedReviewState
        : storedReviewState,
      checkStatus: Object.hasOwn(update, "checkStatus")
        ? updatedCheckStatus
        : storedCheckStatus,
      author: Object.hasOwn(update, "author") ? updatedAuthor : storedAuthor,
      baseBranch: Object.hasOwn(update, "baseBranch")
        ? updatedBaseBranch
        : storedBaseBranch,
    },
  );
  inboxViewPreference.save(profileId, next);
  return next;
}

/**
 * Re-attaches the four More filters, leaving out each key whose value is
 * `undefined` rather than storing the key with an undefined value —
 * `exactOptionalPropertyTypes` treats those as different, and only an absent
 * key survives the round trip through JSON.
 */
function withOptionalFilters(
  base: Omit<InboxViewPreferences, OptionalInboxFilterKey>,
  filters: {
    readonly [Key in OptionalInboxFilterKey]: InboxViewPreferences[Key];
  },
): InboxViewPreferences {
  const withReviewState =
    filters.reviewState === undefined
      ? base
      : { ...base, reviewState: filters.reviewState };
  const withCheckStatus =
    filters.checkStatus === undefined
      ? withReviewState
      : { ...withReviewState, checkStatus: filters.checkStatus };
  const withAuthor =
    filters.author === undefined
      ? withCheckStatus
      : { ...withCheckStatus, author: filters.author };
  return filters.baseBranch === undefined
    ? withAuthor
    : { ...withAuthor, baseBranch: filters.baseBranch };
}

function preferencesFrom(
  parsed: v.InferOutput<typeof preferencesSchema>,
): InboxViewPreferences {
  const withFilters = withOptionalFilters(
    {
      state: parsed.state,
      pageSize: parsed.pageSize,
      selectedLabels: parsed.selectedLabels,
      awaitingMyReview: parsed.awaitingMyReview,
      inspectorOpen: parsed.inspectorOpen,
    },
    {
      reviewState: parsed.reviewState,
      checkStatus: parsed.checkStatus,
      author: parsed.author,
      baseBranch: parsed.baseBranch,
    },
  );
  const withIdentity =
    parsed.selectedIdentity === undefined
      ? withFilters
      : { ...withFilters, selectedIdentity: parsed.selectedIdentity };
  if (parsed.selectedRepository === undefined) return withIdentity;
  return { ...withIdentity, selectedRepository: parsed.selectedRepository };
}
