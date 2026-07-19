import type { InboxView } from "./renderer-contracts";

export type InboxSort = "priority" | "updated" | "repository";

/** A named local shortcut for a composed inbox filter; it never changes review state. */
export type SavedInboxView = {
  readonly id: string;
  readonly name: string;
  readonly view: InboxView;
  readonly search: string;
  readonly sort: InboxSort;
};

export type InboxViewPreferences = {
  readonly view: InboxView;
  readonly search: string;
  readonly sort: InboxSort;
  readonly queueRailOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly selectedIdentity?: string;
  readonly savedViews: ReadonlyArray<SavedInboxView>;
};

export const DEFAULT_INBOX_VIEW_PREFERENCES: InboxViewPreferences = {
  view: "my_inbox",
  search: "",
  sort: "priority",
  queueRailOpen: true,
  inspectorOpen: true,
  savedViews: [],
};

const VERSION = 1;

/** Loads local, profile-scoped presentation choices; malformed values safely reset. */
export function loadInboxViewPreferences(profileId: string): InboxViewPreferences {
  if (typeof window === "undefined") return DEFAULT_INBOX_VIEW_PREFERENCES;
  try {
    return parsePreferences(JSON.parse(window.localStorage.getItem(key(profileId)) ?? "null"));
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
  window.localStorage.setItem(key(profileId), JSON.stringify({ version: VERSION, preferences: next }));
  return next;
}

function parsePreferences(input: unknown): InboxViewPreferences {
  if (!isRecord(input) || input.version !== VERSION || !isRecord(input.preferences))
    return DEFAULT_INBOX_VIEW_PREFERENCES;
  const value = input.preferences;
  return {
    view: isInboxView(value.view) ? value.view : "my_inbox",
    search: typeof value.search === "string" ? value.search.slice(0, 200) : "",
    sort: value.sort === "updated" || value.sort === "repository" ? value.sort : "priority",
    queueRailOpen: value.queueRailOpen !== false,
    inspectorOpen: value.inspectorOpen !== false,
    savedViews: parseSavedViews(value.savedViews),
    ...(typeof value.selectedIdentity === "string" && value.selectedIdentity.length > 0
      ? { selectedIdentity: value.selectedIdentity }
      : {}),
  };
}

function parseSavedViews(value: unknown): ReadonlyArray<SavedInboxView> {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const parsed: SavedInboxView[] = [];
  for (const item of value.slice(0, 20)) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") continue;
    const id = item.id.trim().slice(0, 80);
    const name = item.name.trim().slice(0, 60);
    if (id.length === 0 || name.length === 0 || ids.has(id) || !isInboxView(item.view)) continue;
    ids.add(id);
    parsed.push({
      id,
      name,
      view: item.view,
      search: typeof item.search === "string" ? item.search.slice(0, 200) : "",
      sort: item.sort === "updated" || item.sort === "repository" ? item.sort : "priority",
    });
  }
  return parsed;
}

function isInboxView(value: unknown): value is InboxView {
  return value === "my_inbox" || value === "updated" || value === "needs_review" ||
    value === "waiting" || value === "checks_failing" || value === "ready_to_merge" || value === "all_open";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function key(profileId: string): string {
  return `patchdesk.inbox-view.v${VERSION}.${profileId}`;
}
