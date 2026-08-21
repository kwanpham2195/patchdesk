import { useEffect, useMemo, useRef, useState } from "react";
import { Settings2 } from "lucide-react";

import type { PullRequestAssigneePermission } from "../../../domain/github-context";
import { PatchdeskApiError } from "../api-client";
import { forbiddenCopy, rateLimitedCopy } from "../github-read-failure-copy";
import type { AssignableUserListResponse } from "../renderer-contracts";
import { Avatar } from "./ui/avatar";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover";
import { Spinner } from "./ui/spinner";

/** How long the search box waits after the last keystroke before it re-queries the server-side filter — long enough to absorb normal typing cadence, short enough to still feel live. */
const SEARCH_DEBOUNCE_MS = 200;

/** GitHub's per-pull-request assignee limit (enforced server-side by `AssigneeService`, `src/services/assignee-service.ts`); stated here so a maintainer understands why an add can be refused before they hit it. */
const MAX_ASSIGNEES = 10;

/** One candidate row's shape, taken from the parsed wire response rather
 * than the domain `AssignableUser` type: under `exactOptionalPropertyTypes`
 * the two are not assignable to each other (the wire schema's optional
 * fields are `T | undefined`; the domain type's are plain `T`), and this
 * component only ever renders what the response actually carries. */
type AssignableUser = NonNullable<AssignableUserListResponse["users"]>[number];

export type AssigneePickerActions = {
  readonly fetchAssignableUsers: (
    query?: string,
  ) => Promise<AssignableUserListResponse | undefined>;
  readonly addAssignees: (
    assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>,
  ) => Promise<void>;
  readonly removeAssignees: (
    assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>,
  ) => Promise<void>;
};

/**
 * `AssigneePickerActions` plus the Assignees section's empty-state self-assign
 * shortcut. Kept in one type because the rail wires both from the same flow
 * (`review-workbench-flow.tsx`) and both resolve through the same
 * `/v1/reviews/assignees` surface; `AssigneePicker` itself only ever consumes
 * the narrower `AssigneePickerActions` half.
 */
export type AssigneesSectionActions = AssigneePickerActions & {
  /** Assigns the authenticated account, resolved server-side (never from anything the renderer believes about who is signed in). Resolves to the logins the server actually added. */
  readonly assignSelf: () => Promise<ReadonlyArray<string>>;
};

type ReadState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "github_read" }
  | { readonly _tag: "github_auth" }
  | {
      readonly _tag: "ready";
      readonly users: ReadonlyArray<AssignableUser>;
      readonly totalCount: number;
      /**
       * The service's real, GitHub-evidenced answer for whether this
       * account can write assignees here (`AssigneeListOutcome.ready
       * .permission` in `src/services/assignee-service.ts`). Never inferred
       * client-side — `"unknown"` means evidence was genuinely unavailable,
       * not that a write hasn't been tried yet.
       */
      readonly permission: PullRequestAssigneePermission;
    }
  | { readonly _tag: "github_rate_limited"; readonly resumeAt?: string }
  | {
      readonly _tag: "github_forbidden";
      readonly reason?:
        | "ip_allow_list"
        | "saml"
        | "insufficient_scopes"
        | "unknown";
    };

function withoutLogin<T extends string>(
  set: ReadonlySet<T>,
  login: T,
): ReadonlySet<T> {
  if (!set.has(login)) return set;
  const next = new Set(set);
  next.delete(login);
  return next;
}

/**
 * Assigns and removes people on the pull request under review. Rendered as
 * the Assignees section's settings control in `PullRequestMetadataRail`,
 * mirroring `LabelPicker`'s structure (gear-icon trigger, three-state
 * permission notice, optimistic toggle with revert-on-failure). The one
 * addition over `LabelPicker` is server-side search: `query` travels to
 * `actions.fetchAssignableUsers` instead of filtering one fetched page
 * locally, debounced so normal typing doesn't issue a request per keystroke,
 * and every response is tagged with a request id so a slow, stale response
 * can never overwrite a newer one.
 *
 * `actions` is `undefined` when the Review can no longer accept assignee
 * writes; the picker renders nothing in that case, the same way `LabelPicker`
 * does. Under Terminal, `PullRequestMetadataRail` withholds this component
 * entirely rather than relying on that fallback.
 */
