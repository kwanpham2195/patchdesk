import { useEffect, useMemo, useState } from "react";
import { Settings2 } from "lucide-react";

import type {
  RepositoryLabel,
  RepositoryLabelPermission,
} from "../../../domain/github-context";
import { PatchdeskApiError } from "../api-client";
import {
  forbiddenCopy,
  projectRepositoryLabelReadState,
  rateLimitedCopy,
  type RepositoryLabelReadState,
} from "../github-read-failure-copy";
import { withoutMember } from "../picker-selection";
import type { RepositoryLabelListResponse } from "../renderer-contracts";
import { LabelChip } from "./label-chip";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./ui/field";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover";
import { Spinner } from "./ui/spinner";

export type LabelPickerActions = {
  readonly fetchLabels: () => Promise<RepositoryLabelListResponse | undefined>;
  readonly addLabels: (
    labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  ) => Promise<void>;
  readonly removeLabels: (
    labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  ) => Promise<void>;
};

/**
 * Assigns and removes labels on the pull request under review. Rendered as
 * the Labels section's settings control in `PullRequestMetadataRail`, next
 * to the read-only chips `LabelChip` already draws there — this component
 * reuses `LabelChip` for its own rows rather than drawing a second chip
 * renderer. It has exactly one trigger style (a gear-icon button); the rail
 * is its only mount point now that the workbench header no longer renders a
 * labels row.
 *
 * Mirrors `ConversationThreadCard`'s resolve/unresolve override: toggling a
 * label applies to local state immediately, is dropped once the
 * authoritative `attachedLabels` prop catches up with it (an explicit
 * refresh or reload re-baselines the projection), and a failed write
 * reverts the optimistic guess with a visible error rather than silently
 * reverting.
 *
 * `actions` is `undefined` when the Review can no longer accept label
 * writes (e.g. closed/merged); the picker renders nothing in that case, the
 * same way other write-only workbench actions withhold themselves. Under
 * Terminal, `PullRequestMetadataRail` withholds this component entirely
 * (rather than relying on `actions` being undefined), so every rail section
 * goes read-only the same way regardless of whether its actions happen to be
 * wired.
 */
