import { useEffect, useMemo, useRef, useState } from "react";
import { Settings2 } from "lucide-react";

import type { PullRequestAssigneePermission } from "../../../domain/github-context";
import { PatchdeskApiError } from "../api-client";
import { forbiddenCopy, rateLimitedCopy } from "../github-read-failure-copy";
import { withoutMember } from "../picker-selection";
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
import type { ForbiddenReason } from "../../../domain/github-forbidden-reason";

/** Mirrors `assignee-picker.tsx`'s `SEARCH_DEBOUNCE_MS`; kept as its own constant here rather than a shared import since each search-enabled picker owns its own debounce timing. */
const SEARCH_DEBOUNCE_MS = 200;

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

type ReadState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "github_read" }
  | { readonly _tag: "github_auth" }
  | {
      readonly _tag: "ready";
      readonly suggested: ReadonlyArray<SuggestedRow>;
      readonly candidates: ReadonlyArray<CandidateRow>;
      readonly candidatesTotalCount: number;
      /**
       * The service's real, GitHub-evidenced answer for whether this
       * account can write reviewers here (`ReviewerListOutcome.ready
       * .permission` in `src/services/reviewer-service.ts`). Never inferred
       * client-side — `"unknown"` means evidence was genuinely unavailable,
       * not that a write hasn't been tried yet.
       */
      readonly permission: PullRequestAssigneePermission;
    }
  | { readonly _tag: "github_rate_limited"; readonly resumeAt?: string }
  | {
      readonly _tag: "github_forbidden";
      readonly reason?: ForbiddenReason;
    };

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
 * `PullRequestMetadataRail`, mirroring `AssigneePicker`'s structure
 * (gear-icon trigger, three-state permission notice, debounced server-side
 * search with a monotonic request-id guard, optimistic toggle with
 * revert-on-failure). Two differences from `AssigneePicker`:
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [readState, setReadState] = useState<ReadState>({ _tag: "loading" });
  const permission: PullRequestAssigneePermission =
    readState._tag === "ready" ? readState.permission : "unknown";
  const [pendingRequests, setPendingRequests] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingRemovals, setPendingRemovals] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [busyLogins, setBusyLogins] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [writeError, setWriteError] = useState<string>();
  // Tracks the last `attachedReviewers` prop identity rendered, so a change
  // to it can be adjusted for during rendering (mirrors `AssigneePicker`'s
  // use of https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [prevAttachedReviewers, setPrevAttachedReviewers] =
    useState(attachedReviewers);

  const attachedLogins = useMemo(
    () => new Set(attachedReviewers),
    [attachedReviewers],
  );
  if (prevAttachedReviewers !== attachedReviewers) {
    setPrevAttachedReviewers(attachedReviewers);
    setPendingRequests((current) => {
      const next = new Set(
        [...current].filter((login) => !attachedLogins.has(login)),
      );
      return next.size === current.size ? current : next;
    });
    setPendingRemovals((current) => {
      const next = new Set(
        [...current].filter((login) => attachedLogins.has(login)),
      );
      return next.size === current.size ? current : next;
    });
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Monotonic request id: a fetch started later always carries a higher id,
  // so an in-flight response from an earlier keystroke is dropped rather
  // than overwriting a newer one that already landed.
  const requestIdRef = useRef(0);
  useEffect(() => {
    if (!open || actions === undefined) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setReadState({ _tag: "loading" });
    actions
      .fetchReviewers(debouncedQuery === "" ? undefined : debouncedQuery)
      .then((response) => {
        if (requestIdRef.current !== requestId) return;
        setReadState(projectReadState(response));
      })
      .catch(() => {
        if (requestIdRef.current === requestId)
          setReadState({ _tag: "github_read" });
      });
  }, [open, actions, debouncedQuery]);

  if (actions === undefined) return null;

  const toggle = (candidate: CandidateRow, nextAttached: boolean): void => {
    if (busyLogins.has(candidate.login) || permission === "denied") return;
    setWriteError(undefined);
    setBusyLogins((current) => new Set(current).add(candidate.login));
    if (nextAttached) {
      setPendingRequests((current) => new Set(current).add(candidate.login));
      setPendingRemovals((current) => withoutMember(current, candidate.login));
    } else {
      setPendingRemovals((current) => new Set(current).add(candidate.login));
      setPendingRequests((current) => withoutMember(current, candidate.login));
    }
    const ref = { id: candidate.id, login: candidate.login };
    const write = nextAttached
      ? actions.requestReviewers([ref])
      : actions.removeReviewers([ref]);
    write
      .catch((cause: unknown) => {
        // The optimistic guess did not hold: revert it.
        if (nextAttached)
          setPendingRequests((current) =>
            withoutMember(current, candidate.login),
          );
        else
          setPendingRemovals((current) =>
            withoutMember(current, candidate.login),
          );
        // Permission state is never inferred from this: it already comes
        // from the read path (`readState.permission`). A rejected write
        // here still gets a specific reason surfaced, but does not change
        // what the picker believes about this account's standing.
        const reason =
          cause instanceof PatchdeskApiError ? ` ${cause.message}` : "";
        setWriteError(
          nextAttached
            ? `Patchdesk could not ask "${candidate.login}" to review.${reason}`
            : `Patchdesk could not remove "${candidate.login}" from the requested reviewers.${reason}`,
        );
      })
      .finally(() => {
        setBusyLogins((current) => withoutMember(current, candidate.login));
      });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
          <p role="alert" className="text-xs text-destructive">
            This account cannot manage reviewers on this repository.
          </p>
        ) : readState._tag === "ready" && permission === "unknown" ? (
          <p className="text-xs text-muted-foreground">
            Patchdesk could not confirm you can manage reviewers here — a change
            may be refused.
          </p>
        ) : null}
        {writeError === undefined ? null : (
          <p role="alert" className="text-xs text-destructive">
            {writeError}
          </p>
        )}
        <FieldGroup>
          <Field>
            <Input
              id="reviewer-search"
              type="search"
              aria-label="Search reviewer candidates"
              placeholder="Search people…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <ReviewerPickerList
            readState={readState}
            attachedLogins={attachedLogins}
            pendingRequests={pendingRequests}
            pendingRemovals={pendingRemovals}
            busyLogins={busyLogins}
            disabled={permission === "denied"}
            onToggle={toggle}
          />
        </FieldGroup>
      </PopoverContent>
    </Popover>
  );
}

