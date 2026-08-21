import { useEffect, useState } from "react";

import type {
  GitHubLabel,
  PullRequestAssigneePermission,
} from "../../../domain/github-context";
import { PatchdeskApiError } from "../api-client";
import { freshnessCopy, type RevisionFreshness } from "../rail-freshness";
import {
  AssigneePicker,
  type AssigneePickerActions,
  type AssigneesSectionActions,
} from "./assignee-picker";
import { LabelChip } from "./label-chip";
import { LabelPicker, type LabelPickerActions } from "./label-picker";
import { Avatar } from "./ui/avatar";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

/**
 * One topic section inside `PullRequestMetadataRail` (Labels today;
 * Assignees and Reviewers in later slices). Exported so those later slices
 * only need to add another `<RailSection>` rather than rebuild the header
 * row, freshness line, and settings-control slot.
 */
export function RailSection({
  title,
  freshness,
  settings,
  children,
}: {
  readonly title: string;
  readonly freshness: RevisionFreshness;
  readonly settings?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-label={title}
      className="border-b py-3 first:pt-0 last:border-b-0"
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {title}
          </h2>
          <p className="text-[10px] text-muted-foreground">
            {freshnessCopy(freshness)}
          </p>
        </div>
        {settings}
      </div>
      {children}
    </section>
  );
}

/** Mutable form of `RailSection`'s header props, so `AssigneesSection` can
 * assign `settings` only when present instead of a conditional
 * empty-object spread (mirrors `MutableGeneralThreadOverrides` in
 * `conversation.tsx`). */
type MutableRailSectionHeaderProps = {
  title: string;
  freshness: RevisionFreshness;
  settings?: React.ReactNode;
};

/** Mutable form of `AssigneePicker`'s props, for the same reason. */
type MutableAssigneePickerProps = {
  attachedAssignees: ReadonlyArray<string>;
  actions?: AssigneePickerActions;
};

/** Mutable form of `AssigneesSection`'s props, for the same reason. */
type MutableAssigneesSectionProps = {
  assignees: ReadonlyArray<string>;
  freshness: RevisionFreshness;
  refreshedAt: string;
  terminal: boolean;
  actions?: AssigneesSectionActions;
};

/**
 * The Assignees section: the pull request's current assignees (as an
 * initials-badge list) or, when nobody is assigned, a plain empty state plus
 * a one-click self-assign shortcut. Unlike `LabelPicker` (which fetches only
 * once its own popover opens), this section fetches the real
 * GitHub-evidenced assign permission itself, once on mount and again
 * whenever the workbench re-baselines (`refreshedAt` changes) — the
 * self-assign shortcut's visibility depends on that permission before the
 * picker is ever opened, and detection must never poll on its own.
 */
