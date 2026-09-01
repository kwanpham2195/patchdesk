import * as v from "valibot";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  INBOX_CHECK_STATUS_FILTER_VALUES,
  INBOX_PAGE_SIZES,
  MAX_INBOX_FILTER_LABELS,
  MAX_INBOX_FILTER_LABEL_LENGTH,
  INBOX_REVIEW_STATE_FILTER_VALUES,
  INBOX_STATE_FILTER_VALUES,
  type InboxCheckStatusFilter,
  type InboxPageSize,
  type InboxReviewStateFilter,
  type InboxStateFilter,
} from "../../domain/maintainer-inbox";
import type { RepositoryIdentity } from "../../domain/repository-identity";
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
  readonly inspectorOpen: boolean;
  readonly selectedIdentity?: string;
  /** The last repository selected from the watchlist, per profile. Falls
   * back to the first watched repository when unset or no longer watched —
   * see `resolveInboxRepository` in `app.tsx`. */
  readonly selectedRepository?: RepositoryIdentity;
};

const DEFAULT_INBOX_VIEW_PREFERENCES: InboxViewPreferences = {
  state: "open",
  pageSize: DEFAULT_INBOX_PAGE_SIZE,
  selectedLabels: [],
  awaitingMyReview: false,
  inspectorOpen: true,
};

// v5 dropped the queue rail (`view`, `queueRailOpen`) and the in-page search
// box — every filter now reaches GitHub as a structured, server-side
// qualifier instead of filtering the loaded page — see ADR 0031. v6 renames
// the stored `scope` field to `state`, the one spelling the domain, the
// route, and the renderer all use for the same value.
// Bumping VERSION (rather than migrating the v5 key) resets every field
// to default on an old-version read, matching how v1 -> v2 -> v3 -> v4
// already worked: only the v1 key is still recognized, so any other stale
// version falls straight through to `DEFAULT_INBOX_VIEW_PREFERENCES`.
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
  update: Partial<InboxViewPreferences>,
): InboxViewPreferences {
  const next = { ...loadInboxViewPreferences(profileId), ...update };
  inboxViewPreference.save(profileId, next);
  return next;
}

function preferencesFrom(
  parsed: v.InferOutput<typeof preferencesSchema>,
): InboxViewPreferences {
  const base = {
    state: parsed.state,
    pageSize: parsed.pageSize,
    selectedLabels: parsed.selectedLabels,
    awaitingMyReview: parsed.awaitingMyReview,
    inspectorOpen: parsed.inspectorOpen,
  };
  const withReviewState =
    parsed.reviewState === undefined
      ? base
      : { ...base, reviewState: parsed.reviewState };
  const withCheckStatus =
    parsed.checkStatus === undefined
      ? withReviewState
      : { ...withReviewState, checkStatus: parsed.checkStatus };
  const withIdentity =
    parsed.selectedIdentity === undefined
      ? withCheckStatus
      : { ...withCheckStatus, selectedIdentity: parsed.selectedIdentity };
  if (parsed.selectedRepository === undefined) return withIdentity;
  return { ...withIdentity, selectedRepository: parsed.selectedRepository };
}
