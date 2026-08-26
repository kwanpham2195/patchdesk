import { type KeyboardEvent } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  CircleSlash,
  Clock3,
  GitPullRequest,
} from "lucide-react";

import {
  inboxIdentityKey,
  type InboxRow,
  type LocalReviewEntry,
} from "@/renderer-contracts";
import { recoveryActionLabel } from "@/review-copy";
import { LabelChip } from "./label-chip";
import {
  useInboxView,
  type ReviewInitialSection,
} from "../hooks/use-inbox-view";
import {
  formatInboxAge,
  type inboxFreshnessLabel,
} from "@/inbox-refresh-scheduler";
import { isInboxCacheDegraded } from "../../../domain/inbox-freshness-policy";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  INBOX_PAGE_SIZES,
  INBOX_STATE_FILTERS,
  type InboxPageSize,
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type { ReviewInitialSection } from "../hooks/use-inbox-view";

/** Stable option value for the repository picker's `Select`. */
function repositoryKey(repo: {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}

type MaintainerInboxProps = {
  readonly profileId: string;
  readonly profileLabel: string;
  /** Requested state; App owns remote state transitions. The filter bar's
   * state `Select` reflects this immediately, even before `listPending`
   * clears. */
  readonly scope?: "open" | "merged";
  /** True while `rows` still belongs to the previous request (a filter
   * change is in flight). The row list, row count, and details panel hold a
   * loading state instead of rendering that data under the newly requested
   * filter's label. */
  readonly listPending?: boolean;
  /** Confirmed remote page size; App owns remote page-size transitions. */
  readonly pageSize?: InboxPageSize;
  readonly hasPreviousPage?: boolean;
  readonly hasNextPage?: boolean;
  readonly onScopeChange?: (scope: "open" | "merged") => void;
  /** The label filter, sent to GitHub as `label:"NAME"` qualifiers — never a
   * local, in-page filter (ADR 0031/0032). App owns the request transition. */
  readonly selectedLabels?: ReadonlyArray<string>;
  readonly onLabelsChange?: (labels: ReadonlyArray<string>) => void;
  readonly onPageSizeChange?: (pageSize: InboxPageSize) => void;
  readonly onPreviousPage?: () => void;
  readonly onNextPage?: () => void;
  readonly rows: ReadonlyArray<InboxRow>;
  /** The Local review listing (ADR 0031): the maintainer's own Review
   * sessions for the Selected repository, read whole and never paginated —
   * not a slice of `rows`. A session whose pull request is not in `rows`
   * (GitHub cannot return it, or it is simply off the current filter) still
   * appears here, rather than vanishing. */
  readonly localReviews?: ReadonlyArray<LocalReviewEntry>;
  /** GitHub's true repository-wide match count for the current filter.
   * Absent on a cached or failed read that cannot know it — render that
   * absence honestly, never as 0. Never the loaded page's row count. */
  readonly matchCount?: number;
  /** The profile's full watchlist — the picker's only source of options
   * (never `/v1/watchlist/suggestions`, which answers a different question).
   * The picker does not render when this is empty; the setup checklist owns
   * the screen instead. */
  readonly repos?: ReadonlyArray<{ host: string; owner: string; repo: string }>;
  /** The screen's root state (slice 7c); App owns its request transition. */
  readonly selectedRepository?: { host: string; owner: string; repo: string };
  readonly onRepositoryChange?: (repository: {
    host: string;
    owner: string;
    repo: string;
  }) => void;
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
  readonly refreshStatus: ReturnType<typeof inboxFreshnessLabel>;
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
  listPending = false,
  pageSize = DEFAULT_INBOX_PAGE_SIZE,
  hasPreviousPage = false,
  hasNextPage = false,
  onScopeChange = () => undefined,
  selectedLabels = [],
  onLabelsChange = () => undefined,
  onPageSizeChange = () => undefined,
  onPreviousPage = () => undefined,
  onNextPage = () => undefined,
  rows,
  localReviews = [],
  matchCount,
  repos,
  selectedRepository,
  onRepositoryChange = () => undefined,
  freshness,
  snapshot,
  refreshStatus,
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
    labelItems,
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
        {...(snapshot === undefined ? {} : { snapshot })}
      />
      <LocalReviewsPanel
        localReviews={localReviews}
        onOpenReviewId={onOpenReviewId}
      />
      {refreshStatus === "Stale" && snapshot?.refreshedAt !== undefined ? (
        <StaleInboxBanner refreshedAt={snapshot.refreshedAt} />
      ) : null}
      <InboxFiltersBar
        scope={scope}
        onScopeChange={onScopeChange}
        labelItems={labelItems}
        selectedLabels={selectedLabels}
        onLabelChange={onLabelsChange}
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
        scope={scope}
        listPending={listPending}
        {...(matchCount === undefined ? {} : { matchCount })}
        hasLabelFilter={selectedLabels.length > 0}
        onKeyDown={onListKeyDown}
        onSelectRow={selectRow}
        onActionRow={triggerAction}
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

/** Label for a Local review entry whose session predates `prContext`, or
 * never captured a title — falls back to the identity a maintainer already
 * recognizes from GitHub. */
function localReviewLabel(entry: LocalReviewEntry): string {
  if (entry.title !== undefined) return entry.title;
  return `${entry.identity.owner}/${entry.identity.repo}`;
}

/**
 * The Local review listing (ADR 0031): every Review session for the
 * Selected repository, read whole and never paginated — distinct from, and
 * always beside, the Repository listing below it. A session here can
 * outlive its pull request on GitHub (deleted, transferred, made private,
 * or simply off the current filter), so it never depends on `rows`.
 */
function LocalReviewsPanel({
  localReviews,
  onOpenReviewId,
}: {
  readonly localReviews: ReadonlyArray<LocalReviewEntry>;
  readonly onOpenReviewId: (reviewId: string) => void;
}): React.JSX.Element {
  return (
    <section
      aria-label="Local reviews"
      className="border-b px-3 py-2.5"
      data-slot="local-reviews-panel"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Local reviews
        </h2>
        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
          {localReviews.length}
        </Badge>
      </div>
      <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
        Reviews you have open for this repository, kept even when GitHub cannot
        show their pull request.
      </p>
      <Separator className="mt-2" />
      {localReviews.length === 0 ? (
        <Empty className="min-h-0 gap-1.5 border-none p-2 py-3">
          <EmptyHeader className="max-w-none gap-1">
            <EmptyTitle className="text-xs">No local reviews yet</EmptyTitle>
            <EmptyDescription className="text-[11px] leading-4">
              Start a review from the pull requests below and it appears here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="mt-2 max-h-48 w-full">
          <ul className="flex flex-col gap-1.5 pr-2">
            {localReviews.map((entry) => (
              <li key={entry.reviewId}>
                <LocalReviewCard
                  entry={entry}
                  onOpen={() => onOpenReviewId(entry.reviewId)}
                />
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </section>
  );
}

function LocalReviewCard({
  entry,
  onOpen,
}: {
  readonly entry: LocalReviewEntry;
  readonly onOpen: () => void;
}): React.JSX.Element {
  const label = localReviewLabel(entry);
  return (
    <Card className="flex-row items-center gap-2 px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-xs leading-4 font-medium"
          title={`#${entry.identity.number} ${label}`}
        >
          #{entry.identity.number} {label}
        </p>
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
          Updated {relativeTime(entry.updatedAt)} ·{" "}
          {shortSha(entry.pinnedHeadSha)}
        </p>
      </div>
      <Button
        size="xs"
        variant="outline"
        className="h-6 shrink-0 text-[11px]"
        onClick={onOpen}
      >
        Open
      </Button>
    </Card>
  );
}

function InboxHeader({
  profileLabel,
  repos,
  selectedRepository,
  onRepositoryChange,
  refreshStatus,
  snapshot,
}: {
  readonly profileLabel: string;
  /** The profile's full watchlist; the picker hides itself when empty (the
   * setup checklist owns the screen instead), and stays visible for exactly
   * one watched repository — hiding it there would make the scoping
   * invisible. */
  readonly repos?: ReadonlyArray<{ host: string; owner: string; repo: string }>;
  readonly selectedRepository?: { host: string; owner: string; repo: string };
  readonly onRepositoryChange: (repository: {
    host: string;
    owner: string;
    repo: string;
  }) => void;
  readonly refreshStatus: ReturnType<typeof inboxFreshnessLabel>;
  readonly snapshot?: {
    readonly state:
      | "current"
      | "partial"
      | "failed_cached"
      | "stale_cached"
      | "unavailable";
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
          {...(snapshot === undefined ? {} : { snapshot })}
        />
      </div>
    </header>
  );
}

function InboxFiltersBar({
  scope,
  onScopeChange,
  labelItems,
  selectedLabels,
  onLabelChange,
  rowCount,
  matchCount,
  listPending,
  inspectorOpen,
  onToggleInspector,
}: {
  readonly scope: "open" | "merged";
  readonly onScopeChange: (scope: "open" | "merged") => void;
  readonly labelItems: ReadonlyArray<{ label: string; value: string }>;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly onLabelChange: (value: ReadonlyArray<string>) => void;
  readonly rowCount: number;
  readonly matchCount?: number;
  readonly listPending: boolean;
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
}): React.JSX.Element {
  const selectedLabelSet = new Set(selectedLabels);
  return (
    <section
      className="sticky top-0 z-10 flex min-h-10 flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-1.5 backdrop-blur"
      aria-label="Inbox filters"
    >
      <Select
        value={scope}
        items={INBOX_STATE_FILTERS.map((option) => ({
          label: stateFilterShortLabel(option.state),
          value: option.state,
        }))}
        onValueChange={(value) => {
          const next = INBOX_STATE_FILTERS.find(
            (option) => option.state === value,
          );
          if (next !== undefined) onScopeChange(next.state);
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
      <span
        className="ml-auto text-[11px] tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {listPending
          ? "Loading…"
          : matchCount === undefined
            ? `${rowCount} on this page`
            : `${matchCount} ${scope === "open" ? "open" : "merged"}`}
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
function stateFilterShortLabel(state: "open" | "merged"): string {
  return state === "open" ? "Open" : "Merged";
}

/** Trigger copy for the label filter: names the single selection, or a count once more than one is picked. */
function labelFilterTriggerText(selected: ReadonlyArray<string>): string {
  if (selected.length === 0) return "All labels";
  if (selected.length === 1) return selected[0] ?? "All labels";
  return `${selected.length} labels`;
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
 * at all — see ADR 0031 and .agents/PLANS/2026-08-25-scope-pull-requests-
 * to-one-repository.md, slice 8a. */
function emptyRowsMessage(
  scope: "open" | "merged",
  matchCount: number | undefined,
  hasLabelFilter: boolean,
): string {
  if (matchCount === undefined)
    return `No ${scope === "open" ? "open" : "merged"} pull requests on this page.`;
  if (matchCount > 0)
    return `No ${scope === "open" ? "open" : "merged"} pull requests on this page — GitHub reports ${matchCount} in total.`;
  if (hasLabelFilter) return "No pull requests match the selected labels.";
  return `This repository has no ${scope === "open" ? "open" : "merged"} pull requests right now.`;
}

function InboxRowsPanel({
  listRef,
  rows,
  selected,
  scope,
  listPending,
  matchCount,
  hasLabelFilter,
  onKeyDown,
  onSelectRow,
  onActionRow,
}: {
  readonly listRef: React.RefObject<HTMLDivElement | null>;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly selected: InboxRow | undefined;
  readonly scope: "open" | "merged";
  readonly listPending: boolean;
  readonly matchCount?: number;
  readonly hasLabelFilter: boolean;
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
      {/* Announces the busy-to-loaded transition; the listbox below stays
       * `aria-hidden` skeleton rows without this, nothing tells assistive
       * technology loading finished. */}
      <div role="status" aria-live="polite" className="sr-only">
        {listPending
          ? "Loading pull requests…"
          : `${rows.length} pull request${rows.length === 1 ? "" : "s"} loaded.`}
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
                />
              );
            })}
        {!listPending && rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {emptyRowsMessage(scope, matchCount, hasLabelFilter)}
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
  readonly refreshStatus: ReturnType<typeof inboxFreshnessLabel>;
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
  readonly status: ReturnType<typeof inboxFreshnessLabel>;
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
      {!stable && status !== "Refreshing" && ageMs !== undefined ? (
        <span className="text-[10px] text-muted-foreground">
          Updated {formatInboxAge(ageMs)}
        </span>
      ) : null}
    </div>
  );
}

function InboxRowItem({
  row,
  selected,
  onSelect,
  onAction,
}: {
  readonly row: InboxRow;
  readonly selected: boolean;
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
      // Roving tabindex: only the selected option sits in the Tab order,
      // the way a native `<select>`'s options do. Arrow keys move both the
      // selection and real DOM focus (see `onListKeyDown` in
      // `use-inbox-view.ts`); Tab never has to step through every row.
      tabIndex={selected ? 0 : -1}
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
              {row.remoteState === "merged" ? (
                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                  Merged
                </Badge>
              ) : null}
            </div>
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
function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1_440)}d`;
}
function inboxPageSizeFrom(value: string | null): InboxPageSize | undefined {
  return INBOX_PAGE_SIZES.find((size) => String(size) === value);
}
