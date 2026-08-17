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
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  CircleSlash,
  Clock3,
  Filter,
  GitPullRequest,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Save,
  Trash2,
} from "lucide-react";

import type { InboxRow, InboxView } from "@/renderer-contracts";
import { recoveryActionLabel } from "@/review-copy";
import { inboxIdentityKey } from "@/renderer-contracts";
import { inboxQueues } from "@/inbox-queues";
import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
  type InboxSort,
  type SavedInboxView,
} from "@/inbox-view-preferences";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type InboxViewState = {
  readonly view: InboxView;
  readonly search: string;
  readonly sort: InboxSort;
  readonly selectedRepo: string;
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
  | { readonly _tag: "repositoryChanged"; readonly selectedRepo: string }
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
    selectedRepo: preferences.selectedRepo,
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
        selectedRepo: action.view.selectedRepo,
      };
    case "searchChanged":
      return { ...state, search: action.search };
    case "sortChanged":
      return { ...state, sort: action.sort };
    case "repositoryChanged":
      return { ...state, selectedRepo: action.selectedRepo };
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

export type ReviewInitialSection = "overview" | "diff" | "checks";

type MaintainerInboxProps = {
  readonly profileId: string;
  readonly profileLabel: string;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly repos?: ReadonlyArray<{ host: string; owner: string; repo: string }>;
  readonly freshness: "fresh" | "cached";
  readonly snapshot?: {
    readonly state: "current" | "partial" | "failed_cached" | "unavailable";
    readonly refreshedAt?: string | undefined;
  };
  readonly refreshStatus:
    | "Refreshing"
    | "Current"
    | "Aged"
    | "Partial"
    | "Cached after refresh failure"
    | "Unavailable"
    | "Paused";
  readonly onRefresh: () => void;
  readonly onOpenReview: (
    row: InboxRow,
    initialSection?: ReviewInitialSection,
  ) => void;
  readonly onOpenReviewId: (reviewId: string) => void;
};

