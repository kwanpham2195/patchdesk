import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  inboxIdentityKey,
  type InboxRow,
  type InboxView,
} from "@/renderer-contracts";
import { inboxQueues } from "@/inbox-queues";
import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "@/inbox-view-preferences";

/** Which workbench tab a triggered Review action should land on. */
export type ReviewInitialSection = "overview" | "diff" | "checks";

type InboxViewState = {
  readonly view: InboxView;
  readonly search: string;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly queueOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly selectedKey?: string;
};

type InboxViewAction =
  | { readonly _tag: "preferencesLoaded"; readonly state: InboxViewState }
  | { readonly _tag: "viewSelected"; readonly view: InboxView }
  | { readonly _tag: "searchChanged"; readonly search: string }
  | {
      readonly _tag: "labelChanged";
      readonly selectedLabels: ReadonlyArray<string>;
    }
  | { readonly _tag: "rowSelected"; readonly selectedKey: string }
  | { readonly _tag: "queueToggled" }
  | { readonly _tag: "inspectorToggled" };

function inboxViewState(
  preferences: ReturnType<typeof loadInboxViewPreferences>,
): InboxViewState {
  const state: InboxViewState = {
    view: preferences.view,
    search: preferences.search,
    selectedLabels: preferences.selectedLabels,
    queueOpen: preferences.queueRailOpen,
    inspectorOpen: preferences.inspectorOpen,
  };
  return preferences.selectedIdentity === undefined
    ? state
    : { ...state, selectedKey: preferences.selectedIdentity };
}

function inboxViewReducer(
  state: InboxViewState,
  action: InboxViewAction,
): InboxViewState {
  switch (action._tag) {
    case "preferencesLoaded":
      return action.state;
    case "viewSelected":
      return { ...state, view: action.view };
    case "searchChanged":
      return { ...state, search: action.search };
    case "labelChanged":
      return { ...state, selectedLabels: action.selectedLabels };
    case "rowSelected":
      return { ...state, selectedKey: action.selectedKey };
    case "queueToggled":
      return { ...state, queueOpen: !state.queueOpen };
    case "inspectorToggled":
      return { ...state, inspectorOpen: !state.inspectorOpen };
  }
}

export function matchesView(row: InboxRow, view: InboxView): boolean {
  switch (view) {
    case "all_open":
      return true;
    case "my_inbox":
    case "updated":
      return row.categories.includes("updated_since_review");
    case "ready_to_merge":
      return row.categories.includes("ready_to_merge");
  }
}

export function filterRows(
  rows: ReadonlyArray<InboxRow>,
  view: InboxView,
  search: string,
  selectedLabels: ReadonlyArray<string> = [],
): ReadonlyArray<InboxRow> {
  const needle = search.trim().toLocaleLowerCase();
  const selectedLabelSet = new Set(selectedLabels);
  return rows.filter(
    (row) =>
      matchesView(row, view) &&
      (needle.length === 0 ||
        `${row.identity.owner}/${row.identity.repo} ${row.title} ${row.author} #${row.identity.number}`
          .toLocaleLowerCase()
          .includes(needle)) &&
      (selectedLabelSet.size === 0 ||
        row.labels.some((label) => selectedLabelSet.has(label.name))),
  );
}

