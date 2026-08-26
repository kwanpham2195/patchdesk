import * as v from "valibot";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  INBOX_PAGE_SIZES,
  MAX_INBOX_FILTER_LABELS,
  MAX_INBOX_FILTER_LABEL_LENGTH,
  type InboxPageSize,
} from "../../domain/maintainer-inbox";

export type InboxScope = "open" | "merged";

/** A watched repository's identity, enough to look it up in `profile.repos`. */
export type InboxRepositoryIdentity = {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
};

const inboxScopeSchema = v.picklist(["open", "merged"]);

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

// selectedLabels is the persisted form of the label filter (slice 8a); it is
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
  scope: v.fallback(inboxScopeSchema, "open"),
  pageSize: v.fallback(inboxPageSizeSchema, DEFAULT_INBOX_PAGE_SIZE),
  selectedLabels: v.fallback(
    cappedStrings(MAX_INBOX_FILTER_LABELS, MAX_INBOX_FILTER_LABEL_LENGTH),
    [],
  ),
  inspectorOpen: v.fallback(v.boolean(), true),
  selectedIdentity: v.fallback(v.optional(trimmed(200)), undefined),
  // The Selected repository (see .agents/PLANS/2026-08-25-scope-pull-
  // requests-to-one-repository.md, slice 7c). Added without bumping VERSION:
  // it is optional and falls back to `undefined`, so a v4 record written
  // before this field existed still parses — there is nothing to migrate.
  selectedRepository: v.fallback(
    v.optional(repositoryIdentitySchema),
    undefined,
  ),
});

export type InboxViewPreferences = {
  readonly scope: InboxScope;
  readonly pageSize: InboxPageSize;
  /** The label filter, sent to GitHub as `label:"NAME"` qualifiers — no
   * longer a local, in-page filter (slice 8a). */
  readonly selectedLabels: ReadonlyArray<string>;
  readonly inspectorOpen: boolean;
  readonly selectedIdentity?: string;
  /** The last repository selected from the watchlist, per profile. Falls
   * back to the first watched repository when unset or no longer watched —
   * see `resolveInboxRepository` in `app.tsx`. */
  readonly selectedRepository?: InboxRepositoryIdentity;
};

export const DEFAULT_INBOX_VIEW_PREFERENCES: InboxViewPreferences = {
  scope: "open",
  pageSize: DEFAULT_INBOX_PAGE_SIZE,
  selectedLabels: [],
  inspectorOpen: true,
};

// v5 drops the queue rail (`view`, `queueRailOpen`) and the in-page search
// box — every filter now reaches GitHub as a structured, server-side
// qualifier instead of filtering the loaded page — see
// .agents/PLANS/2026-08-25-scope-pull-requests-to-one-repository.md, slice
// 8a. Bumping VERSION (rather than migrating the v4 key) resets every field
// to default on an old-version read, matching how v1 -> v2 -> v3 -> v4
// already worked: `loadLegacyInboxViewPreferences` only recognizes the v1
// key, so any other stale version falls straight through to
// `DEFAULT_INBOX_VIEW_PREFERENCES`.
const VERSION = 5;

const storedSchema = v.object({
  version: v.literal(VERSION),
  preferences: preferencesSchema,
});

const legacyStoredSchema = v.object({
  version: v.literal(1),
  preferences: preferencesSchema,
});

/** Loads local, profile-scoped presentation choices; malformed values safely reset. */
export function loadInboxViewPreferences(
  profileId: string,
): InboxViewPreferences {
  const stored = globalThis.window?.localStorage.getItem(key(profileId));
  if (stored === null || stored === undefined)
    return loadLegacyInboxViewPreferences(profileId);
  try {
    const parsed = v.safeParse(storedSchema, JSON.parse(stored));
    return parsed.success
      ? preferencesFrom(parsed.output.preferences)
      : DEFAULT_INBOX_VIEW_PREFERENCES;
  } catch {
    return DEFAULT_INBOX_VIEW_PREFERENCES;
  }
}

/** Persists only local presentation state; review and GitHub state never enter this key. */
export function saveInboxViewPreferences(
  profileId: string,
  update: Partial<InboxViewPreferences>,
): InboxViewPreferences {
  const next = { ...loadInboxViewPreferences(profileId), ...update };
  globalThis.window?.localStorage.setItem(
    key(profileId),
    JSON.stringify({ version: VERSION, preferences: next }),
  );
  return next;
}

function preferencesFrom(
  parsed: v.InferOutput<typeof preferencesSchema>,
): InboxViewPreferences {
  const base = {
    scope: parsed.scope,
    pageSize: parsed.pageSize,
    selectedLabels: parsed.selectedLabels,
    inspectorOpen: parsed.inspectorOpen,
  };
  const withIdentity =
    parsed.selectedIdentity === undefined
      ? base
      : { ...base, selectedIdentity: parsed.selectedIdentity };
  if (parsed.selectedRepository === undefined) return withIdentity;
  return { ...withIdentity, selectedRepository: parsed.selectedRepository };
}

function key(profileId: string): string {
  return `patchdesk.inbox-view.v${VERSION}.${profileId}`;
}

function legacyKey(profileId: string): string {
  return `patchdesk.inbox-view.v1.${profileId}`;
}

function loadLegacyInboxViewPreferences(
  profileId: string,
): InboxViewPreferences {
  const stored = globalThis.window?.localStorage.getItem(legacyKey(profileId));
  if (stored === null || stored === undefined)
    return DEFAULT_INBOX_VIEW_PREFERENCES;
  try {
    const parsed = v.safeParse(legacyStoredSchema, JSON.parse(stored));
    if (!parsed.success) return DEFAULT_INBOX_VIEW_PREFERENCES;
    return { ...preferencesFrom(parsed.output.preferences), scope: "open" };
  } catch {
    return DEFAULT_INBOX_VIEW_PREFERENCES;
  }
}