/** Dense, keyboard-operable maintainer queue built from the parsed local API projection. */
export function MaintainerInbox({
  profileId,
  profileLabel,
  rows,
  repos,
  freshness,
  snapshot,
  refreshStatus,
  onRefresh,
  onOpenReview,
  onOpenReviewId,
}: MaintainerInboxProps): React.JSX.Element {
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
    selectedRepo,
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
    () => [
      { label: "All repositories", value: "" },
      ...(repos ?? []).map((repo) => ({
        label: `${repo.owner}/${repo.repo}`,
        value: `${repo.owner}/${repo.repo}`,
      })),
    ],
    [repos],
  );

  const visibleRows = useMemo(
    () => sortRows(filterRows(rows, view, search, selectedRepo), sort),
    [rows, search, sort, view, selectedRepo],
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
      selectedRepo: next.selectedRepo,
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
      selectedRepo,
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
  const changeSelectedRepo = (next: string): void => {
    dispatchInboxView({ _tag: "repositoryChanged", selectedRepo: next });
    saveInboxViewPreferences(profileId, { selectedRepo: next });
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
    if (event.key === "Enter" && selected !== undefined) {
      event.preventDefault();
      requestAction(selected, onOpenReview, onOpenReviewId);
    }
  };

  useEffect(() => {
    const onView = (event: CustomEvent<string>): void => {
      const next = resolveInboxView(event.detail);
      if (next !== undefined) selectView(next);
    };
    const onAction = (): void => {
      if (selected !== undefined)
        requestAction(selected, onOpenReview, onOpenReviewId);
    };
    window.addEventListener("patchdesk:inbox-view", onView);
    window.addEventListener("patchdesk:inbox-action", onAction);
    return () => {
      window.removeEventListener("patchdesk:inbox-view", onView);
      window.removeEventListener("patchdesk:inbox-action", onAction);
    };
  }, [onOpenReview, onOpenReviewId, selectView, selected]);

  const main = (
    <div className="min-w-0">
      <InboxHeader
        profileLabel={profileLabel}
        refreshStatus={refreshStatus}
        {...(snapshot === undefined ? {} : { snapshot })}
        onRefresh={onRefresh}
      />
      <InboxFiltersBar
        queueOpen={queueOpen}
        onToggleQueue={toggleQueue}
        search={search}
        onSearchChange={changeSearch}
        {...(repos === undefined ? {} : { repos })}
        repoItems={repoItems}
        selectedRepo={selectedRepo}
        onRepositoryChange={changeSelectedRepo}
        sort={sort}
        onSortChange={changeSort}
        visibleCount={visibleRows.length}
        inspectorOpen={inspectorOpen}
        onToggleInspector={toggleInspector}
      />
      <InboxRowsPanel
        listRef={listRef}
        visibleRows={visibleRows}
        selected={selected}
        multipleRepositories={multipleRepositories}
        onKeyDown={onListKeyDown}
        onSelectRow={selectRow}
        onActionRow={(row) => requestAction(row, onOpenReview, onOpenReviewId)}
      />
    </div>
  );

  const desktopGridColumns = queueOpen
    ? inspectorOpen
      ? "min-[1280px]:grid-cols-[13rem_minmax(0,1fr)_21rem]"
      : "min-[1280px]:grid-cols-[13rem_minmax(0,1fr)]"
    : inspectorOpen
      ? "min-[1280px]:grid-cols-[3rem_minmax(0,1fr)_21rem]"
      : "min-[1280px]:grid-cols-[3rem_minmax(0,1fr)]";

  return (
    <div
      className={cn(
        "min-h-[calc(100vh-3rem)] min-w-0 bg-background min-[1280px]:grid min-[1280px]:h-full min-[1280px]:min-h-0 min-[1280px]:overflow-hidden",
        desktopGridColumns,
      )}
    >
      <QueueRail
        rows={rows}
        view={view}
        savedViews={savedViews}
        selectedRepo={selectedRepo}
        open={queueOpen}
        onSelect={selectView}
        onSelectSaved={selectSavedView}
        onSaveCurrent={() => setSaveViewOpen(true)}
        onDeleteSaved={setDeleteView}
        onToggle={toggleQueue}
      />
      <ScrollArea className="min-w-0 overflow-x-hidden min-[1280px]:h-full">
        {main}
      </ScrollArea>
      <ReviewDetailsPanel
        inspectorOpen={inspectorOpen}
        narrow={narrow}
        selected={selected}
        freshness={freshness}
        onToggleInspector={toggleInspector}
        onAction={() =>
          selected === undefined
            ? undefined
            : requestAction(selected, onOpenReview, onOpenReviewId)
        }
      />
      <SaveViewDialog
        open={saveViewOpen}
        onOpenChange={setSaveViewOpen}
        profileLabel={profileLabel}
        name={savedViewName}
        onNameChange={setSavedViewName}
        onSave={saveCurrentView}
      />
      <DeleteViewAlertDialog
        deleteView={deleteView}
        onOpenChange={(open) => {
          if (!open) setDeleteView(undefined);
        }}
        onConfirm={removeSavedView}
      />
    </div>
  );
}

function InboxHeader({
  profileLabel,
  refreshStatus,
  snapshot,
  onRefresh,
}: {
  readonly profileLabel: string;
  readonly refreshStatus:
    | "Refreshing"
    | "Current"
    | "Aged"
    | "Partial"
    | "Cached after refresh failure"
    | "Unavailable"
    | "Paused";
  readonly snapshot?: {
    readonly state: "current" | "partial" | "failed_cached" | "unavailable";
    readonly refreshedAt?: string | undefined;
  };
  readonly onRefresh: () => void;
}): React.JSX.Element {
  return (
    <header className="flex flex-wrap items-start justify-between gap-2 border-b px-3 py-2.5 min-[1280px]:px-3">
      <div className="min-w-0">
        <p className="text-[11px] leading-4 text-muted-foreground">
          {profileLabel}
        </p>
        <h1 className="mt-0.5 text-[17px] leading-5 font-semibold tracking-tight">
          Maintainer inbox
        </h1>
        <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
          Open pull requests that need your next decision.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <InboxFreshness
          status={refreshStatus}
          {...(snapshot === undefined ? {} : { snapshot })}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={onRefresh}
          disabled={refreshStatus === "Refreshing"}
          aria-label={
            refreshStatus === "Refreshing"
              ? "Refresh all — refresh already running"
              : "Refresh all watched repositories"
          }
        >
          {refreshStatus === "Refreshing" ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Clock3 />
          )}
          Refresh all
        </Button>
      </div>
    </header>
  );
}