function projectReadState(
  response: ReviewerListResponse | undefined,
): ReadState {
  if (response === undefined) return { _tag: "github_read" };
  if (response.state === "ready") {
    const candidates = response.candidates ?? [];
    return {
      _tag: "ready",
      suggested: response.suggested ?? [],
      candidates,
      candidatesTotalCount: response.candidatesTotalCount ?? candidates.length,
      // Fails closed to `"unknown"` (never `"permitted"`) if the field is
      // ever missing — an unconfirmed state, not an authorized one.
      permission: response.permission ?? "unknown",
    };
  }
  if (response.state === "github_rate_limited") {
    const resumeAtField =
      response.resumeAt === undefined ? {} : { resumeAt: response.resumeAt };
    return { _tag: "github_rate_limited", ...resumeAtField };
  }
  if (response.state === "github_forbidden") {
    const reasonField =
      response.forbiddenReason === undefined
        ? {}
        : { reason: response.forbiddenReason };
    return { _tag: "github_forbidden", ...reasonField };
  }
  return { _tag: response.state };
}

/** One toggleable candidate row, reused for both the suggested group and the remaining-candidates list so the checkbox/avatar/caption markup is written once. */
function ReviewerCandidateRow({
  candidate,
  caption,
  attachedLogins,
  pendingRequests,
  pendingRemovals,
  busyLogins,
  disabled,
  onToggle,
}: {
  readonly candidate: CandidateRow;
  readonly caption?: string;
  readonly attachedLogins: ReadonlySet<string>;
  readonly pendingRequests: ReadonlySet<string>;
  readonly pendingRemovals: ReadonlySet<string>;
  readonly busyLogins: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onToggle: (candidate: CandidateRow, nextAttached: boolean) => void;
}): React.JSX.Element {
  const attached =
    pendingRequests.has(candidate.login) ||
    (attachedLogins.has(candidate.login) &&
      !pendingRemovals.has(candidate.login));
  const busy = busyLogins.has(candidate.login);
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
          onCheckedChange={() => onToggle(candidate, !attached)}
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
  attachedLogins,
  pendingRequests,
  pendingRemovals,
  busyLogins,
  disabled,
  onToggle,
}: {
  readonly readState: ReadState;
  readonly attachedLogins: ReadonlySet<string>;
  readonly pendingRequests: ReadonlySet<string>;
  readonly pendingRemovals: ReadonlySet<string>;
  readonly busyLogins: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onToggle: (candidate: CandidateRow, nextAttached: boolean) => void;
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
                    attachedLogins={attachedLogins}
                    pendingRequests={pendingRequests}
                    pendingRemovals={pendingRemovals}
                    busyLogins={busyLogins}
                    disabled={disabled}
                    onToggle={onToggle}
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
                  attachedLogins={attachedLogins}
                  pendingRequests={pendingRequests}
                  pendingRemovals={pendingRemovals}
                  busyLogins={busyLogins}
                  disabled={disabled}
                  onToggle={onToggle}
                />
              ))}
            </ul>
          </FieldGroup>
        )}
        {readState.candidatesTotalCount > readState.candidates.length ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Showing {readState.candidates.length} of{" "}
            {readState.candidatesTotalCount} candidates. Some repository
            collaborators aren&apos;t shown.
          </p>
        ) : null}
      </div>
    </FieldSet>
  );
}
