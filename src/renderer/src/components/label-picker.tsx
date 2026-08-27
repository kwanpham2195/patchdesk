import { useMemo } from "react";
import { Settings2 } from "lucide-react";

import type { RepositoryLabel } from "../../../domain/github-context";
import {
  forbiddenCopy,
  rateLimitedCopy,
  type RepositoryLabelReadState,
} from "../github-read-failure-copy";
import {
  useGithubItemPicker,
  type GithubItemPicker,
  type GithubItemPickerActions,
} from "../hooks/use-github-item-picker";
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

/** What this picker's `state: "ready"` read carries, on top of the shared permission. */
type LabelReady = {
  readonly labels: ReadonlyArray<RepositoryLabel>;
  readonly totalCount: number;
};

// Module scope, so the hook's fetch effect keeps one stable identity to
// depend on rather than refetching on every render.
const projectReady = (response: RepositoryLabelListResponse): LabelReady => {
  const labels = response.labels ?? [];
  return { labels, totalCount: response.totalCount ?? labels.length };
};
const keyOf = (label: RepositoryLabel): string => label.name;
const describeWriteFailure = (
  label: RepositoryLabel,
  nextAttached: boolean,
): string =>
  nextAttached
    ? `Patchdesk could not add "${label.name}".`
    : `Patchdesk could not remove "${label.name}".`;

/**
 * Assigns and removes labels on the pull request under review. Rendered as
 * the Labels section's settings control in `PullRequestMetadataRail`, next
 * to the read-only chips `LabelChip` already draws there — this component
 * reuses `LabelChip` for its own rows rather than drawing a second chip
 * renderer. It has exactly one trigger style (a gear-icon button); the rail
 * is its only mount point now that the workbench header no longer renders a
 * labels row.
 *
 * The optimistic-toggle state machine is `useGithubItemPicker`'s, shared with
 * `AssigneePicker` and `ReviewerPicker`: toggling a label applies to local
 * state immediately, is dropped once the authoritative `attachedLabels` prop
 * catches up with it (an explicit refresh or reload re-baselines the
 * projection), and a failed write reverts the optimistic guess with a visible
 * error rather than silently reverting. Unlike the two people pickers this
 * one has no search box — GitHub's label list is small enough to fetch whole,
 * so `fetchLabels` takes no query and the hook's query stays empty.
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
  const attachedNames = useMemo(
    () => attachedLabels.map((label) => label.name),
    [attachedLabels],
  );
  const pickerActions = useMemo(
    ():
      | GithubItemPickerActions<RepositoryLabel, RepositoryLabelListResponse>
      | undefined =>
      actions === undefined
        ? undefined
        : {
            fetchList: () => actions.fetchLabels(),
            add: (label) =>
              actions.addLabels([{ id: label.id, name: label.name }]),
            remove: (label) =>
              actions.removeLabels([{ id: label.id, name: label.name }]),
          },
    [actions],
  );
  const picker = useGithubItemPicker({
    attached: attachedNames,
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
          <p
            role="alert"
            data-slot="picker-permission-denied"
            className="text-xs text-destructive"
          >
            This account cannot manage labels on this repository.
          </p>
        ) : readState._tag === "ready" && permission === "unknown" ? (
          <p
            data-slot="picker-permission-caveat"
            className="text-xs text-muted-foreground"
          >
            Patchdesk could not confirm you can manage labels here — a change
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
        <LabelPickerList
          readState={readState}
          picker={picker}
          disabled={permission === "denied"}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The picker's body: the read state's message, or its list of toggleable repository labels. */
function LabelPickerList({
  readState,
  picker,
  disabled,
}: {
  readonly readState: RepositoryLabelReadState;
  readonly picker: GithubItemPicker<RepositoryLabel, LabelReady>;
  readonly disabled: boolean;
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
            const attached = picker.isAttached(label);
            const busy = picker.isBusy(label);
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
                    onCheckedChange={() => picker.toggle(label, !attached)}
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
        <p
          data-slot="picker-truncation"
          className="mt-1 text-xs text-muted-foreground"
        >
          Showing {readState.labels.length} of {readState.totalCount} labels.
          Some repository labels aren&apos;t shown.
        </p>
      ) : null}
    </FieldSet>
  );
}
