import { useMemo } from "react";
import { Settings2 } from "lucide-react";

import { forbiddenCopy, rateLimitedCopy } from "../github-read-failure-copy";
import type { GithubListReadState } from "../github-read-failure-copy";
import {
  useGithubItemPicker,
  type GithubItemPicker,
  type GithubItemPickerActions,
} from "../hooks/use-github-item-picker";
import type { ReviewerListResponse } from "../renderer-contracts";
import { Avatar } from "./ui/avatar";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./ui/field";
import { Input } from "./ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover";
import { Spinner } from "./ui/spinner";

/** One candidate row's shape, taken from the parsed wire response — see
 * `AssignableUser` in `assignee-picker.tsx` for why this reads from the
 * response type rather than a domain type under `exactOptionalPropertyTypes`. */
type CandidateRow = NonNullable<ReviewerListResponse["candidates"]>[number];

/** One of GitHub's own suggested-reviewer rows, taken from the parsed wire response. */
type SuggestedRow = NonNullable<ReviewerListResponse["suggested"]>[number];

export type ReviewerPickerActions = {
  readonly fetchReviewers: (
    query?: string,
  ) => Promise<ReviewerListResponse | undefined>;
  readonly requestReviewers: (
    reviewers: ReadonlyArray<{ readonly id: string; readonly login: string }>,
  ) => Promise<void>;
  readonly removeReviewers: (
    reviewers: ReadonlyArray<{ readonly id: string; readonly login: string }>,
  ) => Promise<void>;
};

/**
 * What this picker's `state: "ready"` read carries, on top of the shared
 * permission. Unlike the other two pickers this is two lists, not one:
 * GitHub's own suggestions and the full candidate set.
 */
type ReviewerReady = {
  readonly suggested: ReadonlyArray<SuggestedRow>;
  readonly candidates: ReadonlyArray<CandidateRow>;
  readonly candidatesTotalCount: number;
};
type ReadState = GithubListReadState<ReviewerReady>;

// Module scope, so the hook's fetch effect keeps one stable identity to
// depend on rather than refetching on every render.
const projectReady = (response: ReviewerListResponse): ReviewerReady => {
  const candidates = response.candidates ?? [];
  return {
    suggested: response.suggested ?? [],
    candidates,
    candidatesTotalCount: response.candidatesTotalCount ?? candidates.length,
  };
};
const keyOf = (candidate: CandidateRow): string => candidate.login;
const describeWriteFailure = (
  candidate: CandidateRow,
  nextAttached: boolean,
): string =>
  nextAttached
    ? `Patchdesk could not ask "${candidate.login}" to review.`
    : `Patchdesk could not remove "${candidate.login}" from the requested reviewers.`;

/** Honest, Patchdesk-authored copy for why GitHub suggested this person —
 * GitHub's own API exposes only `isAuthor`/`isCommenter`, never a
 * human-readable reason string, so this never invents one beyond those two
 * flags. */
function suggestionCopy(suggestion: SuggestedRow): string {
  if (suggestion.isAuthor && suggestion.isCommenter)
    return "Authored this change and commented on it";
  if (suggestion.isAuthor) return "Authored this change";
  if (suggestion.isCommenter) return "Commented on this change";
  return "Suggested by GitHub";
}

/**
 * Requests and un-requests reviewers on the pull request under review.
 * Rendered as the Reviewers section's settings control in
 * `PullRequestMetadataRail`. Its optimistic state, debounced server-side
 * search, stale-response guard and revert-on-failure are
 * `useGithubItemPicker`'s, shared with `AssigneePicker` and `LabelPicker`.
 * Two things stay this picker's own, because they are surface rather than
 * state:
 *
 * - GitHub's own suggested reviewers (`response.suggested`) render grouped
 *   above the remaining candidates, each captioned with Patchdesk's own
 *   honest copy derived from `isAuthor`/`isCommenter` (see
 *   `suggestionCopy`) — GitHub's schema carries no reason string of its own.
 *   A suggested person only renders as a toggleable row once matched by
 *   login against `candidates` (the write needs that entry's node `id`,
 *   which `suggested` rows never carry).
 * - No reviewer-count ceiling is stated anywhere in this component: unlike
 *   the ten-assignee cap `AssigneePicker` states up front, GitHub's
 *   reviewer-request cap could not be verified, so none is invented here.
 *
 * `actions` is `undefined` when the Review can no longer accept reviewer
 * writes; the picker renders nothing in that case, the same way
 * `AssigneePicker` does. Under Terminal, `PullRequestMetadataRail` withholds
 * this component entirely rather than relying on that fallback.
 */