function AssigneesSection({
  assignees,
  freshness,
  refreshedAt,
  terminal,
  actions,
}: {
  readonly assignees: ReadonlyArray<string>;
  readonly freshness: RevisionFreshness;
  readonly refreshedAt: string;
  readonly terminal: boolean;
  readonly actions?: AssigneesSectionActions;
}): React.JSX.Element {
  const [permission, setPermission] =
    useState<PullRequestAssigneePermission>("unknown");

  useEffect(() => {
    if (actions === undefined) {
      setPermission("unknown");
      return;
    }
    let cancelled = false;
    actions
      .fetchAssignableUsers()
      .then((response) => {
        if (cancelled) return;
        setPermission(
          response?.state === "ready"
            ? (response.permission ?? "unknown")
            : "unknown",
        );
      })
      .catch(() => {
        if (!cancelled) setPermission("unknown");
      });
    return () => {
      cancelled = true;
    };
    // `refreshedAt` re-triggers the fetch on every workbench re-baseline;
    // it is intentionally in the dependency list purely as a re-fetch key.
  }, [actions, refreshedAt]);

  const [selfAssignPending, setSelfAssignPending] = useState<
    ReadonlyArray<string>
  >([]);
  const [selfAssignBusy, setSelfAssignBusy] = useState(false);
  const [selfAssignError, setSelfAssignError] = useState<string>();
  // Drops each optimistically self-assigned login once the authoritative
  // `assignees` prop catches up with it, mirroring `LabelPicker`'s
  // adjust-state-during-render reconciliation.
  const [prevAssignees, setPrevAssignees] = useState(assignees);
  if (prevAssignees !== assignees) {
    setPrevAssignees(assignees);
    if (selfAssignPending.length > 0) {
      const assigneeSet = new Set(assignees);
      const next = selfAssignPending.filter((login) => !assigneeSet.has(login));
      if (next.length !== selfAssignPending.length) setSelfAssignPending(next);
    }
  }
  const visibleAssignees =
    selfAssignPending.length === 0
      ? assignees
      : [...assignees, ...selfAssignPending];

  const onSelfAssign = (): void => {
    if (actions === undefined || selfAssignBusy) return;
    setSelfAssignError(undefined);
    setSelfAssignBusy(true);
    actions
      .assignSelf()
      .then((added) => {
        setSelfAssignPending((current) => {
          const alreadyPending = new Set(current);
          return [
            ...current,
            ...added.filter((login) => !alreadyPending.has(login)),
          ];
        });
      })
      .catch((cause: unknown) => {
        const reason =
          cause instanceof PatchdeskApiError ? ` ${cause.message}` : "";
        setSelfAssignError(
          `Patchdesk could not assign you to this pull request.${reason}`,
        );
      })
      .finally(() => setSelfAssignBusy(false));
  };

  const pickerProps: MutableAssigneePickerProps = {
    attachedAssignees: visibleAssignees,
  };
  if (actions !== undefined) pickerProps.actions = actions;

  const headerProps: MutableRailSectionHeaderProps = {
    title: "Assignees",
    freshness,
  };
  if (!terminal) headerProps.settings = <AssigneePicker {...pickerProps} />;

  return (
    <RailSection {...headerProps}>
      {visibleAssignees.length === 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">Nobody is assigned.</p>
          {!terminal && permission !== "denied" ? (
            <div className="flex flex-col gap-1">
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={selfAssignBusy || actions === undefined}
                onClick={onSelfAssign}
              >
                {selfAssignBusy ? <Spinner className="size-3" /> : null}
                Assign yourself
              </Button>
              {permission === "unknown" ? (
                <p className="text-xs text-muted-foreground">
                  Patchdesk could not confirm you can manage assignees here — a
                  change may be refused.
                </p>
              ) : null}
              {selfAssignError === undefined ? null : (
                <p role="alert" className="text-xs text-destructive">
                  {selfAssignError}
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <ul
          className="flex flex-col gap-1.5"
          aria-label="Pull request assignees"
        >
          {visibleAssignees.map((login) => (
            <li key={login} className="flex items-center gap-2">
              <Avatar name={login} className="size-5 text-[10px]" />
              <span className="truncate text-xs">{login}</span>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}

/**
 * The sticky right-hand rail on the Conversation tab, holding one
 * `RailSection` per pull-request metadata topic. `ReviewWorkbench` builds
 * this element (it holds the model) and passes it to `Conversation` as a
 * plain `rail` prop, which keeps the rail off the Diff and Insights tabs by
 * construction — `Conversation` only ever renders what it's given.
 *
 * Under `terminal` (the Review is no longer open), every section renders
 * read-only: `settings` is withheld entirely rather than left to
 * `LabelPicker`'s own "no actions wired" fallback, so a later section that
 * always has actions wired still goes read-only under Terminal.
 */
export function PullRequestMetadataRail({
  labels,
  assignees,
  freshness,
  refreshedAt,
  terminal,
  labelActions,
  assigneeActions,
}: {
  readonly labels: ReadonlyArray<GitHubLabel>;
  readonly assignees: ReadonlyArray<string>;
  readonly freshness: RevisionFreshness;
  readonly refreshedAt: string;
  readonly terminal: boolean;
  readonly labelActions?: LabelPickerActions;
  readonly assigneeActions?: AssigneesSectionActions;
}): React.JSX.Element {
  const assigneesSectionProps: MutableAssigneesSectionProps = {
    assignees,
    freshness,
    refreshedAt,
    terminal,
  };
  if (assigneeActions !== undefined)
    assigneesSectionProps.actions = assigneeActions;
  return (
    <aside
      aria-label="Pull request metadata"
      className="w-full min-[1100px]:sticky min-[1100px]:top-0 min-[1100px]:w-[272px] min-[1100px]:shrink-0"
    >
      <AssigneesSection {...assigneesSectionProps} />
      <RailSection
        title="Labels"
        freshness={freshness}
        {...(terminal
          ? {}
          : {
              settings: (
                <LabelPicker
                  attachedLabels={labels}
                  {...(labelActions === undefined
                    ? {}
                    : { actions: labelActions })}
                />
              ),
            })}
      >
        {labels.length === 0 ? (
          <p className="text-xs text-muted-foreground">No labels.</p>
        ) : (
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Pull request labels"
          >
            {labels.map((label) => (
              <LabelChip key={label.name} label={label} />
            ))}
          </div>
        )}
      </RailSection>
    </aside>
  );
}
