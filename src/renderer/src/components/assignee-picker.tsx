import { useMemo } from "react";
import { Settings2 } from "lucide-react";

import { forbiddenCopy, rateLimitedCopy } from "../github-read-failure-copy";
import type { GithubListReadState } from "../github-read-failure-copy";
import {
  useGithubItemPicker,
  type GithubItemPicker,
  type GithubItemPickerActions,
} from "../hooks/use-github-item-picker";
import type { AssignableUserListResponse } from "../renderer-contracts";
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

/** What this picker's `state: "ready"` read carries, on top of the shared permission. */
type AssigneeReady = {
  readonly users: ReadonlyArray<AssignableUser>;
  readonly totalCount: number;
};
type ReadState = GithubListReadState<AssigneeReady>;

// Module scope, so the hook's fetch effect keeps one stable identity to
// depend on rather than refetching on every render.
const projectReady = (response: AssignableUserListResponse): AssigneeReady => {
  const users = response.users ?? [];
  return { users, totalCount: response.totalCount ?? users.length };
};
const keyOf = (user: AssignableUser): string => user.login;
const describeWriteFailure = (
  user: AssignableUser,
  nextAttached: boolean,
): string =>
  nextAttached
    ? `Patchdesk could not assign "${user.login}".`
    : `Patchdesk could not unassign "${user.login}".`;

/**
 * Assigns and removes people on the pull request under review. Rendered as
 * the Assignees section's settings control in `PullRequestMetadataRail`,
 * mirroring `LabelPicker`'s structure (gear-icon trigger, three-state
 * permission notice, optimistic toggle with revert-on-failure). All of that
 * state lives in `useGithubItemPicker`; what stays here is this picker's own
 * surface: the ten-assignee cap stated up front, the server-side search box
 * (`query` travels to `actions.fetchAssignableUsers` instead of filtering one
 * fetched page locally), and the avatar-and-login row.
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
  const pickerActions = useMemo(
    ():
      | GithubItemPickerActions<AssignableUser, AssignableUserListResponse>
      | undefined =>
      actions === undefined
        ? undefined
        : {
            fetchList: (query) => actions.fetchAssignableUsers(query),
            add: (user) =>
              actions.addAssignees([{ id: user.id, login: user.login }]),
            remove: (user) =>
              actions.removeAssignees([{ id: user.id, login: user.login }]),
          },
    [actions],
  );
  const picker = useGithubItemPicker({
    attached: attachedAssignees,
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
        <p data-slot="picker-cap" className="text-xs text-muted-foreground">
          GitHub allows up to {MAX_ASSIGNEES} assignees on a pull request.
        </p>
        {readState._tag === "ready" && permission === "denied" ? (
          <p
            role="alert"
            data-slot="picker-permission-denied"
            className="text-xs text-destructive"
          >
            This account cannot manage assignees on this repository.
          </p>
        ) : readState._tag === "ready" && permission === "unknown" ? (
          <p
            data-slot="picker-permission-caveat"
            className="text-xs text-muted-foreground"
          >
            Patchdesk could not confirm you can manage assignees here — a change
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
              id="assignee-search"
              type="search"
              aria-label="Search assignable people"
              placeholder="Search people…"
              value={picker.query}
              onChange={(event) => picker.setQuery(event.target.value)}
            />
          </Field>
          <AssigneePickerList
            readState={readState}
            picker={picker}
            disabled={permission === "denied"}
          />
        </FieldGroup>
      </PopoverContent>
    </Popover>
  );
}

/** The picker's body: the read state's message, or its list of toggleable assignable people. */
function AssigneePickerList({
  readState,
  picker,
  disabled,
}: {
  readonly readState: ReadState;
  readonly picker: GithubItemPicker<AssignableUser, AssigneeReady>;
  readonly disabled: boolean;
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
    <FieldSet data-disabled={disabled || undefined}>
      <FieldLegend variant="label">Assignable people</FieldLegend>
      <FieldGroup className="max-h-64 gap-0.5 overflow-y-auto">
        <ul aria-label="Assignable people">
          {readState.users.map((user) => {
            const attached = picker.isAttached(user);
            const busy = picker.isBusy(user);
            const controlId = `assignee-${user.id}`;
            return (
              <li key={user.id}>
                <Field
                  orientation="horizontal"
                  data-disabled={disabled || busy || undefined}
                >
                  <Checkbox
                    id={controlId}
                    checked={attached}
                    disabled={disabled || busy}
                    onCheckedChange={() => picker.toggle(user, !attached)}
                  />
                  <FieldLabel htmlFor={controlId} className="font-normal">
                    <Avatar
                      name={user.login}
                      dataUri={user.avatarDataUri}
                      className="size-5 text-[10px]"
                    />
                    {user.login}
                  </FieldLabel>
                </Field>
              </li>
            );
          })}
        </ul>
      </FieldGroup>
      {readState.totalCount > readState.users.length ? (
        <p
          data-slot="picker-truncation"
          className="mt-1 text-xs text-muted-foreground"
        >
          Showing {readState.users.length} of {readState.totalCount} people.
          Some assignable people aren&apos;t shown.
        </p>
      ) : null}
    </FieldSet>
  );
}
