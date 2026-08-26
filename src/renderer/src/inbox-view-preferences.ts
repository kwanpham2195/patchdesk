import * as v from "valibot";
import type { InboxView } from "./renderer-contracts";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  INBOX_PAGE_SIZES,
  type InboxPageSize,
} from "../../domain/maintainer-inbox";

export type InboxScope = "open" | "merged";

const inboxViewSchema = v.picklist([
  "my_inbox",
  "updated",
  "ready_to_merge",
  "all_open",
]);

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

// selectedLabels is a string list capped at 50 entries so a runaway stored
// value can't grow the payload unbounded.
const cappedStrings = (max: number) =>
  v.pipe(
    v.array(clipped(200)),
    v.transform((values) => values.slice(0, max)),
  );

// Every field falls back independently: one stale or hand-edited value resets
// itself instead of discarding the whole stored view.
const preferencesSchema = v.object({
  scope: v.fallback(inboxScopeSchema, "open"),
  pageSize: v.fallback(inboxPageSizeSchema, DEFAULT_INBOX_PAGE_SIZE),
  view: v.fallback(inboxViewSchema, "my_inbox"),
  search: v.fallback(clipped(200), ""),
  selectedLabels: v.fallback(cappedStrings(50), []),
  queueRailOpen: v.fallback(v.boolean(), true),
  inspectorOpen: v.fallback(v.boolean(), true),
  selectedIdentity: v.fallback(v.optional(trimmed(200)), undefined),
});

export type InboxViewPreferences = {
  readonly scope: InboxScope;
  readonly pageSize: InboxPageSize;
  readonly view: InboxView;
  readonly search: string;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly queueRailOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly selectedIdentity?: string;
};

export const DEFAULT_INBOX_VIEW_PREFERENCES: InboxViewPreferences = {
  scope: "open",
  pageSize: DEFAULT_INBOX_PAGE_SIZE,
  view: "my_inbox",
  search: "",
  selectedLabels: [],
  queueRailOpen: true,
  inspectorOpen: true,
};

// v4 drops saved views, the repository multi-select, and every sort but
// GitHub's own "updated" order — see
// .agents/PLANS/2026-08-25-scope-pull-requests-to-one-repository.md.
// Bumping VERSION (rather than migrating the v3 key) resets every field to
// default on an old-version read, matching how v1 -> v2 and v2 -> v3 already
// worked: `loadLegacyInboxViewPreferences` only recognizes the v1 key, so any
// other stale version falls straight through to
// `DEFAULT_INBOX_VIEW_PREFERENCES`.
const VERSION = 4;

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
    view: parsed.view,
    search: parsed.search,
    selectedLabels: parsed.selectedLabels,
    queueRailOpen: parsed.queueRailOpen,
    inspectorOpen: parsed.inspectorOpen,
  };
  if (parsed.selectedIdentity === undefined) return base;
  return { ...base, selectedIdentity: parsed.selectedIdentity };
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
