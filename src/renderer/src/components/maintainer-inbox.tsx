import { useEffect, useState, type KeyboardEvent } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  UserRoundCheck,
} from "lucide-react";

import {
  inboxIdentityKey,
  type InboxRow,
  type RepositoryLabelListResponse,
} from "@/renderer-contracts";
import { recoveryActionLabel } from "@/review-copy";
import {
  forbiddenCopy,
  projectRepositoryLabelReadState,
  rateLimitedCopy,
  type RepositoryLabelReadState,
} from "@/github-read-failure-copy";
import { LabelChip } from "./label-chip";
import { InboxRowItem } from "./inbox-row-item";
import { useInboxView } from "../hooks/use-inbox-view";
import { formatInboxAge, type InboxFreshnessLabel } from "@/inbox-freshness";
import { isInboxCacheDegraded } from "../../../domain/inbox-freshness-policy";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  INBOX_PAGE_SIZES,
  INBOX_STATE_FILTERS,
  type InboxPageSize,
  type InboxDataFreshness,
  type InboxSnapshotState,
  type InboxStateFilter,
} from "../../../domain/maintainer-inbox";
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
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  ReviewOpeningButtonContent,
  type ReviewOpeningState,
} from "./review-opening-status";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { RepositoryIdentity } from "../../../domain/repository-identity";

/**
 * Feeds the label filter popover the Selected repository's real,
 * repository-wide labels (`GET /v1/inbox/labels`) rather than deriving them
 * from `rows` (one loaded page) — mirrors `LabelPickerActions`
 * (label-picker.tsx) for the same read, minus write actions this filter
 * never performs. `undefined` only before the screen has a Selected
 * repository to read labels from (absent only during bootstrap, before the
 * watchlist is known); the picker withholds
 * its trigger entirely in that case, the same way `LabelPicker` does for
 * `actions === undefined`.
 */
export type InboxLabelActions = {
  readonly fetchLabels: () => Promise<RepositoryLabelListResponse | undefined>;
};

/** Stable option value for the repository picker's `Select`. */
function repositoryKey(repo: RepositoryIdentity): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}

type MaintainerInboxProps = {
  readonly profileId: string;
  readonly profileLabel: string;
  /** Requested state; App owns remote state transitions. The filter bar's
   * state `Select` reflects this immediately, even before `listPending`
   * clears. */
  readonly state?: InboxStateFilter;
  /** True while `rows` still belongs to the previous request (a filter
   * change is in flight). The row list, row count, and details panel hold a
   * loading state instead of rendering that data under the newly requested
   * filter's label. */
  readonly listPending?: boolean;
  /** Confirmed remote page size; App owns remote page-size transitions. */
  readonly pageSize?: InboxPageSize;
  readonly hasPreviousPage?: boolean;
  readonly hasNextPage?: boolean;
  readonly onStateChange?: (state: InboxStateFilter) => void;
  /** The label filter, sent to GitHub as `label:"NAME"` qualifiers — never a
   * local, in-page filter (ADR 0031/0032). App owns the request transition. */
  readonly selectedLabels?: ReadonlyArray<string>;
  readonly onLabelsChange?: (labels: ReadonlyArray<string>) => void;
  /** Re-reads GitHub. Refresh stays explicit under ADR 0032 — this is the
   * in-screen affordance for it, beside the View menu's Refresh command. */
  readonly onRefresh?: () => void;
  /** The "Awaiting review from you" preset (ADR 0031), sent to GitHub as
   * `user-review-requested:@me` — a filter preset that composes with the
   * state and label filters, never a separate queue. */
  readonly awaitingMyReview?: boolean;
  readonly onAwaitingMyReviewChange?: (value: boolean) => void;
  /** Absent only before the screen has a Selected repository to read labels
   * from (absent only during bootstrap). See {@link InboxLabelActions}. */
  readonly labelActions?: InboxLabelActions;
  readonly onPageSizeChange?: (pageSize: InboxPageSize) => void;
  readonly onPreviousPage?: () => void;
  readonly onNextPage?: () => void;
  readonly rows: ReadonlyArray<InboxRow>;
  /** GitHub's true repository-wide match count for the current filter.
   * Absent on a cached or failed read that cannot know it — render that
   * absence honestly, never as 0. Never the loaded page's row count. */
  readonly matchCount?: number;
  /** The profile's full watchlist — the picker's only source of options
   * (never `/v1/watchlist/suggestions`, which answers a different question).
   * The picker does not render when this is empty; the setup checklist owns
   * the screen instead. */
  readonly repos?: ReadonlyArray<RepositoryIdentity>;
  /** The screen's root state (ADR 0031); App owns its request transition. */
  readonly selectedRepository?: RepositoryIdentity;
  readonly onRepositoryChange?: (repository: RepositoryIdentity) => void;
  readonly freshness: InboxDataFreshness;
  readonly snapshot?: {
    readonly state: InboxSnapshotState;
    readonly refreshedAt?: string | undefined;
  };
  readonly refreshStatus: InboxFreshnessLabel;
  readonly openingOperations?: ReadonlyMap<
    string,
    Exclude<ReviewOpeningState, undefined>
  >;
  readonly onOpenReview: (row: InboxRow) => void;
  readonly onOpenReviewId: (reviewId: string) => void;
};