function InboxFiltersBar({
  queueOpen,
  onToggleQueue,
  search,
  onSearchChange,
  repos,
  repoItems,
  selectedRepo,
  onRepositoryChange,
  sort,
  onSortChange,
  visibleCount,
  inspectorOpen,
  onToggleInspector,
}: {
  readonly queueOpen: boolean;
  readonly onToggleQueue: () => void;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly repos?: ReadonlyArray<{ host: string; owner: string; repo: string }>;
  readonly repoItems: ReadonlyArray<{ label: string; value: string }>;
  readonly selectedRepo: string;
  readonly onRepositoryChange: (value: string) => void;
  readonly sort: InboxSort;
  readonly onSortChange: (value: InboxSort) => void;
  readonly visibleCount: number;
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
}): React.JSX.Element {
  return (
    <section
      className="sticky top-0 z-10 flex min-h-10 flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-1.5 backdrop-blur"
      aria-label="Inbox filters"
    >
      <Button
        className="min-[1280px]:hidden"
        size="sm"
        variant="outline"
        onClick={onToggleQueue}
        aria-expanded={queueOpen}
      >
        <Filter /> Queues
      </Button>
      <InputGroup className="h-8 min-w-40 flex-1">
        <InputGroupAddon className="pl-2 [&>svg]:size-3.5">
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          className="h-8 text-xs"
          placeholder="Filter pull requests"
          aria-label="Filter pull requests"
        />
      </InputGroup>
      {repos !== undefined && repos.length > 0 ? (
        <Select
          items={repoItems}
          value={selectedRepo}
          onValueChange={(value) => onRepositoryChange(value ?? "")}
        >
          <SelectTrigger
            size="sm"
            className="min-w-32 max-w-44 text-xs"
            aria-label="Filter by repository"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {repoItems.map((item) => (
              <SelectItem
                key={item.value}
                value={item.value}
                className="text-xs"
              >
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Select
        value={sort}
        onValueChange={(value) => {
          const next = inboxSortFrom(value);
          if (next !== undefined) onSortChange(next);
        }}
      >
        <SelectTrigger
          size="sm"
          className="min-w-28 text-xs"
          aria-label="Sort pull requests"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="priority" className="text-xs">
            Priority
          </SelectItem>
          <SelectItem value="updated" className="text-xs">
            Last updated
          </SelectItem>
          <SelectItem value="repository" className="text-xs">
            Repository
          </SelectItem>
          <SelectItem value="size" className="text-xs">
            Change size
          </SelectItem>
        </SelectContent>
      </Select>
      <span className="text-[11px] tabular-nums text-muted-foreground">
        {visibleCount} open
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onToggleInspector}
        aria-label={
          inspectorOpen ? "Hide review details" : "Show review details"
        }
        aria-expanded={inspectorOpen}
      >
        {inspectorOpen ? <ChevronRight /> : <ChevronLeft />}
      </Button>
    </section>
  );
}

function InboxRowsPanel({
  listRef,
  visibleRows,
  selected,
  multipleRepositories,
  onKeyDown,
  onSelectRow,
  onActionRow,
}: {
  readonly listRef: React.RefObject<HTMLDivElement | null>;
  readonly visibleRows: ReadonlyArray<InboxRow>;
  readonly selected: InboxRow | undefined;
  readonly multipleRepositories: boolean;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onSelectRow: (row: InboxRow) => void;
  readonly onActionRow: (row: InboxRow) => void;
}): React.JSX.Element {
  return (
    <>
      <div
        aria-hidden="true"
        className="hidden grid-cols-[minmax(0,1fr)_7rem_10.5rem_1.75rem_2.75rem] items-center gap-3 border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground min-[1280px]:grid"
      >
        <span>Pull request</span>
        <span>Author</span>
        <span>Changes</span>
        <span>CI</span>
        <span className="text-right">Updated</span>
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Pull requests"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="divide-y outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {visibleRows.map((row) => {
          const key = inboxIdentityKey(row);
          const active =
            selected !== undefined && key === inboxIdentityKey(selected);
          return (
            <InboxRowItem
              key={key}
              row={row}
              selected={active}
              showRepository={multipleRepositories}
              onSelect={() => onSelectRow(row)}
              onAction={() => onActionRow(row)}
            />
          );
        })}
        {visibleRows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No open pull requests match this view.
          </div>
        ) : null}
      </div>
    </>
  );
}

function ReviewDetailsPanel({
  inspectorOpen,
  narrow,
  selected,
  freshness,
  onToggleInspector,
  onAction,
}: {
  readonly inspectorOpen: boolean;
  readonly narrow: boolean;
  readonly selected: InboxRow | undefined;
  readonly freshness: "fresh" | "cached";
  readonly onToggleInspector: () => void;
  readonly onAction: () => void;
}): React.JSX.Element {
  return (
    <>
      <aside
        className={cn(
          "hidden min-w-0 overflow-hidden border-l min-[1280px]:block",
          !inspectorOpen && "min-[1280px]:hidden",
        )}
        aria-label="Review details"
      >
        <ScrollArea className="h-full overflow-x-hidden">
          <Inspector
            {...(selected === undefined ? {} : { row: selected })}
            freshness={freshness}
            onAction={onAction}
          />
        </ScrollArea>
      </aside>
      <Sheet
        open={narrow && inspectorOpen && selected !== undefined}
        onOpenChange={(open) => {
          if (!open && narrow) onToggleInspector();
        }}
      >
        <SheetContent
          side="right"
          className="w-[min(24rem,calc(100vw-1rem))] p-0 min-[1280px]:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Review details</SheetTitle>
            <SheetDescription>
              Selected pull request details and actions.
            </SheetDescription>
          </SheetHeader>
          <Inspector
            {...(selected === undefined ? {} : { row: selected })}
            freshness={freshness}
            onAction={onAction}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

function SaveViewDialog({
  open,
  onOpenChange,
  profileLabel,
  name,
  onNameChange,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly profileLabel: string;
  readonly name: string;
  readonly onNameChange: (value: string) => void;
  readonly onSave: () => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save current view</DialogTitle>
          <DialogDescription>
            Save the queue, filter, and sort locally for {profileLabel}.
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor="saved-view-name">View name</Label>
        <Input
          id="saved-view-name"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="e.g. Waiting on customer"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={name.trim().length === 0}>
            <Save /> Save view
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteViewAlertDialog({
  deleteView,
  onOpenChange,
  onConfirm,
}: {
  readonly deleteView: SavedInboxView | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  return (
    <AlertDialog open={deleteView !== undefined} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete saved view?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes only the local shortcut. Pull requests and reviews are
            unchanged.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete view
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function InboxFreshness({
  snapshot,
  status,
}: {
  readonly snapshot?: {
    readonly state: "current" | "partial" | "failed_cached" | "unavailable";
    readonly refreshedAt?: string | undefined;
  };
  readonly status:
    | "Refreshing"
    | "Current"
    | "Aged"
    | "Partial"
    | "Cached after refresh failure"
    | "Unavailable"
    | "Paused";
}): React.JSX.Element {
  const stable = status === "Current";
  return (
    <Badge
      variant={stable ? "secondary" : "outline"}
      className="h-5 max-w-full px-1.5 text-[10px]"
      title={snapshot?.refreshedAt}
    >
      GitHub: {status}
    </Badge>
  );
}

function QueueRail({
  rows,
  view,
  savedViews,
  selectedRepo,
  open,
  onSelect,
  onSelectSaved,
  onSaveCurrent,
  onDeleteSaved,
  onToggle,
}: {
  readonly rows: ReadonlyArray<InboxRow>;
  readonly view: InboxView;
  readonly savedViews: ReadonlyArray<SavedInboxView>;
  readonly selectedRepo: string;
  readonly open: boolean;
  readonly onSelect: (view: InboxView) => void;
  readonly onSelectSaved: (view: SavedInboxView) => void;
  readonly onSaveCurrent: () => void;
  readonly onDeleteSaved: (view: SavedInboxView) => void;
  readonly onToggle: () => void;
}): React.JSX.Element {
  if (!open)
    return (
      <aside className="hidden border-r min-[1280px]:flex min-[1280px]:justify-center min-[1280px]:pt-2">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onToggle}
          aria-label="Show inbox queues"
        >
          <PanelLeftOpen />
        </Button>
      </aside>
    );
  return (
    <aside
      className="border-r bg-muted/10 max-[1279px]:border-b min-[1280px]:min-h-0"
      aria-label="Inbox queues"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Queues
        </p>
        <Button
          className="hidden min-[1280px]:inline-flex"
          size="icon-sm"
          variant="ghost"
          onClick={onToggle}
          aria-label="Hide inbox queues"
        >
          <PanelLeftClose />
        </Button>
      </div>
      <nav
        className="flex gap-0.5 overflow-x-auto px-2 pb-1.5 min-[1280px]:flex-col"
        aria-label="Inbox views"
      >
        {inboxQueues.map((item) => (
          <Button
            key={item.id}
            variant={view === item.id ? "secondary" : "ghost"}
            size="sm"
            className="h-7 justify-between whitespace-nowrap text-xs min-[1280px]:w-full"
            onClick={() => onSelect(item.id)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Badge
                variant="ghost"
                aria-hidden="true"
                className={cn(
                  "size-1.5 min-w-1.5 shrink-0 rounded-full border-0 p-0",
                  queueIndicatorClass(item.id),
                )}
              />
              {item.label}
            </span>
            <Badge
              variant="outline"
              className="ml-2 h-4 min-w-4 px-1 text-[10px]"
            >
              {viewCount(rows, item.id, selectedRepo)}
            </Badge>
          </Button>
        ))}
      </nav>
      <Separator className="my-1.5" />
      <div className="flex items-center justify-between px-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Saved views
        </p>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onSaveCurrent}
          aria-label="Save current view"
        >
          <Save />
        </Button>
      </div>
      <div className="space-y-0.5 px-2 pb-2">
        {savedViews.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            No saved views
          </p>
        ) : (
          savedViews.map((item) => (
            <div key={item.id} className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 min-w-0 flex-1 justify-start truncate text-xs"
                onClick={() => onSelectSaved(item)}
              >
                {item.name}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Delete ${item.name} saved view`}
                onClick={() => onDeleteSaved(item)}
              >
                <Trash2 />
              </Button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function InboxRowItem({
  row,
  selected,
  showRepository,
  onSelect,
  onAction,
}: {
  readonly row: InboxRow;
  readonly selected: boolean;
  readonly showRepository: boolean;
  readonly onSelect: () => void;
  readonly onAction: () => void;
}): React.JSX.Element {
  const key = inboxIdentityKey(row);
  return (
    <button
      id={`inbox-row-${key}`}
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => {
        onSelect();
        onAction();
      }}
      className={cn(
        "block w-full content-auto border-l-2 border-transparent px-3 py-2 text-left transition-colors [contain-intrinsic-size:auto_60px] hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "border-l-primary bg-primary/8",
      )}
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 min-[1280px]:grid-cols-[minmax(0,1fr)_7rem_10.5rem_1.75rem_2.75rem]">
        <div className="flex min-w-0 items-start gap-2">
          <GitPullRequest className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <p
                className="truncate text-[13px] leading-5 font-medium"
                title={`#${row.identity.number} ${row.title}`}
              >
                #{row.identity.number} {row.title}
              </p>
              {row.isDraft ? (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                  Draft
                </Badge>
              ) : null}
            </div>
            {showRepository ? (
              <p
                className="truncate text-[11px] leading-4 text-muted-foreground"
                title={`${row.identity.owner}/${row.identity.repo}`}
              >
                {row.identity.owner}/{row.identity.repo}
              </p>
            ) : null}
          </div>
        </div>
        <span
          className="hidden truncate text-[11px] text-muted-foreground min-[1280px]:block"
          title={row.author}
        >
          {row.author}
        </span>
        <span className="hidden min-[1280px]:block">
          <ChangeSize stats={row.changeStats} />
        </span>
        <span className="hidden min-[1280px]:block">
          <CheckIcon overall={row.checks.overall} />
        </span>
        <span className="text-right text-[11px] leading-5 text-muted-foreground">
          {relativeTime(row.updatedAt)}
        </span>
        <div className="col-span-2 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground min-[1280px]:hidden">
          <CheckIcon overall={row.checks.overall} />
          <span className="truncate">{row.author}</span>
          <ChangeSize stats={row.changeStats} />
        </div>
      </div>
    </button>
  );
}

function Inspector({
  row,
  freshness,
  onAction,
}: {
  readonly row?: InboxRow;
  readonly freshness: "fresh" | "cached";
  readonly onAction: () => void | undefined;
}): React.JSX.Element {
  if (row === undefined)
    return (
      <div className="p-3 text-sm text-muted-foreground">
        Select a pull request to inspect its exact review state.
      </div>
    );
  const reviewChanged =
    row.latestReview !== undefined && !row.latestReview.matchesCurrentHead;
  return (
    <div className="space-y-3 p-3">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Review details
        </p>
        <h2 className="mt-1.5 text-[13px] leading-5 font-semibold">
          #{row.identity.number} {row.title}
        </h2>
        <p
          className="mt-0.5 truncate text-[11px] text-muted-foreground"
          title={`${row.identity.owner}/${row.identity.repo}`}
        >
          {row.identity.owner}/{row.identity.repo}
        </p>
      </div>
      <Separator />
      <div className="space-y-1.5 text-[11px]">
        <Detail label="Author" value={row.author} />
        <Detail
          label="Branch"
          value={`${row.baseBranch} ← ${row.headBranch}`}
        />
        <Detail label="Current head" value={shortSha(row.currentHeadSha)} />
        <Detail label="Checks" value={row.checks.overall} />
        <Detail label="Changes" value={changeStatsText(row.changeStats)} />
        {row.latestReview === undefined ? (
          <Detail label="Last review" value="Not reviewed" />
        ) : (
          <>
            <Detail
              label="Reviewed head"
              value={shortSha(row.latestReview.reviewedHeadSha)}
            />
            <Detail
              label="Local review"
              value={reviewChanged ? "Updates available" : "Current"}
            />
          </>
        )}
      </div>
      {reviewChanged ? (
        <Card className="gap-1.5 border-primary/30 bg-primary/5 py-2.5">
          <CardHeader className="px-2.5">
            <CardTitle className="text-xs">Updates since your review</CardTitle>
            <CardDescription className="text-[11px] leading-4">
              Current head differs from the exact saved review head. Open it,
              then use Refresh to adopt new code.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {freshness === "cached" ? (
        <Card className="gap-1.5 border-amber-500/30 bg-amber-500/5 py-2.5">
          <CardContent className="flex gap-2 px-2.5 text-[11px] leading-4 text-muted-foreground">
            <CircleAlert className="size-3.5 shrink-0 text-amber-500" />
            GitHub data is cached. Merge-oriented actions remain unavailable.
          </CardContent>
        </Card>
      ) : null}
      <Button
        size="sm"
        className="h-8 w-full text-xs"
        onClick={onAction}
        disabled={
          freshness === "cached" &&
          row.recommendedAction.kind === "open_merge_readiness"
        }
      >
        {actionIcon(row.recommendedAction.kind)}
        {inboxActionLabel(row.recommendedAction.kind)}
      </Button>
      <p className="text-[11px] leading-4 text-muted-foreground">
        Starting a review is read-only. Patchdesk requires a separate
        confirmation for every GitHub write.
      </p>
    </div>
  );
}

function Detail({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">
        {value}
      </span>
    </div>
  );
}
/** Check status as a single glyph, with the state kept for assistive technology. */
function CheckIcon({
  overall,
}: {
  readonly overall: InboxRow["checks"]["overall"];
}): React.JSX.Element {
  const icon =
    overall === "passing" ? (
      <CheckCircle2 className="size-3.5 text-emerald-700 dark:text-emerald-400" />
    ) : overall === "failing" ? (
      <CircleAlert className="size-3.5 text-rose-700 dark:text-rose-400" />
    ) : overall === "pending" ? (
      <Clock3 className="size-3.5 text-muted-foreground" />
    ) : overall === "skipped" ? (
      <CircleSlash className="size-3.5 text-muted-foreground" />
    ) : (
      <CircleDashed className="size-3.5 text-muted-foreground" />
    );
  return (
    <span className="inline-flex items-center" title={`Checks ${overall}`}>
      {icon}
      <span className="sr-only">Checks {overall}</span>
    </span>
  );
}

/** Change size with the workbench diff colors, so scale reads before the title does. */
function ChangeSize({
  stats,
}: {
  readonly stats: InboxRow["changeStats"];
}): React.JSX.Element {
  const { additions, deletions, changedFiles } = stats;
  if (
    additions === undefined &&
    deletions === undefined &&
    changedFiles === undefined
  )
    return <span className="text-[11px] text-muted-foreground">—</span>;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] tabular-nums"
      title={changeStatsText(stats)}
    >
      {changedFiles === undefined ? null : (
        <span className="text-muted-foreground">
          {changedFiles} {changedFiles === 1 ? "file" : "files"}
        </span>
      )}
      {additions === undefined ? null : (
        <span className="text-emerald-700 dark:text-emerald-400">
          +{compactCount(additions)}
        </span>
      )}
      {deletions === undefined ? null : (
        <span className="text-rose-700 dark:text-rose-400">
          -{compactCount(deletions)}
        </span>
      )}
    </span>
  );
}

/** Keeps large line counts inside the column; the title attribute carries the exact value. */
function compactCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}k`;
  return `${Math.round(value / 100_000) / 10}M`;
}
function inboxActionLabel(kind: InboxRow["recommendedAction"]["kind"]): string {
  switch (kind) {
    case "run_review":
      return recoveryActionLabel("run_review");
    case "open_saved_review":
      return "Open Review";
    case "open_merge_readiness":
      return "Open merge readiness";
    case "open_discussion":
      return "Review author response";
  }
}

function viewCount(
  rows: ReadonlyArray<InboxRow>,
  view: InboxView,
  selectedRepo: string,
): number {
  return filterRows(rows, view, "", selectedRepo).length;
}
function queueIndicatorClass(view: InboxView): string {
  switch (view) {
    case "my_inbox":
    case "updated":
      return "bg-status-info";
    case "needs_review":
      return "bg-status-warning";
    case "waiting":
      return "bg-muted-foreground/60";
    case "checks_failing":
      return "bg-destructive";
    case "ready_to_merge":
      return "bg-status-success";
    case "all_open":
      return "bg-muted-foreground";
  }
}
function filterRows(
  rows: ReadonlyArray<InboxRow>,
  view: InboxView,
  search: string,
  selectedRepo: string = "",
): ReadonlyArray<InboxRow> {
  const needle = search.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      matchesView(row, view) &&
      (needle.length === 0 ||
        `${row.identity.owner}/${row.identity.repo} ${row.title} ${row.author} #${row.identity.number}`
          .toLocaleLowerCase()
          .includes(needle)) &&
      (selectedRepo.length === 0 ||
        `${row.identity.owner}/${row.identity.repo}` === selectedRepo),
  );
}
function matchesView(row: InboxRow, view: InboxView): boolean {
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
function actionIcon(
  kind: InboxRow["recommendedAction"]["kind"],
): React.JSX.Element {
  return kind === "run_review" ? <CheckCircle2 /> : <Clock3 />;
}
function shortSha(value: string): string {
  return value.slice(0, 12);
}
function changeStatsText(stats: InboxRow["changeStats"]): string {
  const { additions, deletions, changedFiles } = stats;
  const parts = [
    changedFiles === undefined ? undefined : `${changedFiles} files`,
    additions === undefined ? undefined : `+${additions}`,
    deletions === undefined ? undefined : `-${deletions}`,
  ].filter((value): value is string => value !== undefined);
  return parts.length === 0 ? "Not available" : parts.join(" · ");
}
function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1_440)}d`;
}
// `window` or `window.matchMedia` may be absent when this runs under
// node/jsdom test environments, so every caller reaches this indirectly.
function narrowViewportQuery(): MediaQueryList | undefined {
  return globalThis.window?.matchMedia?.("(max-width: 1279px)");
}
function isNarrowViewport(): boolean {
  return narrowViewportQuery()?.matches ?? false;
}
const inboxSorts: ReadonlyArray<InboxSort> = [
  "priority",
  "updated",
  "repository",
  "size",
];
function inboxSortFrom(value: string | null): InboxSort | undefined {
  return inboxSorts.find((sort) => sort === value);
}
function resolveInboxView(value: string): InboxView | undefined {
  return inboxQueues.find((queue) => queue.id === value)?.id;
}