export function AssigneePicker({
  attachedAssignees,
  actions,
}: {
  readonly attachedAssignees: ReadonlyArray<string>;
  readonly actions?: AssigneePickerActions;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [readState, setReadState] = useState<ReadState>({ _tag: "loading" });
  const permission: PullRequestAssigneePermission =
    readState._tag === "ready" ? readState.permission : "unknown";
  const [pendingAdds, setPendingAdds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingRemoves, setPendingRemoves] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [busyLogins, setBusyLogins] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [writeError, setWriteError] = useState<string>();
  // Tracks the last `attachedAssignees` prop identity rendered, so a change
  // to it can be adjusted for during rendering (mirrors `LabelPicker`'s use
  // of https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [prevAttachedAssignees, setPrevAttachedAssignees] =
    useState(attachedAssignees);

  const attachedLogins = useMemo(
    () => new Set(attachedAssignees),
    [attachedAssignees],
  );
  if (prevAttachedAssignees !== attachedAssignees) {
    setPrevAttachedAssignees(attachedAssignees);
    setPendingAdds((current) => {
      const next = new Set(
        [...current].filter((login) => !attachedLogins.has(login)),
      );
      return next.size === current.size ? current : next;
    });
    setPendingRemoves((current) => {
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
      .fetchAssignableUsers(debouncedQuery === "" ? undefined : debouncedQuery)
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

  const toggle = (user: AssignableUser, nextAttached: boolean): void => {
    if (busyLogins.has(user.login) || permission === "denied") return;
    setWriteError(undefined);
    setBusyLogins((current) => new Set(current).add(user.login));
    if (nextAttached) {
      setPendingAdds((current) => new Set(current).add(user.login));
      setPendingRemoves((current) => withoutLogin(current, user.login));
    } else {
      setPendingRemoves((current) => new Set(current).add(user.login));
      setPendingAdds((current) => withoutLogin(current, user.login));
    }
    const ref = { id: user.id, login: user.login };
    const write = nextAttached
      ? actions.addAssignees([ref])
      : actions.removeAssignees([ref]);
    write
      .catch((cause: unknown) => {
        // The optimistic guess did not hold: revert it.
        if (nextAttached)
          setPendingAdds((current) => withoutLogin(current, user.login));
        else setPendingRemoves((current) => withoutLogin(current, user.login));
        // Permission state is never inferred from this: it already comes
        // from the read path (`readState.permission`). A rejected write
        // here still gets a specific reason surfaced (the ten-assignee cap,
        // an IP allow list, ...) but does not change what the picker
        // believes about this account's standing.
        const reason =
          cause instanceof PatchdeskApiError ? ` ${cause.message}` : "";
        setWriteError(
          nextAttached
            ? `Patchdesk could not assign "${user.login}".${reason}`
            : `Patchdesk could not unassign "${user.login}".${reason}`,
        );
      })
      .finally(() => {
        setBusyLogins((current) => withoutLogin(current, user.login));
      });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Manage assignees"
          />
        }
      >
        <Settings2 />
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverHeader>
          <PopoverTitle>Assignees</PopoverTitle>
        </PopoverHeader>
        <p className="text-xs text-muted-foreground">
          GitHub allows up to {MAX_ASSIGNEES} assignees on a pull request.
        </p>
        {readState._tag === "ready" && permission === "denied" ? (
          <p role="alert" className="text-xs text-destructive">
            This account cannot manage assignees on this repository.
          </p>
        ) : readState._tag === "ready" && permission === "unknown" ? (
          <p className="text-xs text-muted-foreground">
            Patchdesk could not confirm you can manage assignees here — a change
            may be refused.
          </p>
        ) : null}
        {writeError === undefined ? null : (
          <p role="alert" className="text-xs text-destructive">
            {writeError}
          </p>
        )}
        <Input
          type="search"
          placeholder="Search people…"
          aria-label="Search assignable people"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <AssigneePickerList
          readState={readState}
          attachedLogins={attachedLogins}
          pendingAdds={pendingAdds}
          pendingRemoves={pendingRemoves}
          busyLogins={busyLogins}
          disabled={permission === "denied"}
          onToggle={toggle}
        />
      </PopoverContent>
    </Popover>
  );
}

function projectReadState(
  response: AssignableUserListResponse | undefined,
): ReadState {
  if (response === undefined) return { _tag: "github_read" };
  if (response.state === "ready") {
    const users = response.users ?? [];
    return {
      _tag: "ready",
      users,
      totalCount: response.totalCount ?? users.length,
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

/** The picker's body: the read state's message, or its list of toggleable assignable people. */
function AssigneePickerList({
  readState,
  attachedLogins,
  pendingAdds,
  pendingRemoves,
  busyLogins,
  disabled,
  onToggle,
}: {
  readonly readState: ReadState;
  readonly attachedLogins: ReadonlySet<string>;
  readonly pendingAdds: ReadonlySet<string>;
  readonly pendingRemoves: ReadonlySet<string>;
  readonly busyLogins: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onToggle: (user: AssignableUser, nextAttached: boolean) => void;
}): React.JSX.Element {
  if (readState._tag === "loading")
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Loading assignable people…
      </p>
    );
  if (readState._tag === "github_auth")
    return (
      <p role="alert" className="text-xs text-destructive">
        GitHub authentication is required before Patchdesk can list this
        repository&apos;s assignable people.
      </p>
    );
  if (readState._tag === "github_read")
    return (
      <p role="alert" className="text-xs text-destructive">
        Patchdesk could not load this repository&apos;s assignable people.
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
  if (readState.users.length === 0)
    return <p className="text-xs text-muted-foreground">No matching people.</p>;
  return (
    <div className="max-h-64 overflow-y-auto">
      <ul className="flex flex-col gap-0.5" aria-label="Assignable people">
        {readState.users.map((user) => {
          const attached =
            pendingAdds.has(user.login) ||
            (attachedLogins.has(user.login) && !pendingRemoves.has(user.login));
          const busy = busyLogins.has(user.login);
          return (
            <li key={user.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/50">
                <Checkbox
                  checked={attached}
                  disabled={disabled || busy}
                  onCheckedChange={() => onToggle(user, !attached)}
                />
                <Avatar name={user.login} className="size-5 text-[10px]" />
                {user.login}
              </label>
            </li>
          );
        })}
      </ul>
      {readState.totalCount > readState.users.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Showing {readState.users.length} of {readState.totalCount} people.
          Some assignable people aren&apos;t shown.
        </p>
      ) : null}
    </div>
  );
}