/** Dense, keyboard-operable maintainer queue built from the parsed local API projection. */
export function MaintainerInbox({
  profileId,
  profileLabel,
  state = "open",
  listPending = false,
  pageSize = DEFAULT_INBOX_PAGE_SIZE,
  hasPreviousPage = false,
  hasNextPage = false,
  onStateChange = () => undefined,
  onRefresh = () => undefined,
  selectedLabels = [],
  onLabelsChange = () => undefined,
  awaitingMyReview = false,
  onAwaitingMyReviewChange = () => undefined,
  labelActions,
  onPageSizeChange = () => undefined,
  onPreviousPage = () => undefined,
  onNextPage = () => undefined,
  rows,
  matchCount,
  repos,
  selectedRepository,
  onRepositoryChange = () => undefined,
  freshness,
  snapshot,
  refreshStatus,
  openingOperations = new Map(),
  onOpenReview,
  onOpenReviewId,
}: MaintainerInboxProps): React.JSX.Element {
  // While a filter change is in flight, `rows` still belongs to the previous
  // request. Every row-derived view (the row list, selection, labels) must
  // not present that data under the newly requested filter's label, so it
  // is withheld here rather than threaded through and re-guarded at every
  // consumer.
  const effectiveRows = listPending ? [] : rows;
  const {
    inspectorOpen,
    narrow,
    listRef,
    selected,
    triggerAction,
    selectRow,
    toggleInspector,
    onListKeyDown,
  } = useInboxView({
    profileId,
    rows: effectiveRows,
    onOpenReview,
    onOpenReviewId,
  });

  const main = (
    <div className="min-w-0">
      <InboxHeader
        profileLabel={profileLabel}
        {...(repos === undefined ? {} : { repos })}
        {...(selectedRepository === undefined ? {} : { selectedRepository })}
        onRepositoryChange={onRepositoryChange}
        refreshStatus={refreshStatus}
        onRefresh={onRefresh}
        {...(snapshot === undefined ? {} : { snapshot })}
      />
      {refreshStatus === "Stale" && snapshot?.refreshedAt !== undefined ? (
        <StaleInboxBanner refreshedAt={snapshot.refreshedAt} />
      ) : null}
      <InboxFiltersBar
        state={state}
        onStateChange={onStateChange}
        {...(labelActions === undefined ? {} : { labelActions })}
        selectedLabels={selectedLabels}
        onLabelChange={onLabelsChange}
        awaitingMyReview={awaitingMyReview}
        onAwaitingMyReviewChange={onAwaitingMyReviewChange}
        rowCount={effectiveRows.length}
        {...(matchCount === undefined ? {} : { matchCount })}
        listPending={listPending}
        inspectorOpen={inspectorOpen}
        onToggleInspector={toggleInspector}
      />
      <InboxRowsPanel
        listRef={listRef}
        rows={effectiveRows}
        selected={selected}
        state={state}
        listPending={listPending}
        {...(matchCount === undefined ? {} : { matchCount })}
        hasLabelFilter={selectedLabels.length > 0}
        onKeyDown={onListKeyDown}
        onSelectRow={selectRow}
        onActionRow={triggerAction}
        openingOperations={openingOperations}
      />
      <InboxFooter
        pageSize={pageSize}
        hasPreviousPage={hasPreviousPage}
        hasNextPage={hasNextPage}
        refreshStatus={refreshStatus}
        onPageSizeChange={onPageSizeChange}
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
      />
    </div>
  );

  const desktopGridColumns = inspectorOpen
    ? "min-[1280px]:grid-cols-[minmax(0,1fr)_21rem]"
    : "min-[1280px]:grid-cols-[minmax(0,1fr)]";

  return (
    <div
      className={cn(
        "min-h-[calc(100vh-3rem)] min-w-0 bg-background min-[1280px]:grid min-[1280px]:h-full min-[1280px]:min-h-0 min-[1280px]:overflow-hidden",
        desktopGridColumns,
      )}
    >
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
        openingOperations={openingOperations}
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
  repos,
  selectedRepository,
  onRepositoryChange,
  refreshStatus,
  onRefresh,
  snapshot,
}: {
  readonly profileLabel: string;
  /** The profile's full watchlist; the picker hides itself when empty (the
   * setup checklist owns the screen instead), and stays visible for exactly
   * one watched repository — hiding it there would make the scoping
   * invisible. */
  readonly repos?: ReadonlyArray<RepositoryIdentity>;
  readonly selectedRepository?: RepositoryIdentity;
  readonly onRepositoryChange: (repository: RepositoryIdentity) => void;
  readonly refreshStatus: InboxFreshnessLabel;
  readonly onRefresh: () => void;
  readonly snapshot?: {
    readonly state: InboxSnapshotState;
    readonly refreshedAt?: string | undefined;
  };
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
          Pull requests for the selected repository, filtered and ordered by
          GitHub.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {repos === undefined || repos.length === 0 ? null : (
          <Select
            value={
              selectedRepository === undefined
                ? undefined
                : repositoryKey(selectedRepository)
            }
            items={repos.map((repo) => ({
              label: `${repo.owner}/${repo.repo}`,
              value: repositoryKey(repo),
            }))}
            onValueChange={(value) => {
              const next = repos.find((repo) => repositoryKey(repo) === value);
              if (next !== undefined) onRepositoryChange(next);
            }}
          >
            <SelectTrigger
              size="sm"
              className="max-w-48 text-xs"
              aria-label="Repository"
            >
              <SelectValue placeholder="Select a repository" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Repository</SelectLabel>
                {repos.map((repo) => (
                  <SelectItem
                    key={repositoryKey(repo)}
                    value={repositoryKey(repo)}
                    className="text-xs"
                  >
                    {repo.owner}/{repo.repo}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        <InboxFreshness
          status={refreshStatus}
          onRefresh={onRefresh}
          {...(snapshot === undefined ? {} : { snapshot })}
        />
      </div>
    </header>
  );
}

function InboxFiltersBar({
  state,
  onStateChange,
  labelActions,
  selectedLabels,
  onLabelChange,
  awaitingMyReview,
  onAwaitingMyReviewChange,
  rowCount,
  matchCount,
  listPending,
  inspectorOpen,
  onToggleInspector,
}: {
  readonly state: InboxStateFilter;
  readonly onStateChange: (state: InboxStateFilter) => void;
  /** Absent only before the screen has a Selected repository to read labels
   * from (absent only during bootstrap); the label filter trigger withholds itself in
   * that case, the same way `LabelPicker` does for `actions === undefined`. */
  readonly labelActions?: InboxLabelActions;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly onLabelChange: (value: ReadonlyArray<string>) => void;
  readonly awaitingMyReview: boolean;
  readonly onAwaitingMyReviewChange: (value: boolean) => void;
  readonly rowCount: number;
  readonly matchCount?: number;
  readonly listPending: boolean;
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
}): React.JSX.Element {
  return (
    <section
      className="sticky top-0 z-10 flex min-h-10 flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-1.5 backdrop-blur"
      aria-label="Inbox filters"
    >
      <Select
        value={state}
        items={INBOX_STATE_FILTERS.map((option) => ({
          label: stateFilterShortLabel(option.state),
          value: option.state,
        }))}
        onValueChange={(value) => {
          const next = INBOX_STATE_FILTERS.find(
            (option) => option.state === value,
          );
          if (next !== undefined) onStateChange(next.state);
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-28 text-xs"
          aria-label="Pull request state"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {INBOX_STATE_FILTERS.map((option) => (
              <SelectItem
                key={option.state}
                value={option.state}
                className="text-xs"
              >
                {stateFilterShortLabel(option.state)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {/* A filter preset, not a queue (ADR 0031): it composes with the state
          and label filters above rather than replacing the listing. */}
      <Toggle
        pressed={awaitingMyReview}
        onPressedChange={onAwaitingMyReviewChange}
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 px-2 text-xs"
      >
        <UserRoundCheck className="size-3.5" aria-hidden="true" />
        Awaiting review from you
      </Toggle>
      {labelActions === undefined ? null : (
        <LabelFilterPopover
          fetchLabels={labelActions.fetchLabels}
          selectedLabels={selectedLabels}
          onLabelChange={onLabelChange}
        />
      )}
      <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
        {listPending
          ? "Loading…"
          : matchCount === undefined
            ? `${rowCount} on this page`
            : `${matchCount} ${state === "open" ? "open" : "merged"}`}
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

/** Compact form of an `INBOX_STATE_FILTERS` option for the filter bar's
 * narrow `Select` — the command palette uses the full `option.label`
 * ("Open pull requests") where space isn't constrained; this trigger is
 * `w-28`. */
function stateFilterShortLabel(state: InboxStateFilter): string {
  return state === "open" ? "Open" : "Merged";
}

/** Trigger copy for the label filter: names the single selection, or a count once more than one is picked. */
function labelFilterTriggerText(selected: ReadonlyArray<string>): string {
  if (selected.length === 0) return "All labels";
  if (selected.length === 1) return selected[0] ?? "All labels";
  return `${selected.length} labels`;
}

/**
 * The Pull requests screen's label filter: fed from the Selected
 * repository's real, repository-wide labels (`GET /v1/inbox/labels`), never
 * from `rows` — a label used only on a pull request off the loaded page is
 * still offered here. Fetches on open, the same lazy-on-demand shape
 * `LabelPicker` uses for the same read (label-picker.tsx), so opening the
 * inbox never pays for a label read nobody asked for.
 */
function LabelFilterPopover({
  fetchLabels,
  selectedLabels,
  onLabelChange,
}: {
  readonly fetchLabels: () => Promise<RepositoryLabelListResponse | undefined>;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly onLabelChange: (value: ReadonlyArray<string>) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [readState, setReadState] = useState<RepositoryLabelReadState>({
    _tag: "loading",
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReadState({ _tag: "loading" });
    fetchLabels()
      .then((response) => {
        if (!cancelled) setReadState(projectRepositoryLabelReadState(response));
      })
      .catch(() => {
        if (!cancelled) setReadState({ _tag: "github_read" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, fetchLabels]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        <LabelFilterList
          readState={readState}
          selectedLabels={selectedLabels}
          onLabelChange={onLabelChange}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The label filter popover's body: its read state's message, or its list
 * of toggleable repository labels. A GitHub read failure (auth/rate-limit/
 * forbidden) says exactly what went wrong, rather than rendering as an
 * empty list — an empty list here only ever means the ready, zero-label
 * case (`readState.labels.length === 0`), never a failed read. */
function LabelFilterList({
  readState,
  selectedLabels,
  onLabelChange,
}: {
  readonly readState: RepositoryLabelReadState;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly onLabelChange: (value: ReadonlyArray<string>) => void;
}): React.JSX.Element {
  if (readState._tag === "loading")
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Loading labels…
      </p>
    );
  if (readState._tag === "github_auth")
    return (
      <p role="alert" className="text-xs text-destructive">
        GitHub authentication is required before Patchdesk can list this
        repository&apos;s labels.
      </p>
    );
  if (readState._tag === "github_read")
    return (
      <p role="alert" className="text-xs text-destructive">
        Patchdesk could not load this repository&apos;s labels. Reopen this menu
        to retry.
      </p>
    );
  if (readState._tag === "github_rate_limited")
    return (
      <p role="alert" className="text-xs text-destructive">
        {rateLimitedCopy(readState.resumeAt)}
      </p>
    );
  if (readState._tag === "github_forbidden")
    return (
      <p role="alert" className="text-xs text-destructive">
        {forbiddenCopy(readState.reason)}
      </p>
    );
  if (readState.labels.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        This repository has no labels.
      </p>
    );
  const selectedLabelSet = new Set(selectedLabels);
  return (
    <div className="max-h-64 overflow-y-auto">
      <ul className="flex flex-col gap-0.5" aria-label="Labels">
        {readState.labels.map((label) => {
          const checked = selectedLabelSet.has(label.name);
          return (
            <li key={label.name}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted/50">
                <Checkbox
                  checked={checked}
                  onCheckedChange={() =>
                    onLabelChange(
                      checked
                        ? selectedLabels.filter((name) => name !== label.name)
                        : [...selectedLabels, label.name],
                    )
                  }
                />
                {label.name}
              </label>
            </li>
          );
        })}
      </ul>
      {readState.totalCount > readState.labels.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Showing {readState.labels.length} of {readState.totalCount} labels.
          Some repository labels aren&apos;t shown.
        </p>
      ) : null}
    </div>
  );
}

/** Placeholder row count shown by {@link InboxRowsPanel} while `listPending`
 * is true, matching the row-skeleton density the initial-load skeleton
 * (`maintainer-inbox-skeleton.tsx`) uses for the same purpose. */
const pendingRowPlaceholders = [
  "pending-row-1",
  "pending-row-2",
  "pending-row-3",
  "pending-row-4",
  "pending-row-5",
  "pending-row-6",
] as const;

/** Distinct copy for an empty row list: a repository the filter genuinely
 * excludes everything from must not read the same as one with nothing open
 * at all — see ADR 0031. */
function emptyRowsMessage(
  state: InboxStateFilter,
  matchCount: number | undefined,
  hasLabelFilter: boolean,
): string {
  if (matchCount === undefined)
    return `No ${state === "open" ? "open" : "merged"} pull requests on this page.`;
  if (matchCount > 0)
    return `No ${state === "open" ? "open" : "merged"} pull requests on this page — GitHub reports ${matchCount} in total.`;
  if (hasLabelFilter) return "No pull requests match the selected labels.";
  return `This repository has no ${state === "open" ? "open" : "merged"} pull requests right now.`;
}

function InboxRowsPanel({
  listRef,
  rows,
  selected,
  state,
  listPending,
  matchCount,
  hasLabelFilter,
  onKeyDown,
  onSelectRow,
  onActionRow,
  openingOperations,
}: {
  readonly listRef: React.RefObject<HTMLDivElement | null>;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly selected: InboxRow | undefined;
  readonly state: InboxStateFilter;
  readonly listPending: boolean;
  readonly matchCount?: number;
  readonly hasLabelFilter: boolean;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onSelectRow: (row: InboxRow) => void;
  readonly onActionRow: (row: InboxRow) => void;
  readonly openingOperations: ReadonlyMap<
    string,
    Exclude<ReviewOpeningState, undefined>
  >;
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
        aria-busy={listPending}
        onKeyDown={onKeyDown}
        className="divide-y outline-none"
      >
        {listPending
          ? pendingRowPlaceholders.map((placeholder) => (
              <div
                key={placeholder}
                aria-hidden="true"
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 min-[1280px]:grid-cols-[minmax(10rem,1fr)_8rem_6rem_8rem_1.75rem_2.75rem]"
              >
                <Skeleton className="h-4 w-[min(30rem,80%)]" />
                <Skeleton className="hidden h-3 w-16 min-[1280px]:block" />
                <Skeleton className="hidden h-3 w-16 min-[1280px]:block" />
                <Skeleton className="hidden h-3 w-16 min-[1280px]:block" />
                <Skeleton className="hidden size-3.5 rounded-full min-[1280px]:block" />
                <Skeleton className="h-3 w-6 justify-self-end" />
              </div>
            ))
          : rows.map((row) => {
              const key = inboxIdentityKey(row);
              const active =
                selected !== undefined && key === inboxIdentityKey(selected);
              return (
                <InboxRowItem
                  key={key}
                  row={row}
                  selected={active}
                  onSelect={() => onSelectRow(row)}
                  onAction={() => onActionRow(row)}
                  openingState={openingOperations.get(key)}
                />
              );
            })}
        {!listPending && rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {emptyRowsMessage(state, matchCount, hasLabelFilter)}
          </div>
        ) : null}
      </div>
    </>
  );
}

/** Rows-per-page selector and Back/Next controls, below the row list so a
 * narrow inbox column (a review panel open) wraps instead of clipping the
 * pagination controls the way the former header placement did.
 *
 * Below the review panel's `min-[1280px]` breakpoint the review-details
 * `Sheet` covers the right portion of the window as a fixed overlay, so the
 * groups stay left-aligned there instead of spreading to the (occluded)
 * right edge; at that breakpoint and above the panel renders inline in the
 * grid instead, so the groups can spread to the true edges again. */
function InboxFooter({
  pageSize,
  hasPreviousPage,
  hasNextPage,
  refreshStatus,
  onPageSizeChange,
  onPreviousPage,
  onNextPage,
}: {
  readonly pageSize: InboxPageSize;
  readonly hasPreviousPage: boolean;
  readonly hasNextPage: boolean;
  readonly refreshStatus: InboxFreshnessLabel;
  readonly onPageSizeChange: (pageSize: InboxPageSize) => void;
  readonly onPreviousPage: () => void;
  readonly onNextPage: () => void;
}): React.JSX.Element {
  const previousDisabled = !hasPreviousPage || refreshStatus === "Refreshing";
  const nextDisabled = !hasNextPage || refreshStatus === "Refreshing";
  return (
    <footer className="flex flex-wrap items-center justify-start gap-2 px-3 py-2 min-[1280px]:justify-between">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Rows per page</span>
        <Select
          value={String(pageSize)}
          items={INBOX_PAGE_SIZES.map((size) => ({
            label: String(size),
            value: String(size),
          }))}
          onValueChange={(value) => {
            const next = inboxPageSizeFrom(value);
            if (next !== undefined) onPageSizeChange(next);
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-[4.5rem] text-xs"
            aria-label="Rows per page"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {INBOX_PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)} className="text-xs">
                  {size}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {/* Real `<button>` elements (via `Button`), not the vendored
       * `PaginationPrevious`/`PaginationNext` anchors — those render an `<a>`
       * with `aria-disabled`, which is advisory only and stays keyboard-
       * operable and clickable when "disabled". A native `disabled` button
       * is genuinely inert. The `Pagination`/`PaginationContent`/
       * `PaginationItem` wrapper is unchanged. */}
      <Pagination aria-label="Inbox pages" className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <Button
              type="button"
              variant="ghost"
              className="gap-1 border-0 pl-1.5"
              aria-label="Go to previous page"
              disabled={previousDisabled}
              onClick={onPreviousPage}
            >
              <ChevronLeft />
              <span className="hidden sm:block">Previous</span>
            </Button>
          </PaginationItem>
          <PaginationItem>
            <Button
              type="button"
              variant="ghost"
              className="gap-1 border-0 pr-1.5"
              aria-label="Go to next page"
              disabled={nextDisabled}
              onClick={onNextPage}
            >
              <span className="hidden sm:block">Next</span>
              <ChevronRight />
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </footer>
  );
}

function ReviewDetailsPanel({
  inspectorOpen,
  narrow,
  selected,
  freshness,
  onToggleInspector,
  onAction,
  openingOperations,
}: {
  readonly inspectorOpen: boolean;
  readonly narrow: boolean;
  readonly selected: InboxRow | undefined;
  readonly freshness: InboxDataFreshness;
  readonly onToggleInspector: () => void;
  readonly onAction: () => void;
  readonly openingOperations: ReadonlyMap<
    string,
    Exclude<ReviewOpeningState, undefined>
  >;
}): React.JSX.Element {
  const openingState =
    selected === undefined
      ? undefined
      : openingOperations.get(inboxIdentityKey(selected));
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
            {...(openingState === undefined ? {} : { openingState })}
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
          <Inspector
            {...(selected === undefined ? {} : { row: selected })}
            freshness={freshness}
            onAction={onAction}
            {...(openingState === undefined ? {} : { openingState })}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The freshness badge, and the screen's one in-app refresh affordance
 * (ADR 0032). Refresh stays explicit — the badge never refreshes itself, it
 * only lets the maintainer ask — so making the badge the click target puts
 * the command next to the state it acts on rather than adding a second
 * control beside it.
 */
function InboxFreshness({
  snapshot,
  status,
  onRefresh,
}: {
  readonly snapshot?: {
    readonly state: InboxSnapshotState;
    readonly refreshedAt?: string | undefined;
  };
  readonly status: InboxFreshnessLabel;
  readonly onRefresh: () => void;
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
        render={
          <button
            type="button"
            onClick={onRefresh}
            disabled={status === "Refreshing"}
            aria-label={`Refresh pull requests. GitHub: ${status}`}
          />
        }
        variant={variant}
        className={cn(
          "h-5 max-w-full cursor-pointer px-1.5 text-[10px]",
          "disabled:cursor-default disabled:opacity-70",
          degraded &&
            status !== "Stale" &&
            "border-amber-500/40 text-amber-600 dark:text-amber-400",
        )}
        title={snapshot?.refreshedAt}
      >
        GitHub: {status}
      </Badge>
      {!stable && status !== "Refreshing" && ageMs !== undefined ? (
        <span className="text-[10px] text-muted-foreground">
          Updated {formatInboxAge(ageMs)}
        </span>
      ) : null}
    </div>
  );
}

function Inspector({
  row,
  freshness,
  onAction,
  openingState,
}: {
  readonly row?: InboxRow;
  readonly freshness: InboxDataFreshness;
  readonly onAction: () => void | undefined;
  readonly openingState?: Exclude<ReviewOpeningState, undefined>;
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
          openingState?.status === "opening" ||
          (freshness === "cached" &&
            row.recommendedAction.kind === "open_merge_readiness")
        }
      >
        <ReviewOpeningButtonContent state={openingState}>
          {actionIcon(row.recommendedAction.kind)}
          {inboxActionLabel(row.recommendedAction.kind)}
        </ReviewOpeningButtonContent>
      </Button>
      {openingState?.status === "error" ? (
        <p aria-live="polite" className="text-xs text-destructive">
          {openingState.error}
        </p>
      ) : null}
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
function inboxActionLabel(kind: InboxRow["recommendedAction"]["kind"]): string {
  switch (kind) {
    case "run_review":
      return recoveryActionLabel("run_review");
    case "open_merged_review":
      return "View merged pull request";
    case "open_saved_review":
      return "Open Review";
    case "open_merge_readiness":
      return "Open merge readiness";
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
function inboxPageSizeFrom(value: string | null): InboxPageSize | undefined {
  return INBOX_PAGE_SIZES.find((size) => String(size) === value);
}
