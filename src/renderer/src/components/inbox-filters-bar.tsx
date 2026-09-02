import {
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Clock3,
  GitBranch,
  ListFilter,
  User,
  UserRoundCheck,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import {
  INBOX_STATE_FILTERS,
  MAX_INBOX_FILTER_AUTHOR_LENGTH,
  MAX_INBOX_FILTER_BASE_BRANCH_LENGTH,
  type InboxCheckStatusFilter,
  type InboxFilterTextFailure,
  type InboxReviewStateFilter,
  type InboxStateFilter,
} from "../../../domain/maintainer-inbox";
import type { InboxRow } from "@/renderer-contracts";
import { CheckStatusIcon } from "./inbox-row-item";
import { ReviewVerdictIcon } from "./review-verdict-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
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

/** Pull-request state, ownership, label, review, and check filter controls. */
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
  author,
  onAuthorChange,
  baseBranch,
  onBaseBranchChange,
  onClearInboxMoreFilters,
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
  readonly author?: string;
  readonly onAuthorChange: (
    value: string | undefined,
  ) => InboxFilterTextFailure | undefined;
  readonly baseBranch?: string;
  readonly onBaseBranchChange: (
    value: string | undefined,
  ) => InboxFilterTextFailure | undefined;
  readonly onClearInboxMoreFilters: () => void;
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
        {...(author === undefined ? {} : { author })}
        onAuthorChange={onAuthorChange}
        {...(baseBranch === undefined ? {} : { baseBranch })}
        onBaseBranchChange={onBaseBranchChange}
        onClearInboxMoreFilters={onClearInboxMoreFilters}
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

/** The option a review-state `Select` value names; `undefined` is "Any". */
function reviewStateOf(value: string): InboxReviewStateFilter | undefined {
  return REVIEW_STATE_FILTERS.find((option) => option.value === value)?.value;
}

function reviewStateFilterLabel(
  value: InboxReviewStateFilter | undefined,
): string {
  return (
    REVIEW_STATE_FILTERS.find((option) => option.value === value)?.label ??
    "Any"
  );
}

/** The review-state filter's glyph, taken from the shared `ReviewVerdictIcon` where GitHub has a verdict so one glyph means one verdict, and drawn as an amber `Clock3` or a muted `CircleDashed` where it has none. */
function ReviewStateFilterIcon({
  value,
}: {
  readonly value: InboxReviewStateFilter | undefined;
}): React.JSX.Element {
  switch (value) {
    case "approved":
      return (
        <ReviewVerdictIcon
          verdict="approved"
          className="size-3.5 text-emerald-700 dark:text-emerald-400"
        />
      );
    case "changes_requested":
      return (
        <ReviewVerdictIcon
          verdict="changes_requested"
          className="size-3.5 text-rose-700 dark:text-rose-400"
        />
      );
    case "required":
      return (
        <Clock3
          className="size-3.5 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
      );
    case "none":
    case undefined:
      return (
        <CircleDashed
          className="size-3.5 text-muted-foreground"
          aria-hidden="true"
        />
      );
  }
}

const CHECK_STATUS_FILTERS: ReadonlyArray<{
  readonly value: InboxCheckStatusFilter;
  readonly label: string;
  /** The row's check status this filter selects, so the menu reuses the
   * row's glyph for it instead of keeping a second set of pairs. */
  readonly overall: InboxRow["checks"]["overall"];
}> = [
  { value: "pending", label: "Pending", overall: "pending" },
  { value: "success", label: "Passing", overall: "passing" },
  { value: "failure", label: "Failing", overall: "failing" },
];

/** The option a check-status `Select` value names; `undefined` is "Any". */
function checkStatusOf(value: string): InboxCheckStatusFilter | undefined {
  return CHECK_STATUS_FILTERS.find((option) => option.value === value)?.value;
}

function checkStatusFilterLabel(
  value: InboxCheckStatusFilter | undefined,
): string {
  return (
    CHECK_STATUS_FILTERS.find((option) => option.value === value)?.label ??
    "Any"
  );
}

/** The check-status filter's glyph, straight from the row's `CheckStatusIcon`.
 * `undefined` is the "Any" option, which draws the row's unknown mark. */
function CheckStatusFilterIcon({
  value,
}: {
  readonly value: InboxCheckStatusFilter | undefined;
}): React.JSX.Element {
  const overall =
    CHECK_STATUS_FILTERS.find((option) => option.value === value)?.overall ??
    "unknown";
  return <CheckStatusIcon overall={overall} />;
}

function MoreFiltersPopover({
  reviewState,
  onReviewStateChange,
  checkStatus,
  onCheckStatusChange,
  author,
  onAuthorChange,
  baseBranch,
  onBaseBranchChange,
  onClearInboxMoreFilters,
}: {
  readonly reviewState?: InboxReviewStateFilter;
  readonly onReviewStateChange: (
    value: InboxReviewStateFilter | undefined,
  ) => void;
  readonly checkStatus?: InboxCheckStatusFilter;
  readonly onCheckStatusChange: (
    value: InboxCheckStatusFilter | undefined,
  ) => void;
  readonly author?: string;
  readonly onAuthorChange: (
    value: string | undefined,
  ) => InboxFilterTextFailure | undefined;
  readonly baseBranch?: string;
  readonly onBaseBranchChange: (
    value: string | undefined,
  ) => InboxFilterTextFailure | undefined;
  readonly onClearInboxMoreFilters: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const reviewStateId = useId();
  const checkStatusId = useId();
  const activeCount =
    Number(reviewState !== undefined) +
    Number(checkStatus !== undefined) +
    Number(author !== undefined) +
    Number(baseBranch !== undefined);
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
            <ListFilter aria-hidden="true" />
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
      <PopoverContent className="w-80">
        <PopoverHeader>
          <PopoverTitle>More filters</PopoverTitle>
        </PopoverHeader>
        <div className="grid gap-3">
          <Field>
            <FieldLabel htmlFor={reviewStateId}>Review state</FieldLabel>
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
              <SelectTrigger id={reviewStateId} size="sm">
                <SelectValue>
                  {(value: string) => (
                    <>
                      <ReviewStateFilterIcon value={reviewStateOf(value)} />
                      {reviewStateFilterLabel(reviewStateOf(value))}
                    </>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="any">
                    <ReviewStateFilterIcon value={undefined} />
                    Any
                  </SelectItem>
                  {REVIEW_STATE_FILTERS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <ReviewStateFilterIcon value={option.value} />
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={checkStatusId}>Check status</FieldLabel>
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
              <SelectTrigger id={checkStatusId} size="sm">
                <SelectValue>
                  {(value: string) => (
                    <>
                      <CheckStatusFilterIcon value={checkStatusOf(value)} />
                      {checkStatusFilterLabel(checkStatusOf(value))}
                    </>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="any">
                    <CheckStatusFilterIcon value={undefined} />
                    Any
                  </SelectItem>
                  {CHECK_STATUS_FILTERS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <CheckStatusFilterIcon value={option.value} />
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <MoreFiltersTextField
            label="Author"
            placeholder="login or @me"
            icon={<User aria-hidden="true" />}
            maxLength={MAX_INBOX_FILTER_AUTHOR_LENGTH}
            {...(author === undefined ? {} : { value: author })}
            onCommit={onAuthorChange}
          />
          <MoreFiltersTextField
            label="Base branch"
            placeholder="main"
            icon={<GitBranch aria-hidden="true" />}
            maxLength={MAX_INBOX_FILTER_BASE_BRANCH_LENGTH}
            {...(baseBranch === undefined ? {} : { value: baseBranch })}
            onCommit={onBaseBranchChange}
          />
          {activeCount === 0 ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClearInboxMoreFilters}
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
              <ReviewStateFilterIcon value={reviewState} />
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
              <CheckStatusFilterIcon value={checkStatus} />
              Checks: {checkLabel}
            </Badge>
          )}
          {author === undefined ? null : (
            <Badge
              variant="outline"
              render={
                <button
                  type="button"
                  aria-label="Clear author filter"
                  onClick={() => onAuthorChange(undefined)}
                />
              }
            >
              <User aria-hidden="true" />
              Author: {author}
            </Badge>
          )}
          {baseBranch === undefined ? null : (
            <Badge
              variant="outline"
              render={
                <button
                  type="button"
                  aria-label="Clear base branch filter"
                  onClick={() => onBaseBranchChange(undefined)}
                />
              }
            >
              <GitBranch aria-hidden="true" />
              Base: {baseBranch}
            </Badge>
          )}
        </div>
      )}
    </Popover>
  );
}

/** A More-filters text field that commits its draft on Enter or blur rather than on every keystroke, because each committed value becomes a GitHub read (ADR 0032). */
function MoreFiltersTextField({
  label,
  placeholder,
  icon,
  maxLength,
  value,
  onCommit,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly icon: ReactNode;
  readonly maxLength: number;
  readonly value?: string;
  readonly onCommit: (
    value: string | undefined,
  ) => InboxFilterTextFailure | undefined;
}): React.JSX.Element {
  const fieldId = useId();
  const errorId = useId();
  const committed = value ?? "";
  const [draft, setDraft] = useState(committed);
  const [seed, setSeed] = useState(committed);
  const [failure, setFailure] = useState<InboxFilterTextFailure>();
  // Re-seed the draft when the committed value changes underneath it — the
  // chips and "Clear all filters" both clear the field from outside.
  if (seed !== committed) {
    setSeed(committed);
    setDraft(committed);
    setFailure(undefined);
  }

  // A refused value keeps the draft on screen so it can be corrected in place;
  // only a commit the owner accepted clears the message.
  const commit = (): void => {
    const next = draft.trim();
    if (next === committed) {
      setFailure(undefined);
      return;
    }
    setFailure(onCommit(next === "" ? undefined : next));
  };

  const message =
    failure === undefined
      ? undefined
      : failure === "too_long"
        ? `At most ${maxLength} characters`
        : "No spaces or quotes";

  return (
    <Field data-invalid={message === undefined ? undefined : true}>
      <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupAddon className="text-muted-foreground">
          {icon}
        </InputGroupAddon>
        <InputGroupInput
          id={fieldId}
          value={draft}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-invalid={message === undefined ? undefined : true}
          {...(message === undefined ? {} : { "aria-describedby": errorId })}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              return;
            }
            if (event.key === "Escape") {
              // Stop the key here so the popover's dismissal never sees it:
              // undoing a mistyped author must not also close the panel and
              // hide the other three filters.
              event.preventDefault();
              event.stopPropagation();
              setDraft(committed);
              setFailure(undefined);
            }
          }}
        />
      </InputGroup>
      {message === undefined ? null : (
        <FieldError id={errorId}>{message}</FieldError>
      )}
    </Field>
  );
}

function stateFilterShortLabel(state: InboxStateFilter): string {
  return state === "open" ? "Open" : "Merged";
}
