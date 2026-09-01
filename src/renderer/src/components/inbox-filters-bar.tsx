import { ChevronLeft, ChevronRight, UserRoundCheck } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  INBOX_STATE_FILTERS,
  type InboxCheckStatusFilter,
  type InboxReviewStateFilter,
  type InboxStateFilter,
} from "../../../domain/maintainer-inbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";

export function InboxFiltersBar({
  state,
  onStateChange,
  labelFilter,
  awaitingMyReview,
  onAwaitingMyReviewChange,
  reviewState,
  onReviewStateChange,
  checkStatus,
  onCheckStatusChange,
  onClearAllFilters,
  rowCount,
  matchCount,
  listPending,
  inspectorOpen,
  onToggleInspector,
}: {
  readonly state: InboxStateFilter;
  readonly onStateChange: (state: InboxStateFilter) => void;
  readonly labelFilter?: ReactNode;
  readonly awaitingMyReview: boolean;
  readonly onAwaitingMyReviewChange: (value: boolean) => void;
  readonly reviewState?: InboxReviewStateFilter;
  readonly onReviewStateChange: (
    value: InboxReviewStateFilter | undefined,
  ) => void;
  readonly checkStatus?: InboxCheckStatusFilter;
  readonly onCheckStatusChange: (
    value: InboxCheckStatusFilter | undefined,
  ) => void;
  readonly onClearAllFilters: () => void;
  readonly rowCount: number;
  readonly matchCount?: number;
  readonly listPending: boolean;
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
}): React.JSX.Element {
  return (
    <section
      className="sticky top-0 z-10 flex min-h-10 flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-1.5 backdrop-blur"
      aria-label="Pull requests filters"
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
      {labelFilter}
      <MoreFiltersPopover
        {...(reviewState === undefined ? {} : { reviewState })}
        onReviewStateChange={onReviewStateChange}
        {...(checkStatus === undefined ? {} : { checkStatus })}
        onCheckStatusChange={onCheckStatusChange}
        onClearAllFilters={onClearAllFilters}
      />
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

const REVIEW_STATE_FILTERS: ReadonlyArray<{
  readonly value: InboxReviewStateFilter;
  readonly label: string;
}> = [
  { value: "none", label: "Not reviewed" },
  { value: "required", label: "Review required" },
  { value: "approved", label: "Approved" },
  { value: "changes_requested", label: "Changes requested" },
];

const CHECK_STATUS_FILTERS: ReadonlyArray<{
  readonly value: InboxCheckStatusFilter;
  readonly label: string;
}> = [
  { value: "pending", label: "Pending" },
  { value: "success", label: "Passing" },
  { value: "failure", label: "Failing" },
];

function MoreFiltersPopover({
  reviewState,
  onReviewStateChange,
  checkStatus,
  onCheckStatusChange,
  onClearAllFilters,
}: {
  readonly reviewState?: InboxReviewStateFilter;
  readonly onReviewStateChange: (
    value: InboxReviewStateFilter | undefined,
  ) => void;
  readonly checkStatus?: InboxCheckStatusFilter;
  readonly onCheckStatusChange: (
    value: InboxCheckStatusFilter | undefined,
  ) => void;
  readonly onClearAllFilters: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const activeCount =
    Number(reviewState !== undefined) + Number(checkStatus !== undefined);
  const reviewLabel = REVIEW_STATE_FILTERS.find(
    (option) => option.value === reviewState,
  )?.label;
  const checkLabel = CHECK_STATUS_FILTERS.find(
    (option) => option.value === checkStatus,
  )?.label;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={
              activeCount === 0
                ? "More filters"
                : `More filters (${activeCount} active)`
            }
          >
            More filters
            {activeCount === 0 ? null : (
              <Badge
                variant="secondary"
                aria-label={`${activeCount} active filters`}
              >
                {activeCount}
              </Badge>
            )}
          </Button>
        }
      />
      <PopoverContent className="w-72">
        <PopoverHeader>
          <PopoverTitle>More filters</PopoverTitle>
        </PopoverHeader>
        <div className="grid gap-3">
          <Select
            value={reviewState ?? "any"}
            items={[{ value: "any", label: "Any" }, ...REVIEW_STATE_FILTERS]}
            onValueChange={(value) => {
              if (value === "any") {
                onReviewStateChange(undefined);
                return;
              }
              const next = REVIEW_STATE_FILTERS.find(
                (option) => option.value === value,
              );
              if (next !== undefined) onReviewStateChange(next.value);
            }}
          >
            <SelectTrigger aria-label="Review state" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="any">Any</SelectItem>
                {REVIEW_STATE_FILTERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={checkStatus ?? "any"}
            items={[{ value: "any", label: "Any" }, ...CHECK_STATUS_FILTERS]}
            onValueChange={(value) => {
              if (value === "any") {
                onCheckStatusChange(undefined);
                return;
              }
              const next = CHECK_STATUS_FILTERS.find(
                (option) => option.value === value,
              );
              if (next !== undefined) onCheckStatusChange(next.value);
            }}
          >
            <SelectTrigger aria-label="Check status" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="any">Any</SelectItem>
                {CHECK_STATUS_FILTERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {activeCount === 0 ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClearAllFilters}
            >
              Clear all filters
            </Button>
          )}
        </div>
      </PopoverContent>
      {activeCount === 0 ? null : (
        <div className="flex flex-wrap gap-1" aria-label="Active filters">
          {reviewLabel === undefined ? null : (
            <Badge
              variant="outline"
              render={
                <button
                  type="button"
                  aria-label="Clear review filter"
                  onClick={() => onReviewStateChange(undefined)}
                />
              }
            >
              Review: {reviewLabel}
            </Badge>
          )}
          {checkLabel === undefined ? null : (
            <Badge
              variant="outline"
              render={
                <button
                  type="button"
                  aria-label="Clear check filter"
                  onClick={() => onCheckStatusChange(undefined)}
                />
              }
            >
              Checks: {checkLabel}
            </Badge>
          )}
        </div>
      )}
    </Popover>
  );
}

function stateFilterShortLabel(state: InboxStateFilter): string {
  return state === "open" ? "Open" : "Merged";
}