export function ReviewerPicker({
  attachedReviewers,
  actions,
}: {
  readonly attachedReviewers: ReadonlyArray<string>;
  readonly actions?: ReviewerPickerActions;
}): React.JSX.Element | null {
  const pickerActions = useMemo(
    ():
      | GithubItemPickerActions<CandidateRow, ReviewerListResponse>
      | undefined =>
      actions === undefined
        ? undefined
        : {
            fetchList: (query) => actions.fetchReviewers(query),
            add: (candidate) =>
              actions.requestReviewers([
                { id: candidate.id, login: candidate.login },
              ]),
            remove: (candidate) =>
              actions.removeReviewers([
                { id: candidate.id, login: candidate.login },
              ]),
          },
    [actions],
  );
  const picker = useGithubItemPicker({
    attached: attachedReviewers,
    actions: pickerActions,
    keyOf,
    projectReady,
    describeWriteFailure,
  });
  const { readState, permission } = picker;

  if (actions === undefined) return null;

  return (
    <Popover open={picker.open} onOpenChange={picker.setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Manage reviewers"
          />
        }
      >
        <Settings2 />
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverHeader>
          <PopoverTitle>Reviewers</PopoverTitle>
        </PopoverHeader>
        {readState._tag === "ready" && permission === "denied" ? (
          <p
            role="alert"
            data-slot="picker-permission-denied"
            className="text-xs text-destructive"
          >
            This account cannot manage reviewers on this repository.
          </p>
        ) : readState._tag === "ready" && permission === "unknown" ? (
          <p
            data-slot="picker-permission-caveat"
            className="text-xs text-muted-foreground"
          >
            Patchdesk could not confirm you can manage reviewers here — a change
            may be refused.
          </p>
        ) : null}
        {picker.writeError === undefined ? null : (
          <p
            role="alert"
            data-slot="picker-write-error"
            className="text-xs text-destructive"
          >
            {picker.writeError}
          </p>
        )}
        <FieldGroup>
          <Field>
            <Input
              id="reviewer-search"
              type="search"
              aria-label="Search reviewer candidates"
              placeholder="Search people…"
              value={picker.query}
              onChange={(event) => picker.setQuery(event.target.value)}
            />
          </Field>
          <ReviewerPickerList
            readState={readState}
            picker={picker}
            disabled={permission === "denied"}
          />
        </FieldGroup>
      </PopoverContent>
    </Popover>
  );
}

/** One toggleable candidate row, reused for both the suggested group and the remaining-candidates list so the checkbox/avatar/caption markup is written once. */
function ReviewerCandidateRow({
  candidate,
  caption,
  picker,
  disabled,
}: {
  readonly candidate: CandidateRow;
  readonly caption?: string;
  readonly picker: GithubItemPicker<CandidateRow, ReviewerReady>;
  readonly disabled: boolean;
}): React.JSX.Element {
  const attached = picker.isAttached(candidate);
  const busy = picker.isBusy(candidate);
  const controlId = `reviewer-${candidate.id}`;
  const captionId = caption === undefined ? undefined : `${controlId}-caption`;
  return (
    <li>
      <Field
        orientation="horizontal"
        data-disabled={disabled || busy || undefined}
      >
        <Checkbox
          id={controlId}
          checked={attached}
          disabled={disabled || busy}
          {...(captionId === undefined
            ? {}
            : { "aria-describedby": captionId })}
          onCheckedChange={() => picker.toggle(candidate, !attached)}
        />
        <FieldLabel htmlFor={controlId} className="font-normal">
          <Avatar
            name={candidate.login}
            dataUri={candidate.avatarDataUri}
            className="size-5 text-[10px]"
          />
          <span className="min-w-0 truncate">{candidate.login}</span>
        </FieldLabel>
      </Field>
      {caption === undefined ? null : (
        <span
          id={captionId}
          data-slot="reviewer-suggestion-caption"
          className="truncate pl-9 text-[10px] text-muted-foreground"
        >
          {caption}
        </span>
      )}
    </li>
  );
}