export function LabelPicker({
  attachedLabels,
  actions,
}: {
  readonly attachedLabels: ReadonlyArray<{
    readonly name: string;
    readonly color: string;
  }>;
  readonly actions?: LabelPickerActions;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [readState, setReadState] = useState<RepositoryLabelReadState>({
    _tag: "loading",
  });
  const permission: RepositoryLabelPermission =
    readState._tag === "ready" ? readState.permission : "unknown";
  const [pendingAdds, setPendingAdds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingRemoves, setPendingRemoves] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [busyNames, setBusyNames] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [writeError, setWriteError] = useState<string>();
  // Tracks the last `attachedLabels` prop identity rendered, so a change to
  // it can be adjusted for during rendering (the pattern React recommends
  // over an effect for "adjusting state when a prop changes":
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [prevAttachedLabels, setPrevAttachedLabels] = useState(attachedLabels);

  const attachedNames = useMemo(
    () => new Set(attachedLabels.map((label) => label.name)),
    [attachedLabels],
  );
  // Drop each optimistic override once the authoritative attached-label set
  // catches up with it, so a stale local guess never outlives real data.
  if (prevAttachedLabels !== attachedLabels) {
    setPrevAttachedLabels(attachedLabels);
    setPendingAdds((current) => {
      const next = new Set(
        [...current].filter((name) => !attachedNames.has(name)),
      );
      return next.size === current.size ? current : next;
    });
    setPendingRemoves((current) => {
      const next = new Set(
        [...current].filter((name) => attachedNames.has(name)),
      );
      return next.size === current.size ? current : next;
    });
  }

  useEffect(() => {
    if (!open || actions === undefined) return;
    let cancelled = false;
    setReadState({ _tag: "loading" });
    actions
      .fetchLabels()
      .then((response) => {
        if (cancelled) return;
        setReadState(projectRepositoryLabelReadState(response));
      })
      .catch(() => {
        if (!cancelled) setReadState({ _tag: "github_read" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, actions]);

  if (actions === undefined) return null;

  const toggle = (label: RepositoryLabel, nextAttached: boolean): void => {
    if (busyNames.has(label.name) || permission === "denied") return;
    setWriteError(undefined);
    setBusyNames((current) => new Set(current).add(label.name));
    if (nextAttached) {
      setPendingAdds((current) => new Set(current).add(label.name));
      setPendingRemoves((current) => withoutMember(current, label.name));
    } else {
      setPendingRemoves((current) => new Set(current).add(label.name));
      setPendingAdds((current) => withoutMember(current, label.name));
    }
    const ref = { id: label.id, name: label.name };
    const write = nextAttached
      ? actions.addLabels([ref])
      : actions.removeLabels([ref]);
    write
      .catch((cause: unknown) => {
        // The optimistic guess did not hold: revert it.
        if (nextAttached)
          setPendingAdds((current) => withoutMember(current, label.name));
        else setPendingRemoves((current) => withoutMember(current, label.name));
        // Permission state is never inferred from this: it already comes
        // from the read path (`readState.permission`), evidenced by
        // `getRepositoryPermission`. A rejected write here still gets a
        // specific reason surfaced — a permitted user can still hit e.g. an
        // IP allow list — but it does not change what the picker believes
        // about this account's standing.
        const reason =
          cause instanceof PatchdeskApiError ? ` ${cause.message}` : "";
        setWriteError(
          nextAttached
            ? `Patchdesk could not add "${label.name}".${reason}`
            : `Patchdesk could not remove "${label.name}".${reason}`,
        );
      })
      .finally(() => {
        setBusyNames((current) => withoutMember(current, label.name));
      });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon-xs" aria-label="Manage labels" />
        }
      >
        <Settings2 />
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverHeader>
          <PopoverTitle>Labels</PopoverTitle>
        </PopoverHeader>
        {readState._tag === "ready" && permission === "denied" ? (
          <p role="alert" className="text-xs text-destructive">
            This account cannot manage labels on this repository.
          </p>
        ) : readState._tag === "ready" && permission === "unknown" ? (
          <p className="text-xs text-muted-foreground">
            Patchdesk could not confirm you can manage labels here — a change
            may be refused.
          </p>
        ) : null}
        {writeError === undefined ? null : (
          <p role="alert" className="text-xs text-destructive">
            {writeError}
          </p>
        )}
        <LabelPickerList
          readState={readState}
          attachedNames={attachedNames}
          pendingAdds={pendingAdds}
          pendingRemoves={pendingRemoves}
          busyNames={busyNames}
          disabled={permission === "denied"}
          onToggle={toggle}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The picker's body: the read state's message, or its list of toggleable repository labels. */
function LabelPickerList({
  readState,
  attachedNames,
  pendingAdds,
  pendingRemoves,
  busyNames,
  disabled,
  onToggle,
}: {
  readonly readState: RepositoryLabelReadState;
  readonly attachedNames: ReadonlySet<string>;
  readonly pendingAdds: ReadonlySet<string>;
  readonly pendingRemoves: ReadonlySet<string>;
  readonly busyNames: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onToggle: (label: RepositoryLabel, nextAttached: boolean) => void;
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
  return (
    <FieldSet data-disabled={disabled || undefined}>
      <FieldLegend variant="label">Repository labels</FieldLegend>
      <FieldGroup className="max-h-64 gap-0.5 overflow-y-auto">
        <ul aria-label="Repository labels">
          {readState.labels.map((label) => {
            const attached =
              pendingAdds.has(label.name) ||
              (attachedNames.has(label.name) &&
                !pendingRemoves.has(label.name));
            const busy = busyNames.has(label.name);
            const controlId = `label-${label.id}`;
            const descriptionId =
              label.description === undefined
                ? undefined
                : `${controlId}-description`;
            return (
              <li key={label.id}>
                <Field
                  orientation="horizontal"
                  data-disabled={disabled || busy || undefined}
                >
                  <Checkbox
                    id={controlId}
                    checked={attached}
                    disabled={disabled || busy}
                    {...(descriptionId === undefined
                      ? {}
                      : { "aria-describedby": descriptionId })}
                    onCheckedChange={() => onToggle(label, !attached)}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={controlId} className="font-normal">
                      <LabelChip
                        label={{ name: label.name, color: label.color }}
                      />
                    </FieldLabel>
                    {label.description === undefined ? null : (
                      <span
                        id={descriptionId}
                        data-slot="label-description"
                        className="mt-0.5 truncate text-[10px] text-muted-foreground"
                      >
                        {label.description}
                      </span>
                    )}
                  </FieldContent>
                </Field>
              </li>
            );
          })}
        </ul>
      </FieldGroup>
      {readState.totalCount > readState.labels.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Showing {readState.labels.length} of {readState.totalCount} labels.
          Some repository labels aren&apos;t shown.
        </p>
      ) : null}
    </FieldSet>
  );
}
