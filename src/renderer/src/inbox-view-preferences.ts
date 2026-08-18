import * as v from "valibot";
import type { InboxView } from "./renderer-contracts";

const inboxViewSchema = v.picklist([
  "my_inbox",
  "updated",
  "needs_review",
  "waiting",
  "checks_failing",
  "ready_to_merge",
  "all_open",
]);

const inboxSortSchema = v.picklist([
  "priority",
  "updated",
  "repository",
  "size",
]);

export type InboxSort = v.InferOutput<typeof inboxSortSchema>;

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

const cappedLabels = (max: number) =>
  v.pipe(
    v.array(clipped(200)),
    v.transform((values) => values.slice(0, max)),
  );

const savedViewSchema = v.object({
  id: trimmed(80),
  name: trimmed(60),
  view: inboxViewSchema,
  search: v.fallback(clipped(200), ""),
  sort: v.fallback(inboxSortSchema, "priority"),
  selectedRepo: v.fallback(clipped(200), ""),
  selectedLabels: v.fallback(cappedLabels(50), []),
});

/** A named local shortcut for a composed inbox filter; it never changes review state. */
export type SavedInboxView = v.InferOutput<typeof savedViewSchema>;

// Every field falls back independently: one stale or hand-edited value resets
// itself instead of discarding the whole stored view.
const preferencesSchema = v.object({
  view: v.fallback(inboxViewSchema, "my_inbox"),
  search: v.fallback(clipped(200), ""),
  sort: v.fallback(inboxSortSchema, "priority"),
  selectedRepo: v.fallback(clipped(200), ""),
  selectedLabels: v.fallback(cappedLabels(50), []),
  queueRailOpen: v.fallback(v.boolean(), true),
  inspectorOpen: v.fallback(v.boolean(), true),
  selectedIdentity: v.fallback(v.optional(trimmed(200)), undefined),
  // Saved views are parsed per item below so one bad entry drops itself
  // instead of resetting the whole list.
  savedViews: v.fallback(v.array(v.unknown()), []),
});

export type InboxViewPreferences = {
  readonly view: InboxView;
  readonly search: string;
  readonly sort: InboxSort;
  readonly selectedRepo: string;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly queueRailOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly selectedIdentity?: string;
  readonly savedViews: ReadonlyArray<SavedInboxView>;
};

export const DEFAULT_INBOX_VIEW_PREFERENCES: InboxViewPreferences = {
  view: "my_inbox",
  search: "",
  sort: "priority",
  selectedRepo: "",
  selectedLabels: [],
  queueRailOpen: true,
  inspectorOpen: true,
  savedViews: [],
};

const VERSION = 1;

const storedSchema = v.object({
  version: v.literal(VERSION),
  preferences: preferencesSchema,
});

/** Loads local, profile-scoped presentation choices; malformed values safely reset. */
export function loadInboxViewPreferences(
  profileId: string,
): InboxViewPreferences {
  const stored = globalThis.window?.localStorage.getItem(key(profileId));
  if (stored === null || stored === undefined)
    return DEFAULT_INBOX_VIEW_PREFERENCES;
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
    view: parsed.view,
    search: parsed.search,
    sort: parsed.sort,
    selectedRepo: parsed.selectedRepo,
    selectedLabels: parsed.selectedLabels,
    queueRailOpen: parsed.queueRailOpen,
    inspectorOpen: parsed.inspectorOpen,
    savedViews: uniqueSavedViews(parsed.savedViews),
  };
  if (parsed.selectedIdentity === undefined) return base;
  return { ...base, selectedIdentity: parsed.selectedIdentity };
}

/** Keeps the first sound view per id and bounds the list the way the save path does. */
function uniqueSavedViews(
  views: v.InferOutput<typeof preferencesSchema>["savedViews"],
): ReadonlyArray<SavedInboxView> {
  const seen = new Set<string>();
  const unique: SavedInboxView[] = [];
  for (const view of views) {
    const parsed = v.safeParse(savedViewSchema, view);
    if (!parsed.success || seen.has(parsed.output.id)) continue;
    seen.add(parsed.output.id);
    unique.push(parsed.output);
    if (unique.length === 20) break;
  }
  return unique;
}

function key(profileId: string): string {
  return `patchdesk.inbox-view.v${VERSION}.${profileId}`;
}
