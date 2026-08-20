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
  type InboxSort,
  type SavedInboxView,
} from "@/inbox-view-preferences";

/** Which workbench tab a triggered Review action should land on. */
export type ReviewInitialSection = "overview" | "diff" | "checks";

type InboxViewState = {
  readonly view: InboxView;
  readonly search: string;
  readonly sort: InboxSort;
  readonly selectedRepos: ReadonlyArray<string>;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly queueOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly selectedKey?: string;
  readonly savedViews: ReadonlyArray<SavedInboxView>;
};

type InboxViewAction =
  | { readonly _tag: "preferencesLoaded"; readonly state: InboxViewState }
  | { readonly _tag: "viewSelected"; readonly view: InboxView }
  | { readonly _tag: "savedViewSelected"; readonly view: SavedInboxView }
  | { readonly _tag: "searchChanged"; readonly search: string }
  | { readonly _tag: "sortChanged"; readonly sort: InboxSort }
  | {
      readonly _tag: "repositoriesChanged";
      readonly selectedRepos: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "labelChanged";
      readonly selectedLabels: ReadonlyArray<string>;
    }
  | { readonly _tag: "rowSelected"; readonly selectedKey: string }
  | { readonly _tag: "queueToggled" }
  | { readonly _tag: "inspectorToggled" }
  | { readonly _tag: "savedViewAdded"; readonly view: SavedInboxView }
  | { readonly _tag: "savedViewRemoved"; readonly viewId: string };

function inboxViewState(
  preferences: ReturnType<typeof loadInboxViewPreferences>,
): InboxViewState {
  const state: InboxViewState = {
    view: preferences.view,
    search: preferences.search,
    sort: preferences.sort,
    selectedRepos: preferences.selectedRepos,
    selectedLabels: preferences.selectedLabels,
    queueOpen: preferences.queueRailOpen,
    inspectorOpen: preferences.inspectorOpen,
    savedViews: preferences.savedViews,
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
    case "savedViewSelected":
      return {
        ...state,
        view: action.view.view,
        search: action.view.search,
        sort: action.view.sort,
        selectedRepos: action.view.selectedRepos,
        selectedLabels: action.view.selectedLabels,
      };
    case "searchChanged":
      return { ...state, search: action.search };
    case "sortChanged":
      return { ...state, sort: action.sort };
    case "repositoriesChanged":
      return { ...state, selectedRepos: action.selectedRepos };
    case "labelChanged":
      return { ...state, selectedLabels: action.selectedLabels };
    case "rowSelected":
      return { ...state, selectedKey: action.selectedKey };
    case "queueToggled":
      return { ...state, queueOpen: !state.queueOpen };
    case "inspectorToggled":
      return { ...state, inspectorOpen: !state.inspectorOpen };
    case "savedViewAdded":
      return {
        ...state,
        savedViews: [...state.savedViews, action.view].slice(-20),
      };
    case "savedViewRemoved":
      return {
        ...state,
        savedViews: state.savedViews.filter(
          (view) => view.id !== action.viewId,
        ),
      };
  }
}

export function matchesView(row: InboxRow, view: InboxView): boolean {
  switch (view) {
    case "all_open":
      return true;
    case "my_inbox":
      return row.categories.some(
        (category) =>
          category === "needs_review" ||
          category === "updated_since_review" ||
          category === "saved_review",
      );
    case "updated":
      return row.categories.includes("updated_since_review");
    case "needs_review":
      return row.categories.includes("needs_review");
    case "waiting":
      return row.categories.includes("waiting_for_author");
    case "checks_failing":
      return row.categories.includes("checks_failing");
    case "ready_to_merge":
      return row.categories.includes("ready_to_merge");
  }
}

export function filterRows(
  rows: ReadonlyArray<InboxRow>,
  view: InboxView,
  search: string,
  selectedRepos: ReadonlyArray<string> = [],
  selectedLabels: ReadonlyArray<string> = [],
): ReadonlyArray<InboxRow> {
  const needle = search.trim().toLocaleLowerCase();
  const selectedRepoSet = new Set(selectedRepos);
  const selectedLabelSet = new Set(selectedLabels);
  return rows.filter(
    (row) =>
      matchesView(row, view) &&
      (needle.length === 0 ||
        `${row.identity.owner}/${row.identity.repo} ${row.title} ${row.author} #${row.identity.number}`
          .toLocaleLowerCase()
          .includes(needle)) &&
      (selectedRepoSet.size === 0 ||
        selectedRepoSet.has(`${row.identity.owner}/${row.identity.repo}`)) &&
      (selectedLabelSet.size === 0 ||
        row.labels.some((label) => selectedLabelSet.has(label.name))),
  );
}

function changedLines(row: InboxRow): number {
  const { additions, deletions } = row.changeStats;
  return (additions ?? 0) + (deletions ?? 0);
}

function priority(row: InboxRow): number {
  if (row.categories.includes("saved_review")) return 0;
  if (row.categories.includes("updated_since_review")) return 1;
  if (row.categories.includes("needs_review")) return 2;
  if (row.categories.includes("waiting_for_author")) return 3;
  if (row.categories.includes("checks_failing")) return 4;
  if (row.categories.includes("ready_to_merge")) return 5;
  return 6;
}