// GitHub's own ordering is the only sort left; see ADR 0031.
function sortRows(rows: ReadonlyArray<InboxRow>): ReadonlyArray<InboxRow> {
  return [...rows].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function requestAction(
  row: InboxRow,
  onOpenReview: (row: InboxRow, initialSection?: ReviewInitialSection) => void,
  onOpenReviewId: (reviewId: string) => void,
): void {
  switch (row.recommendedAction.kind) {
    case "run_review":
      onOpenReview(row);
      return;
    case "open_merged_review":
      onOpenReview(row);
      return;
    case "open_saved_review":
    case "open_merge_readiness":
      onOpenReviewId(row.recommendedAction.reviewId);
      return;
  }
}

// `window` or `window.matchMedia` may be absent when this runs under
// node/jsdom test environments, so every caller reaches this indirectly.
function narrowViewportQuery(): MediaQueryList | undefined {
  return globalThis.window?.matchMedia?.("(max-width: 1279px)");
}
function isNarrowViewport(): boolean {
  return narrowViewportQuery()?.matches ?? false;
}
function resolveInboxView(value: string): InboxView | undefined {
  return inboxQueues.find((queue) => queue.id === value)?.id;
}

/**
 * Owns the maintainer inbox's local view state (queue, search, label
 * filter, selection) and derives the visible row list from it. Extracted
 * out of `MaintainerInbox` to keep that component under the renderer's
 * giant-component guardrail.
 */
export function useInboxView(params: {
  readonly profileId: string;
  /** Merged rows are historical and bypass every active-work queue filter. */
  readonly scope: "open" | "merged";
  readonly rows: ReadonlyArray<InboxRow>;
  readonly repos?: ReadonlyArray<{
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
  }>;
  readonly onOpenReview: (
    row: InboxRow,
    initialSection?: ReviewInitialSection,
  ) => void;
  readonly onOpenReviewId: (reviewId: string) => void;
}) {
  const { profileId, scope, rows, onOpenReview, onOpenReviewId } = params;
  const preferences = useMemo(
    () => loadInboxViewPreferences(profileId),
    [profileId],
  );
  const [inboxView, dispatchInboxView] = useReducer(
    inboxViewReducer,
    preferences,
    inboxViewState,
  );
  const {
    view,
    search,
    selectedLabels,
    queueOpen,
    inspectorOpen,
    selectedKey,
  } = inboxView;
  const [narrow, setNarrow] = useState(() => isNarrowViewport());
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const query = narrowViewportQuery();
    if (query === undefined) return;
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const next = loadInboxViewPreferences(profileId);
    dispatchInboxView({
      _tag: "preferencesLoaded",
      state: inboxViewState(next),
    });
  }, [profileId]);

  const labelItems = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows)
      for (const label of row.labels) seen.set(label.name, label.color);
    return [...seen.keys()]
      .sort()
      .map((name) => ({ label: name, value: name }));
  }, [rows]);

  const visibleRows = useMemo(
    () =>
      sortRows(
        filterRows(
          rows,
          scope === "open" ? view : "all_open",
          search,
          selectedLabels,
        ),
      ),
    [rows, scope, search, view, selectedLabels],
  );
  const selected =
    visibleRows.find((row) => inboxIdentityKey(row) === selectedKey) ??
    visibleRows[0];

  const triggerAction = useCallback(
    (row: InboxRow): void => requestAction(row, onOpenReview, onOpenReviewId),
    [onOpenReview, onOpenReviewId],
  );

  const selectView = useCallback(
    (next: InboxView): void => {
      dispatchInboxView({ _tag: "viewSelected", view: next });
      saveInboxViewPreferences(profileId, { view: next });
    },
    [profileId],
  );
  const selectRow = (row: InboxRow): void => {
    const key = inboxIdentityKey(row);
    dispatchInboxView({ _tag: "rowSelected", selectedKey: key });
    saveInboxViewPreferences(profileId, { selectedIdentity: key });
  };
  const changeSearch = (next: string): void => {
    dispatchInboxView({ _tag: "searchChanged", search: next });
    saveInboxViewPreferences(profileId, { search: next });
  };
  const changeSelectedLabels = (next: ReadonlyArray<string>): void => {
    dispatchInboxView({ _tag: "labelChanged", selectedLabels: next });
    saveInboxViewPreferences(profileId, { selectedLabels: next });
  };
  const toggleQueue = (): void => {
    const next = !queueOpen;
    dispatchInboxView({ _tag: "queueToggled" });
    saveInboxViewPreferences(profileId, { queueRailOpen: next });
  };
  const toggleInspector = (): void => {
    const next = !inspectorOpen;
    dispatchInboxView({ _tag: "inspectorToggled" });
    saveInboxViewPreferences(profileId, { inspectorOpen: next });
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (visibleRows.length === 0) return;
    const first = visibleRows[0];
    if (first === undefined) return;
    const currentIndex = Math.max(
      0,
      visibleRows.findIndex(
        (row) => inboxIdentityKey(row) === inboxIdentityKey(selected ?? first),
      ),
    );
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next =
        visibleRows[
          (currentIndex + offset + visibleRows.length) % visibleRows.length
        ];
      if (next === undefined) return;
      selectRow(next);
      document.getElementById(`inbox-row-${inboxIdentityKey(next)}`)?.focus();
    }
    if (event.key === "Enter" && selected !== undefined)
      triggerAction(selected);
  };

  useEffect(() => {
    const onView = (event: CustomEvent<string>): void => {
      const next = resolveInboxView(event.detail);
      if (next !== undefined) selectView(next);
    };
    const onAction = (): void => {
      if (selected !== undefined) triggerAction(selected);
    };
    window.addEventListener("patchdesk:inbox-view", onView);
    window.addEventListener("patchdesk:inbox-action", onAction);
    return () => {
      window.removeEventListener("patchdesk:inbox-view", onView);
      window.removeEventListener("patchdesk:inbox-action", onAction);
    };
  }, [selectView, selected, triggerAction]);

  return {
    view,
    search,
    selectedLabels,
    queueOpen,
    inspectorOpen,
    narrow,
    listRef,
    labelItems,
    visibleRows,
    selected,
    triggerAction,
    selectView,
    selectRow,
    changeSearch,
    changeSelectedLabels,
    toggleQueue,
    toggleInspector,
    onListKeyDown,
  };
}
