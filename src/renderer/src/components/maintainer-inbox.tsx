import { type KeyboardEvent } from "react";
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

import {
  inboxIdentityKey,
  type InboxRow,
  type InboxView,
} from "@/renderer-contracts";
import { recoveryActionLabel } from "@/review-copy";
import { LabelChip } from "./label-chip";
import {
  filterRows,
  useInboxView,
  type ReviewInitialSection,
} from "../hooks/use-inbox-view";
import { inboxQueues } from "@/inbox-queues";
import type { InboxSort, SavedInboxView } from "@/inbox-view-preferences";
import { formatInboxAge } from "@/inbox-refresh-scheduler";
import { isInboxCacheDegraded } from "../../../domain/inbox-freshness-policy";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
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

export type { ReviewInitialSection } from "../hooks/use-inbox-view";

type MaintainerInboxProps = {
  readonly profileId: string;
  readonly profileLabel: string;
  /** Confirmed remote scope; Phase 1 only permits open pull requests. */
  readonly scope?: "open";
  readonly page?: number;
  readonly hasPreviousPage?: boolean;
  readonly hasNextPage?: boolean;
  readonly onPreviousPage?: () => void;
  readonly onNextPage?: () => void;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly repos?: ReadonlyArray<{ host: string; owner: string; repo: string }>;
  readonly freshness: "fresh" | "cached";
  readonly snapshot?: {
    readonly state:
      | "current"
      | "partial"
      | "failed_cached"
      | "stale_cached"
      | "unavailable";
    readonly refreshedAt?: string | undefined;
  };
  readonly refreshStatus:
    | "Refreshing"
    | "Current"
    | "Aged"
    | "Partial"
    | "Cached after refresh failure"
    | "Stale"
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
  scope = "open",
  page = 1,
  hasPreviousPage = false,
  hasNextPage = false,
  onPreviousPage = () => undefined,
  onNextPage = () => undefined,
  rows,
  repos,
  freshness,
  snapshot,
  refreshStatus,
  onRefresh,
  onOpenReview,
  onOpenReviewId,
}: MaintainerInboxProps): React.JSX.Element {
  const reposField = repos === undefined ? {} : { repos };
  const {
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
  } = useInboxView({
    profileId,
    rows,
    ...reposField,
    onOpenReview,
    onOpenReviewId,
  });

  const main = (
    <div className="min-w-0">
      <InboxHeader
        profileLabel={profileLabel}
        scope={scope}
        page={page}
        hasPreviousPage={hasPreviousPage}
        hasNextPage={hasNextPage}
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
        refreshStatus={refreshStatus}
        {...(snapshot === undefined ? {} : { snapshot })}
        onRefresh={onRefresh}
      />
      {refreshStatus === "Stale" && snapshot?.refreshedAt !== undefined ? (
        <StaleInboxBanner refreshedAt={snapshot.refreshedAt} />
      ) : null}
      <InboxFiltersBar
        queueOpen={queueOpen}
        onToggleQueue={toggleQueue}
        search={search}
        onSearchChange={changeSearch}
        repoItems={repoItems}
        selectedRepos={selectedRepos}
        onRepositoriesChange={changeSelectedRepos}
        labelItems={labelItems}
        selectedLabels={selectedLabels}
        onLabelChange={changeSelectedLabels}
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
        onActionRow={triggerAction}
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
        selectedRepos={selectedRepos}
        selectedLabels={selectedLabels}
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
          selected === undefined ? undefined : triggerAction(selected)
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

/** Blocking notice for the hard-refuse cache tier: names the elapsed age and
 * defers the corrective action to the GitHub-auth notice already on screen. */
function StaleInboxBanner({
  refreshedAt,
}: {
  readonly refreshedAt: string;
}): React.JSX.Element {
  return (
    <Alert variant="destructive" className="mx-3 mt-2">
      <AlertTitle>Priority order may be unreliable</AlertTitle>
      <AlertDescription>
        This queue reflects a snapshot from{" "}
        {formatInboxAge(Date.now() - Date.parse(refreshedAt))}. GitHub sign-in
        could not be verified since then, so ordering, checks, and review state
        below are not current. See the GitHub authentication notice above to
        reconnect.
      </AlertDescription>
    </Alert>
  );
}

function InboxHeader({
  profileLabel,
  scope,
  page,
  hasPreviousPage,
  hasNextPage,
  refreshStatus,
  snapshot,
  onRefresh,
  onPreviousPage,
  onNextPage,
}: {
  readonly profileLabel: string;
  readonly scope: "open";
  readonly page: number;
  readonly hasPreviousPage: boolean;
  readonly hasNextPage: boolean;
  readonly refreshStatus:
    | "Refreshing"
    | "Current"
    | "Aged"
    | "Partial"
    | "Cached after refresh failure"
    | "Stale"
    | "Unavailable"
    | "Paused";
  readonly snapshot?: {
    readonly state:
      | "current"
      | "partial"
      | "failed_cached"
      | "stale_cached"
      | "unavailable";
    readonly refreshedAt?: string | undefined;
  };
  readonly onRefresh: () => void;
  readonly onPreviousPage: () => void;
  readonly onNextPage: () => void;
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
          {scope === "open"
            ? "Open pull requests that need your next decision."
            : "Pull requests returned by GitHub."}
        </p>
        <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
          GitHub updates order this page. Local sorting applies only here.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1" aria-label="Inbox pages">
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={onPreviousPage}
            disabled={!hasPreviousPage || refreshStatus === "Refreshing"}
          >
            Back
          </Button>
          <span className="min-w-12 text-center text-xs text-muted-foreground">
            Page {page}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={onNextPage}
            disabled={!hasNextPage || refreshStatus === "Refreshing"}
          >
            Next
          </Button>
        </div>
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
  repoItems,
  selectedRepos,
  onRepositoriesChange,
  labelItems,
  selectedLabels,
  onLabelChange,
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
  readonly repoItems: ReadonlyArray<{ label: string; value: string }>;
  readonly selectedRepos: ReadonlyArray<string>;
  readonly onRepositoriesChange: (value: ReadonlyArray<string>) => void;
  readonly labelItems: ReadonlyArray<{ label: string; value: string }>;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly onLabelChange: (value: ReadonlyArray<string>) => void;
  readonly sort: InboxSort;
  readonly onSortChange: (value: InboxSort) => void;
  readonly visibleCount: number;
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
}): React.JSX.Element {
  const selectedRepoSet = new Set(selectedRepos);
  const selectedLabelSet = new Set(selectedLabels);
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
      {repoItems.length > 0 ? (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="min-w-28 max-w-40 justify-start text-xs"
                aria-label="Filter by repository"
              >
                <span className="truncate">
                  {repoFilterTriggerText(selectedRepos)}
                </span>
              </Button>
            }
          />
          <PopoverContent align="start">
            {selectedRepos.length > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                className="mb-1 w-full justify-start"
                onClick={() => onRepositoriesChange([])}
              >
                Clear
              </Button>
            ) : null}
            <div className="max-h-64 overflow-y-auto">
              <ul className="flex flex-col gap-0.5" aria-label="Repositories">
                {repoItems.map((item) => {
                  const checked = selectedRepoSet.has(item.value);
                  return (
                    <li key={item.value}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted/50">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() =>
                            onRepositoriesChange(
                              checked
                                ? selectedRepos.filter(
                                    (value) => value !== item.value,
                                  )
                                : [...selectedRepos, item.value],
                            )
                          }
                        />
                        {item.label}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
      {labelItems.length > 0 ? (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="min-w-28 max-w-40 justify-start text-xs"
                aria-label="Filter by label"
              >
                <span className="truncate">
                  {labelFilterTriggerText(selectedLabels)}
                </span>
              </Button>
            }
          />
          <PopoverContent align="start">
            {selectedLabels.length > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                className="mb-1 w-full justify-start"
                onClick={() => onLabelChange([])}
              >
                Clear
              </Button>
            ) : null}
            <div className="max-h-64 overflow-y-auto">
              <ul className="flex flex-col gap-0.5" aria-label="Labels">
                {labelItems.map((item) => {
                  const checked = selectedLabelSet.has(item.value);
                  return (
                    <li key={item.value}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted/50">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() =>
                            onLabelChange(
                              checked
                                ? selectedLabels.filter(
                                    (name) => name !== item.value,
                                  )
                                : [...selectedLabels, item.value],
                            )
                          }
                        />
                        {item.label}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
      <Select
        value={sort}
        items={[
          { label: "Priority", value: "priority" },
          { label: "Last updated", value: "updated" },
          { label: "Repository", value: "repository" },
          { label: "Change size", value: "size" },
        ]}
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
          <SelectGroup>
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
          </SelectGroup>
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

/** Trigger copy for the label filter: names the single selection, or a count once more than one is picked. */
function labelFilterTriggerText(selected: ReadonlyArray<string>): string {
  if (selected.length === 0) return "All labels";
  if (selected.length === 1) return selected[0] ?? "All labels";
  return `${selected.length} labels`;
}

/** Trigger copy for the repository filter: names the single selection, or a count once more than one is picked. */
function repoFilterTriggerText(selected: ReadonlyArray<string>): string {
  if (selected.length === 0) return "All repositories";
  if (selected.length === 1) return selected[0] ?? "All repositories";
  return `${selected.length} repositories`;
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
        className="hidden grid-cols-[minmax(10rem,1fr)_8rem_6rem_8rem_1.75rem_2.75rem] items-center gap-3 border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground min-[1280px]:grid"
      >
        <span>Pull request</span>
        <span>Labels</span>
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
    readonly state:
      | "current"
      | "partial"
      | "failed_cached"
      | "stale_cached"
      | "unavailable";
    readonly refreshedAt?: string | undefined;
  };
  readonly status:
    | "Refreshing"
    | "Current"
    | "Aged"
    | "Partial"
    | "Cached after refresh failure"
    | "Stale"
    | "Unavailable"
    | "Paused";
}): React.JSX.Element {
  const stable = status === "Current";
  const ageMs =
    snapshot?.refreshedAt === undefined
      ? undefined
      : Date.now() - Date.parse(snapshot.refreshedAt);
  const degraded = ageMs !== undefined && isInboxCacheDegraded(ageMs);
  const variant =
    status === "Stale" ? "destructive" : stable ? "secondary" : "outline";
  return (
    <div className="flex items-center gap-1.5">
      <Badge
        variant={variant}
        className={cn(
          "h-5 max-w-full px-1.5 text-[10px]",
          degraded &&
            status !== "Stale" &&
            "border-amber-500/40 text-amber-600 dark:text-amber-400",
        )}
        title={snapshot?.refreshedAt}
      >
        GitHub: {status}
      </Badge>
      {!stable &&
      status !== "Refreshing" &&
      status !== "Paused" &&
      ageMs !== undefined ? (
        <span className="text-[10px] text-muted-foreground">
          Updated {formatInboxAge(ageMs)}
        </span>
      ) : null}
    </div>
  );
}

function QueueRail({
  rows,
  view,
  savedViews,
  selectedRepos,
  selectedLabels,
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
  readonly selectedRepos: ReadonlyArray<string>;
  readonly selectedLabels: ReadonlyArray<string>;
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
              {viewCount(rows, item.id, selectedRepos, selectedLabels)}
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
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 min-[1280px]:grid-cols-[minmax(10rem,1fr)_8rem_6rem_8rem_1.75rem_2.75rem]">
        <div className="flex min-w-0 items-start gap-2">
          <GitPullRequest className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <p
                data-slot="pull-request-title"
                className="min-w-0 line-clamp-2 text-[13px] leading-5 font-medium"
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
            <PullRequestLabelColumn
              labels={row.labels}
              className="mt-1 min-[1280px]:hidden"
              slot="pull-request-labels-mobile"
            />
          </div>
        </div>
        <PullRequestLabelColumn
          labels={row.labels}
          className="hidden min-[1280px]:flex"
          slot="pull-request-label-column"
        />
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

function PullRequestLabelColumn({
  labels,
  className,
  slot,
}: {
  readonly labels: InboxRow["labels"];
  readonly className: string;
  readonly slot: "pull-request-label-column" | "pull-request-labels-mobile";
}): React.JSX.Element {
  return (
    <div
      data-slot={slot}
      className={cn("min-w-0 flex-col items-start gap-1", className)}
    >
      {labels.map((label) => (
        <LabelChip key={label.name} label={label} />
      ))}
    </div>
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
      </div>
      {row.labels.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <span className="text-muted-foreground">Labels</span>
          {row.labels.map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
          {row.labelCount !== undefined &&
          row.labelCount > row.labels.length ? (
            <span className="text-muted-foreground">
              +{row.labelCount - row.labels.length} more
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-1.5 text-[11px]">
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
  selectedRepos: ReadonlyArray<string>,
  selectedLabels: ReadonlyArray<string>,
): number {
  return filterRows(rows, view, "", selectedRepos, selectedLabels).length;
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
const inboxSorts: ReadonlyArray<InboxSort> = [
  "priority",
  "updated",
  "repository",
  "size",
];
function inboxSortFrom(value: string | null): InboxSort | undefined {
  return inboxSorts.find((sort) => sort === value);
}