function sortRows(
  rows: ReadonlyArray<InboxRow>,
  sort: InboxSort,
): ReadonlyArray<InboxRow> {
  return [...rows].sort((left, right) =>
    sort === "updated"
      ? right.updatedAt.localeCompare(left.updatedAt)
      : sort === "repository"
        ? inboxIdentityKey(left).localeCompare(inboxIdentityKey(right))
        : sort === "size"
          ? changedLines(right) - changedLines(left) ||
            right.updatedAt.localeCompare(left.updatedAt)
          : priority(left) - priority(right) ||
            right.updatedAt.localeCompare(left.updatedAt) ||
            inboxIdentityKey(left).localeCompare(inboxIdentityKey(right)),
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
    case "open_saved_review":
    case "open_merge_readiness":
    case "open_discussion":
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
 * Owns the maintainer inbox's local view state (queue, search, sort,
 * repo/label filters, saved views, selection) and derives the visible row
 * list from it. Extracted out of `MaintainerInbox` to keep that component
 * under the renderer's giant-component guardrail.
 */
export function useInboxView(params: {
  readonly profileId: string;
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
  const { profileId, rows, repos, onOpenReview, onOpenReviewId } = params;
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
    sort,
    selectedRepos,
    selectedLabels,
    queueOpen,
    inspectorOpen,
    selectedKey,
    savedViews,
  } = inboxView;
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [savedViewName, setSavedViewName] = useState("");
  const [deleteView, setDeleteView] = useState<SavedInboxView>();
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

  const repoItems = useMemo(
    () =>
      (repos ?? []).map((repo) => ({
        label: `${repo.owner}/${repo.repo}`,
        value: `${repo.owner}/${repo.repo}`,
      })),
    [repos],
  );

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
        filterRows(rows, view, search, selectedRepos, selectedLabels),
        sort,
      ),
    [rows, search, sort, view, selectedRepos, selectedLabels],
  );
  // The repository reads as noise when every visible row shares it, so rows
  // only carry it while the view actually spans more than one repository.
  const multipleRepositories = useMemo(
    () =>
      new Set(
        visibleRows.map((row) => `${row.identity.owner}/${row.identity.repo}`),
      ).size > 1,
    [visibleRows],
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
  const selectSavedView = (next: SavedInboxView): void => {
    dispatchInboxView({ _tag: "savedViewSelected", view: next });
    saveInboxViewPreferences(profileId, {
      view: next.view,
      search: next.search,
      sort: next.sort,
      selectedRepos: next.selectedRepos,
      selectedLabels: next.selectedLabels,
    });
  };
  const saveCurrentView = (): void => {
    const name = savedViewName.trim().slice(0, 60);
    if (name.length === 0) return;
    const next: SavedInboxView = {
      id: `view-${Date.now().toString(36)}`,
      name,
      view,
      search,
      sort,
      selectedRepos: [...selectedRepos],
      selectedLabels: [...selectedLabels],
    };
    const updated = [...savedViews, next].slice(-20);
    dispatchInboxView({ _tag: "savedViewAdded", view: next });
    saveInboxViewPreferences(profileId, { savedViews: updated });
    setSavedViewName("");
    setSaveViewOpen(false);
  };
  const removeSavedView = (): void => {
    if (deleteView === undefined) return;
    const updated = savedViews.filter(
      (candidate) => candidate.id !== deleteView.id,
    );
    dispatchInboxView({ _tag: "savedViewRemoved", viewId: deleteView.id });
    saveInboxViewPreferences(profileId, { savedViews: updated });
    setDeleteView(undefined);
  };
  const selectRow = (row: InboxRow): void => {
    const key = inboxIdentityKey(row);
    dispatchInboxView({ _tag: "rowSelected", selectedKey: key });
    saveInboxViewPreferences(profileId, { selectedIdentity: key });
  };
  const changeSearch = (next: string): void => {
    dispatchInboxView({ _tag: "searchChanged", search: next });
    saveInboxViewPreferences(profileId, { search: next });
  };
  const changeSort = (next: InboxSort): void => {
    dispatchInboxView({ _tag: "sortChanged", sort: next });
    saveInboxViewPreferences(profileId, { sort: next });
  };
  const changeSelectedRepos = (next: ReadonlyArray<string>): void => {
    dispatchInboxView({ _tag: "repositoriesChanged", selectedRepos: next });
    saveInboxViewPreferences(profileId, { selectedRepos: next });
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
    sort,
    selectedRepos,
    selectedLabels,
    queueOpen,
    inspectorOpen,
    savedViews,
    saveViewOpen,
    setSaveViewOpen,
    savedViewName,
    setSavedViewName,
    deleteView,
    setDeleteView,
    narrow,
    listRef,
    repoItems,
    labelItems,
    visibleRows,
    multipleRepositories,
    selected,
    triggerAction,
    selectView,
    selectSavedView,
    saveCurrentView,
    removeSavedView,
    selectRow,
    changeSearch,
    changeSort,
    changeSelectedRepos,
    changeSelectedLabels,
    toggleQueue,
    toggleInspector,
    onListKeyDown,
  };
}