/** The picker's body: the read state's message, or its suggested-then-candidates lists. */
function ReviewerPickerList({
  readState,
  picker,
  disabled,
}: {
  readonly readState: ReadState;
  readonly picker: GithubItemPicker<CandidateRow, ReviewerReady>;
  readonly disabled: boolean;
}): React.JSX.Element {
  if (readState._tag === "loading")
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Loading reviewer candidates…
      </p>
    );
  if (readState._tag === "github_auth")
    return (
      <p role="alert" className="text-xs text-destructive">
        GitHub authentication is required before Patchdesk can list this
        repository&apos;s reviewer candidates.
      </p>
    );
  if (readState._tag === "github_read")
    return (
      <p role="alert" className="text-xs text-destructive">
        Patchdesk could not load this repository&apos;s reviewer candidates.
        Reopen this menu to retry.
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

  const candidatesByLogin = new Map(
    readState.candidates.map(
      (candidate) => [candidate.login, candidate] as const,
    ),
  );
  const suggestedRows: ReadonlyArray<{
    readonly suggestion: SuggestedRow;
    readonly candidate: CandidateRow;
  }> = readState.suggested.flatMap((suggestion) => {
    const candidate = candidatesByLogin.get(suggestion.reviewer.login);
    return candidate === undefined ? [] : [{ suggestion, candidate }];
  });
  const suggestedLogins = new Set(
    suggestedRows.map((row) => row.candidate.login),
  );
  const remainingCandidates = readState.candidates.filter(
    (candidate) => !suggestedLogins.has(candidate.login),
  );

  if (suggestedRows.length === 0 && remainingCandidates.length === 0)
    return <p className="text-xs text-muted-foreground">No matching people.</p>;

  return (
    <FieldSet data-disabled={disabled || undefined}>
      <FieldLegend variant="label">Reviewer candidates</FieldLegend>
      <div className="max-h-64 overflow-y-auto">
        {suggestedRows.length === 0 ? null : (
          <div role="group" aria-label="Suggested reviewers" className="mb-1.5">
            <p className="px-1 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              Suggested
            </p>
            <FieldGroup className="gap-0.5">
              <ul>
                {suggestedRows.map(({ suggestion, candidate }) => (
                  <ReviewerCandidateRow
                    key={candidate.id}
                    candidate={candidate}
                    caption={suggestionCopy(suggestion)}
                    picker={picker}
                    disabled={disabled}
                  />
                ))}
              </ul>
            </FieldGroup>
          </div>
        )}
        {remainingCandidates.length === 0 ? null : (
          <FieldGroup className="gap-0.5">
            <ul aria-label="Reviewer candidates">
              {remainingCandidates.map((candidate) => (
                <ReviewerCandidateRow
                  key={candidate.id}
                  candidate={candidate}
                  picker={picker}
                  disabled={disabled}
                />
              ))}
            </ul>
          </FieldGroup>
        )}
        {readState.candidatesTotalCount > readState.candidates.length ? (
          <p
            data-slot="picker-truncation"
            className="mt-1 text-xs text-muted-foreground"
          >
            Showing {readState.candidates.length} of{" "}
            {readState.candidatesTotalCount} candidates. Some repository
            collaborators aren&apos;t shown.
          </p>
        ) : null}
      </div>
    </FieldSet>
  );
}
